import { Router } from 'express';
import { db } from '../db';
import { twoFactorService, TOTP_WINDOW_DEFAULT } from '../services/twoFactor.service';
import { ssoSyncQueue } from '../services/ssoSyncQueue.service';
import rateLimit from 'express-rate-limit';
import { requireSession } from '../middleware/auth';
import { logger } from '../utils/logger';
import { FailureThrottle } from '../utils/failureThrottle';
import { sessionService, saveSession, satisfyTicket } from '../services/session.service';
import { signInTotpThrottle, signInTotpDailyThrottle, totpUserThrottle } from '../services/totpThrottle.service';

// Extend session for 2FA state
declare module 'express-session' {
  interface SessionData {
    pendingTotpSecret?: string;
  }
}

export const twoFactorRoutes = Router();

// Wrong codes on DELETE /totp (a signed-in session proving the current
// authenticator): 5 in 5 min → 15 min lock, per user.
const disableThrottle = new FailureThrottle({ maxFails: 5, windowMs: 5 * 60 * 1000, lockMs: 15 * 60 * 1000 });

/** The typed code (a string, or a number from older clients), else null. */
function codeFrom(v: unknown): string | null {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v);
  if (typeof v === 'string' && v && v.length <= 32) return v;
  return null;
}

const CODE_USED_ERROR = 'This code has already been used — wait for the next one';
const TOTP_ALREADY_ENABLED_ERROR = 'Two-factor authentication is already enabled — disable it first';

// ── Profile endpoints (require auth) ─────────────────────────────────────────

