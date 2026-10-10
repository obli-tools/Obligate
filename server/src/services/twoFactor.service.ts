import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';
import { db } from '../db';
import { sessionService } from './session.service';

const APP_NAME = 'Obligate';
const PERIOD_S = 30;

/**
 * Tolerance of the historical verifications (Obligate sign-in, TOTP enable /
 * disable, non-consuming app step-up): ±2 steps (±60 s), unchanged.
 */
export const TOTP_WINDOW_DEFAULT = 2;
/**
 * Tolerance of a CONSUMING app step-up (POST /api/oauth/verify-totp with
 * consume:true, TOTP replay guard): ±1 step (±30 s).
 */
export const TOTP_WINDOW_STRICT = 1;

function totpFor(secret: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: APP_NAME,
    algorithm: 'SHA1',
    digits: 6,
    period: PERIOD_S,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
}

/**
 * Outcome of a TOTP check against a user's STORED secret (checkUserTotp).
 * - valid          : code matches; its step was recorded (and consumed when asked)
 * - replayed       : code matches but its step is not newer than the last
 *                    accepted one (consuming checks only)
 * - invalid        : wrong code (or the secret changed during the check)
 * - not_found / inactive / not_configured : nothing was checked
 */
export type TotpCheckResult =
  | { status: 'valid'; step: number; mfaEpoch: number }
  | { status: 'replayed'; step: number; mfaEpoch: number }
  | { status: 'invalid'; step: null; mfaEpoch: number }
  | { status: 'not_found'; step: null; mfaEpoch: null }
  | { status: 'inactive' | 'not_configured'; step: null; mfaEpoch: number };

interface TotpUserRow {
  is_active: boolean;
  totp_enabled: boolean;
  totp_secret: string | null;
  totp_last_step: number | null;
  mfa_epoch: number;
}

export const twoFactorService = {
  generateTotpSecret(username: string): { secret: string; uri: string } {
    const totp = new OTPAuth.TOTP({
      issuer: APP_NAME,
      label: username,
      algorithm: 'SHA1',
      digits: 6,
      period: PERIOD_S,
      secret: new OTPAuth.Secret({ size: 20 }),
    });
    return { secret: totp.secret.base32, uri: totp.toString() };
  },

  /**
   * Time step (floor(unix s / 30)) the code belongs to, or null when it does
   * not match within ±window steps (or is not 6 digits). One timestamp for the
   * match and the counter, so a step boundary between the two cannot skew it.
   * Stateless: only for a secret not stored yet (enable). A check of a STORED
   * secret must go through checkUserTotp, which records the step (TOTP replay guard).
   */
  matchStep(secret: string, code: string, window: number = TOTP_WINDOW_DEFAULT): number | null {
    const token = String(code ?? '').trim();
    if (!/^\d{6}$/.test(token)) return null;
    let totp: OTPAuth.TOTP;
    try { totp = totpFor(secret); } catch { return null; }
    const timestamp = Date.now();
    const delta = totp.validate({ token, timestamp, window });
    if (delta === null) return null;
    return totp.counter({ timestamp }) + delta;
  },

  /**
   * Check a code against the user's stored secret and record its step
   * (TOTP replay guard). EVERY verification of a stored secret goes through here,
   * so users.totp_last_step always holds the newest step ever accepted.
   *
   * consume:false  accepted whenever the code matches; totp_last_step is raised
   *                to max(last, step). The same code stays usable within its
   *                window (historical behaviour of the non-consuming app check).
   * consume:true   accepted only if step > totp_last_step, which is then set to
   *                step — atomically (one conditional UPDATE), so two concurrent
   *                uses of the same code cannot both pass.
   *
   * Both updates are conditioned on the secret read for the match still being
   * the stored one: a code of a secret replaced mid-check never passes.
   */
  async checkUserTotp(
    userId: number,
    code: string,
    opts: { consume: boolean; window: number },
  ): Promise<TotpCheckResult> {
    const row = await db('users').where({ id: userId })
      .first('is_active', 'totp_enabled', 'totp_secret', 'totp_last_step', 'mfa_epoch') as TotpUserRow | undefined;
    if (!row) return { status: 'not_found', step: null, mfaEpoch: null };
    if (!row.is_active) return { status: 'inactive', step: null, mfaEpoch: row.mfa_epoch };
    if (!row.totp_enabled || !row.totp_secret) return { status: 'not_configured', step: null, mfaEpoch: row.mfa_epoch };

    const step = this.matchStep(row.totp_secret, code, opts.window);
    if (step === null) return { status: 'invalid', step: null, mfaEpoch: row.mfa_epoch };

    const base = db('users').where({ id: userId, is_active: true, totp_enabled: true, totp_secret: row.totp_secret });
    const updated = opts.consume
      ? await base
        .andWhere((q) => { q.whereNull('totp_last_step').orWhere('totp_last_step', '<', step); })
        .update({ totp_last_step: step })
        .returning(['mfa_epoch']) as Array<{ mfa_epoch: number }>
      : await base
        .update({ totp_last_step: db.raw('GREATEST(COALESCE(totp_last_step, -1), ?::int)', [step]) })
        .returning(['mfa_epoch']) as Array<{ mfa_epoch: number }>;
    if (updated.length > 0) return { status: 'valid', step, mfaEpoch: updated[0].mfa_epoch };

    // Nothing updated: the step was already used (consume), or the secret /
    // activation changed between the read and the update.
    const again = await db('users').where({ id: userId })
      .first('is_active', 'totp_enabled', 'totp_secret', 'totp_last_step', 'mfa_epoch') as TotpUserRow | undefined;
    if (!again) return { status: 'not_found', step: null, mfaEpoch: null };
    if (opts.consume && again.is_active && again.totp_enabled && again.totp_secret === row.totp_secret
        && again.totp_last_step !== null && again.totp_last_step >= step) {
      return { status: 'replayed', step, mfaEpoch: again.mfa_epoch };
    }
    return { status: 'invalid', step: null, mfaEpoch: again.mfa_epoch };
  },

  async generateTotpQr(uri: string): Promise<string> {
    return QRCode.toDataURL(uri);
  },

  /**
   * Admin action: wipe a user's TOTP secret and flag the account so a fresh
   * setup is required at the next login (even when force_2fa is globally off).
   * Active sessions are dropped so the flag takes effect immediately.
   * mfa_epoch is bumped explicitly (MFA epoch): the reset must invalidate
   * the apps' phone keys even for a user who had no TOTP (nothing else moves).
   */
  async resetForUser(userId: number): Promise<boolean> {
    const updated = await db('users').where({ id: userId }).update({
      totp_secret: null,
      totp_enabled: false,
      require_2fa_setup: true,
      mfa_epoch: db.raw('mfa_epoch + 1'),
      updated_at: new Date(),
    });
    if (!updated) return false;

    // Signed-in and half-way (TOTP step pending) sessions alike. Best effort:
    // the epoch moved, so the per-request session check ends them anyway.
    await sessionService.dropUserSessions(userId);
    return true;
  },
};
