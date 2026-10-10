import type { Request } from 'express';
import type { SessionData } from 'express-session';
import { db } from '../db';
import { logger } from '../utils/logger';
import { permissionGroupService } from './permissionGroup.service';

// ─────────────────────────────────────────────────────────────────────────────
// Obligate sessions follow the account they belong to.
//
// A session records, when it authenticates, the user's mfa_epoch and role
// (users.mfa_epoch moves with every password / TOTP / activation change, DB
// trigger of migration 016). Every authenticated request re-reads the user:
// a deleted or inactive account, a moved epoch (credentials changed since the
// sign-in) or another role ends the session at once. So a password change, a
// deactivation or a demotion expels a stolen cookie from Obligate itself —
// and therefore from every app it would otherwise keep signing in (/authorize).
//
// Each successful authentication also gets a NEW session id (regenerate):
// a copy of the previous cookie (stolen, or planted before the sign-in) never
// inherits the new authentication.
// ─────────────────────────────────────────────────────────────────────────────

export interface SessionUser {
  id: number;
  username: string;
  role: string;
  mfaEpoch: number;
  totpEnabled: boolean;
  require2faSetup: boolean;
}

interface UserRow {
  id: number;
  username: string;
  role: string;
  is_active: boolean;
  mfa_epoch: number;
  totp_enabled: boolean;
  require_2fa_setup: boolean | null;
}

type ReqWithUser = Request & { _obligateSessionUser?: SessionUser | null };

function destroy(req: Request): Promise<void> {
  return new Promise((resolve) => {
    if (!req.session) { resolve(); return; }
    req.session.destroy(() => resolve());
  });
}

export function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
}

/** A re-authentication ticket as /authorize issues it (16 random bytes, hex), else undefined. */
export function parseReauthTicket(v: unknown): string | undefined {
  return typeof v === 'string' && /^[0-9a-f]{32}$/.test(v) ? v : undefined;
}

/**
 * The pending re-authentication tickets of the session, with the one this
 * sign-in answers marked satisfied (forced re-authentication). Only the ticket NAMED by the
 * sign-in (POST /auth/login { reauthTicket }): any other pending ticket — e.g.
 * one started by someone else through a copy of the cookie — stays unsatisfied.
 */
export function satisfyTicket(
  tickets: SessionData['reauthTickets'],
  ticket: string | undefined,
  at: number,
): SessionData['reauthTickets'] {
  if (!tickets) return tickets;
  const out = { ...tickets };
  if (ticket && Object.prototype.hasOwnProperty.call(out, ticket) && out[ticket]) {
    out[ticket] = { ...out[ticket], satisfiedAt: at };
  }
  return out;
}