/** GET /api/profile/2fa/status */
twoFactorRoutes.get('/status', requireSession, async (req, res) => {
  try {
    const row = await db('users').where({ id: req.session.userId }).select('totp_enabled', 'require_2fa_setup', 'email').first() as {
      totp_enabled: boolean; require_2fa_setup: boolean; email: string | null;
    } | undefined;
    res.json({
      success: true,
      data: {
        totpEnabled: row?.totp_enabled ?? false,
        require2faSetup: row?.require_2fa_setup ?? false,
        email: row?.email ?? null,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to get 2FA status' });
  }
});

/**
 * POST /api/profile/2fa/totp/setup — generate secret + QR.
 * Refused (409 totpAlreadyEnabled) while TOTP is enabled: replacing an active
 * authenticator goes through DELETE /totp, which proves the current one. A
 * session cookie alone must not be able to swap the second factor (it would
 * then pass the forced re-authentication with its own codes).
 */
twoFactorRoutes.post('/totp/setup', requireSession, async (req, res) => {
  try {
    const row = await db('users').where({ id: req.session.userId }).first('totp_enabled') as
      { totp_enabled: boolean } | undefined;
    if (row?.totp_enabled) {
      res.status(409).json({ success: false, code: 'totpAlreadyEnabled', error: TOTP_ALREADY_ENABLED_ERROR });
      return;
    }

    const username = req.session.username ?? 'user';
    const { secret, uri } = twoFactorService.generateTotpSecret(username);
    const qrDataUrl = await twoFactorService.generateTotpQr(uri);

    // Store pending secret in session (not DB yet)
    req.session.pendingTotpSecret = secret;

    res.json({ success: true, data: { secret, qrDataUrl } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to setup TOTP' });
  }
});

/** POST /api/profile/2fa/totp/enable — verify code + save */
twoFactorRoutes.post('/totp/enable', requireSession, async (req, res) => {
  try {
    const code = codeFrom((req.body as { code?: unknown } | undefined)?.code);
    const pendingSecret = req.session.pendingTotpSecret;
    if (!pendingSecret || code === null) {
      res.status(400).json({ success: false, error: 'No pending TOTP setup or missing code' });
      return;
    }

    const step = twoFactorService.matchStep(pendingSecret, code, TOTP_WINDOW_DEFAULT);
    if (step === null) {
      res.status(401).json({ success: false, error: 'Invalid code' });
      return;
    }

    // Conditional on TOTP being off: an active authenticator is never
    // overwritten without the proof DELETE /totp requires. The step of the
    // enabling code is recorded (TOTP replay guard); mfa_epoch moves (DB trigger)
    // and a credentials-changed push is queued for the linked apps (MFA epoch, push queue).
    const updated = await db('users').where({ id: req.session.userId, totp_enabled: false }).update({
      totp_secret: pendingSecret,
      totp_enabled: true,
      require_2fa_setup: false,
      totp_last_step: db.raw('GREATEST(COALESCE(totp_last_step, -1), ?::int)', [step]),
      updated_at: new Date(),
    });
    if (!updated) {
      res.status(409).json({ success: false, code: 'totpAlreadyEnabled', error: TOTP_ALREADY_ENABLED_ERROR });
      return;
    }
    delete req.session.pendingTotpSecret;
    // mfa_epoch moved: every OTHER session of the account ends, this one gets
    // a new id and the new credential version.
    await sessionService.afterOwnCredentialChange(req);
    void ssoSyncQueue.kick();

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to enable TOTP' });
  }
});

/**
 * DELETE /api/profile/2fa/totp — disable TOTP.
 * Body: { code } — a CURRENT code of the active authenticator, never used
 * before (consuming check, TOTP replay guard): a session cookie alone can no longer
 * remove (then replace) the second factor.
 * 400 codeRequired · 401 invalidCode / codeUsed · 429 tooManyAttempts.
 */
twoFactorRoutes.delete('/totp', requireSession, async (req, res) => {
  try {
    const userId = req.session.userId!;
    const row = await db('users').where({ id: userId }).first('totp_enabled') as
      { totp_enabled: boolean } | undefined;
    if (!row?.totp_enabled) {
      res.json({ success: true }); // already off
      return;
    }

    const code = codeFrom((req.body as { code?: unknown } | undefined)?.code);
    if (code === null) {
      res.status(400).json({ success: false, code: 'codeRequired', error: 'Current authentication code required' });
      return;
    }

    const key = String(userId);
    const retryAfterSec = disableThrottle.retryAfterSec(key);
    if (retryAfterSec > 0) {
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({ success: false, code: 'tooManyAttempts', error: 'Too many failed 2FA attempts — try again later' });
      return;
    }

    const r = await twoFactorService.checkUserTotp(userId, code, { consume: true, window: TOTP_WINDOW_DEFAULT });
    if (r.status === 'replayed') {
      res.status(401).json({ success: false, code: 'codeUsed', error: CODE_USED_ERROR });
      return;
    }
    if (r.status !== 'valid') {
      if (r.status === 'invalid') disableThrottle.fail(key);
      res.status(401).json({ success: false, code: 'invalidCode', error: 'Invalid code' });
      return;
    }
    disableThrottle.reset(key);

    await db('users').where({ id: userId, totp_enabled: true }).update({
      totp_secret: null,
      totp_enabled: false,
      updated_at: new Date(),
    });
    // mfa_epoch moved (DB trigger): other sessions end, this one is refreshed
    await sessionService.afterOwnCredentialChange(req);
    void ssoSyncQueue.kick(); // push queued
    logger.info({ userId }, '2FA disabled by the user');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to disable TOTP' });
  }
});

// ── Auth endpoint (2FA verification during login) ────────────────────────────

/** The TOTP step must follow the password step within this delay. */
const PENDING_MFA_TTL_MS = 10 * 60 * 1000;
/** Wrong codes accepted in ONE pending sign-in; then the password step starts over. */
const PENDING_MFA_MAX_FAILS = 5;
const SIGN_IN_AGAIN_ERROR = 'Sign in again: enter your password';

/**
 * Anti-flood of the sign-in TOTP step, keyed by address AND pending account
 * (the body names no user: keyed by the address alone, every user behind one
 * NAT shared 20 tries). The real brute-force bound is per account below.
 */
const mfaVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => `${req.ip || 'unknown'}:mfa:${req.session?.pendingMfaUserId ?? '-'}`,
  standardHeaders: true,
  legacyHeaders: false,
});

/** Forget the pending sign-in (password step to redo); the rest of the session is kept. */
async function dropPending(req: import('express').Request): Promise<void> {
  delete req.session.pendingMfaUserId;
  delete req.session.pendingMfaAt;
  delete req.session.pendingMfaEpoch;
  delete req.session.pendingMfaFails;
  delete req.session.pendingReauthTicket;
  await saveSession(req);
}

/**
 * POST /api/profile/2fa/verify — verify code during login.
 * The code's step must be newer than any step already accepted for the user
 * (TOTP replay guard, RFC 6238 §5.2): a code cannot be replayed within its window,
 * neither here nor at an app's consuming step-up. 401 { code: 'codeUsed' }
 * when the right code was already used, { code: 'invalidCode' } otherwise.
 *
 * Brute force (per ACCOUNT, whatever the address): 5 wrong codes in 5 min →
 * 15 min lock, 20 in 24 h → 24 h lock (429 tooManyAttempts + Retry-After);
 * each failure also counts in the account's app step-up budget. One pending
 * sign-in allows 5 wrong codes and lasts 10 min, and is void if the account's
 * credentials changed after the password step: then 401 { code: 'signInAgain' }
 * (password step again). Replays are not counted.
 *
 * On success the session gets a NEW id (a copy of the previous cookie never
 * inherits the sign-in) and records its authentication context (authAt = now,
 * amr = ['pwd', 'otp'], forced re-authentication); the re-authentication ticket named at the
 * password step, if any, is satisfied.
 */
twoFactorRoutes.post('/verify', mfaVerifyLimiter, async (req, res) => {
  try {
    const userId = req.session.pendingMfaUserId;
    if (!userId) {
      res.status(400).json({ success: false, error: 'No pending 2FA session' });
      return;
    }
    const pendingAt = req.session.pendingMfaAt;
    if (typeof pendingAt !== 'number' || Date.now() - pendingAt > PENDING_MFA_TTL_MS || Date.now() < pendingAt) {
      await dropPending(req);
      res.status(401).json({ success: false, code: 'signInAgain', error: SIGN_IN_AGAIN_ERROR });
      return;
    }

    const code = codeFrom((req.body as { code?: unknown } | undefined)?.code);
    if (code === null) {
      res.status(400).json({ success: false, error: 'Missing code' });
      return;
    }

    const key = String(userId);
    const retryAfterSec = Math.max(signInTotpThrottle.retryAfterSec(key), signInTotpDailyThrottle.retryAfterSec(key));
    if (retryAfterSec > 0) {
      logger.warn({ userId, retryAfterSec }, '2FA sign-in: account locked after repeated wrong codes');
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({ success: false, code: 'tooManyAttempts', error: 'Too many failed 2FA attempts — try again later' });
      return;
    }

    // Credentials changed (or account deactivated) since the password step:
    // that password step no longer counts.
    const before = await db('users').where({ id: userId }).first('mfa_epoch', 'is_active') as
      { mfa_epoch: number; is_active: boolean } | undefined;
    if (!before || !before.is_active || Number(before.mfa_epoch) !== req.session.pendingMfaEpoch) {
      await dropPending(req);
      res.status(401).json({ success: false, code: 'signInAgain', error: SIGN_IN_AGAIN_ERROR });
      return;
    }

    const r = await twoFactorService.checkUserTotp(userId, code, { consume: true, window: TOTP_WINDOW_DEFAULT });
    if (r.status === 'not_found') {
      res.status(401).json({ success: false, error: 'User not found' });
      return;
    }
    if (r.status === 'replayed') {
      res.status(401).json({ success: false, code: 'codeUsed', error: CODE_USED_ERROR });
      return;
    }
    if (r.status !== 'valid') {
      if (r.status === 'invalid') {
        signInTotpThrottle.fail(key);
        const dayLocked = signInTotpDailyThrottle.fail(key);
        totpUserThrottle.fail(key); // one budget of guesses per account (app step-ups included)
        if (dayLocked) logger.warn({ userId }, '2FA sign-in: 20 wrong codes in 24 h — account locked for 24 h');
        const fails = (req.session.pendingMfaFails ?? 0) + 1;
        if (fails >= PENDING_MFA_MAX_FAILS) {
          await dropPending(req);
          res.status(401).json({ success: false, code: 'signInAgain', error: SIGN_IN_AGAIN_ERROR });
          return;
        }
        req.session.pendingMfaFails = fails;
        await saveSession(req);
      }
      res.status(401).json({ success: false, code: 'invalidCode', error: 'Invalid code' });
      return;
    }
    signInTotpThrottle.reset(key);

    const row = await db('users').where({ id: userId, is_active: true }).first('id', 'username', 'role', 'mfa_epoch') as {
      id: number; username: string; role: string; mfa_epoch: number;
    } | undefined;
    if (!row) {
      res.status(401).json({ success: false, error: 'User not found' });
      return;
    }

    // Complete the session, under a NEW id
    const now = Date.now();
    await sessionService.regenerate(req, (old) => ({
      reauthTickets: satisfyTicket(old.reauthTickets, old.pendingReauthTicket, now),
    }));
    sessionService.establish(req, { id: row.id, username: row.username, role: row.role, mfaEpoch: Number(row.mfa_epoch) }, ['pwd', 'otp'], now);
    await saveSession(req);

    res.json({ success: true, data: { user: { id: row.id, username: row.username, role: row.role } } });
  } catch (err) {
    logger.error(err, '2FA verify error');
    res.status(500).json({ success: false, error: 'Verification failed' });
  }
});