export const sessionService = {
  /**
   * The signed-in user of this request, checked against the database (once
   * per request, cached on it). Null — and the session destroyed — when the
   * account is gone or inactive, when its credentials changed since this
   * session authenticated (mfa_epoch), when its role changed, or when the
   * session predates this check (no recorded epoch: one new sign-in).
   */
  async current(req: Request): Promise<SessionUser | null> {
    const r = req as ReqWithUser;
    if (r._obligateSessionUser !== undefined) return r._obligateSessionUser;
    const s = req.session;
    if (!s?.userId) { r._obligateSessionUser = null; return null; }

    const row = await db('users').where({ id: s.userId })
      .first('id', 'username', 'role', 'is_active', 'mfa_epoch', 'totp_enabled', 'require_2fa_setup') as UserRow | undefined;
    let reason: string | null = null;
    if (!row) reason = 'user_deleted';
    else if (!row.is_active) reason = 'user_inactive';
    else if (typeof s.mfaEpoch !== 'number') reason = 'session_predates_epoch_check';
    else if (Number(row.mfa_epoch) !== s.mfaEpoch) reason = 'credentials_changed';
    else if (row.role !== s.role) reason = 'role_changed';
    if (reason) {
      logger.info({ userId: s.userId, reason }, 'Obligate session ended: no longer matches its account');
      await destroy(req);
      r._obligateSessionUser = null;
      return null;
    }
    const user: SessionUser = {
      id: row!.id,
      username: row!.username,
      role: row!.role,
      mfaEpoch: Number(row!.mfa_epoch),
      totpEnabled: !!row!.totp_enabled,
      require2faSetup: !!row!.require_2fa_setup,
    };
    r._obligateSessionUser = user;
    return user;
  },

  /**
   * A second factor must be configured before anything else (admin 2FA reset,
   * or the force-2FA policy) and is not yet: only the 2FA setup, /auth/me,
   * the enrolment and sign-out are allowed. Enforced by the server — the
   * client redirect alone did not stop a password-only session from using
   * every other route.
   */
  async twoFactorSetupPending(user: SessionUser): Promise<boolean> {
    if (user.totpEnabled) return false;
    if (user.require2faSetup) return true;
    // Once per request (requireAuth at the mount, then requireAdmin)
    const u = user as SessionUser & { _force2fa?: boolean };
    if (u._force2fa === undefined) u._force2fa = await permissionGroupService.isForce2faRequiredForUser(user.id);
    return u._force2fa;
  },

  /**
   * Replace the session id, keeping what `carry` returns from the old session
   * data. The old session is destroyed in the store: a copy of its cookie is
   * worthless from now on.
   */
  async regenerate(req: Request, carry: (old: Partial<SessionData>) => Partial<SessionData>): Promise<void> {
    const old = { ...(req.session as unknown as Partial<SessionData>) };
    // The new session keeps its own cookie (fresh expiry); only data is carried.
    const { cookie: _cookie, ...kept } = carry(old) as Partial<SessionData> & { cookie?: unknown };
    await new Promise<void>((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
    Object.assign(req.session, kept);
    delete (req as ReqWithUser)._obligateSessionUser;
    await saveSession(req);
  },

  /**
   * Record the authenticated user in the session (after a regenerate): who,
   * the role and credential version it is valid for, when and how it
   * authenticated (forced re-authentication).
   */
  establish(req: Request, user: { id: number; username: string; role: string; mfaEpoch: number }, amr: string[], authAt: number): void {
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    req.session.mfaEpoch = user.mfaEpoch;
    req.session.authAt = authAt;
    req.session.amr = amr;
    delete req.session.pendingMfaUserId;
    delete req.session.pendingMfaAt;
    delete req.session.pendingMfaEpoch;
    delete req.session.pendingMfaFails;
    delete req.session.pendingReauthTicket;
  },

  /**
   * Drop every Obligate session of a user (signed in, or half-way through the
   * TOTP step), except `exceptSid` (the session making a change to its own
   * account, refreshed by the caller). Best effort: the per-request check
   * above ends them anyway at their next request.
   */
  async dropUserSessions(userId: number, exceptSid?: string): Promise<number> {
    try {
      const q = db('session').where((w) => {
        w.whereRaw("(sess->>'userId')::int = ?", [userId])
          .orWhereRaw("(sess->>'pendingMfaUserId')::int = ?", [userId]);
      });
      if (exceptSid) q.andWhereNot('sid', exceptSid);
      return await q.del();
    } catch (err) {
      logger.warn({ userId, err: err instanceof Error ? err.message : err }, 'Could not drop the user\'s Obligate sessions');
      return 0;
    }
  },

  /**
   * After a change to the signed-in user's OWN credentials (password, TOTP):
   * every other session of the account ends; this one gets a new id and the
   * new credential version (it proved the change).
   */
  async afterOwnCredentialChange(req: Request): Promise<void> {
    const userId = req.session.userId!;
    const row = await db('users').where({ id: userId }).first('mfa_epoch', 'role') as { mfa_epoch: number; role: string } | undefined;
    await this.regenerate(req, (old) => ({ ...old, mfaEpoch: row ? Number(row.mfa_epoch) : old.mfaEpoch, role: row?.role ?? old.role }));
    await this.dropUserSessions(userId, req.sessionID);
  },

  /**
   * After an administrator changed ANOTHER account (password, activation,
   * role): all its sessions end. When the target is the actor's own account,
   * the acting session is kept and refreshed (a deactivation still ends it:
   * the per-request check does).
   */
  async afterAccountChangeBy(req: Request, targetUserId: number): Promise<void> {
    if (req.session?.userId === targetUserId) {
      const row = await db('users').where({ id: targetUserId }).first('mfa_epoch', 'role', 'is_active') as
        { mfa_epoch: number; role: string; is_active: boolean } | undefined;
      if (row?.is_active) {
        await this.regenerate(req, (old) => ({ ...old, mfaEpoch: Number(row.mfa_epoch), role: row.role }));
        await this.dropUserSessions(targetUserId, req.sessionID);
        return;
      }
    }
    await this.dropUserSessions(targetUserId);
  },
};
