import type { Request, Response, NextFunction } from 'express';
import { sessionService } from '../services/session.service';

// Extend express-session
declare module 'express-session' {
  interface SessionData {
    userId: number;
    username: string;
    role: string;
    /**
     * users.mfa_epoch when this session authenticated. Every authenticated
     * request compares it with the database: a password / TOTP / activation
     * change since the sign-in ends the session (services/session.service).
     */
    mfaEpoch?: number;
    // 2FA pending state (password verified, TOTP step to come)
    pendingMfaUserId?: number;
    /** When the password step succeeded (ms): the TOTP step must follow within 10 min. */
    pendingMfaAt?: number;
    /** users.mfa_epoch at the password step: a change in between voids the pending sign-in. */
    pendingMfaEpoch?: number;
    /** Wrong codes typed in this pending sign-in: after 5, the password step starts over. */
    pendingMfaFails?: number;
    /** The forced re-authentication ticket this sign-in answers (forced re-authentication), if any. */
    pendingReauthTicket?: string;
    // Authentication context of the session (forced re-authentication): when (ms epoch) and
    // how (RFC 8176 values: 'pwd', 'otp') the user last authenticated here.
    // Returned to the apps by the code exchange as authTime / amr.
    authAt?: number;
    amr?: string[];
    // Pending forced re-authentications (/authorize with prompt=login or
    // max_age): ticket -> { at: start time (ms), appId, satisfiedAt? }. A
    // ticket is satisfied by the sign-in that names it (POST /auth/login
    // { reauthTicket }), which sets satisfiedAt; it is then used once.
    reauthTickets?: Record<string, { at: number; appId: number; satisfiedAt?: number }>;
  }
}

export class AppError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = 'AppError';
  }
}

const TWO_FACTOR_SETUP_REQUIRED = {
  success: false,
  code: 'twoFactorSetupRequired',
  error: 'Two-factor authentication must be set up first',
};

/**
 * A signed-in session whose account still matches it (active, same
 * credential version and role — checked against the database on every
 * request). Allowed while a second factor still has to be configured: only
 * for the routes that let the user do so (2FA setup, /auth/me, enrolment).
 */
export async function requireSession(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await sessionService.current(req);
    if (!user) { next(new AppError(401, 'Authentication required')); return; }
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * requireSession, and the account's second factor is configured when it must
 * be (admin 2FA reset, force-2FA policy): 403 twoFactorSetupRequired otherwise.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await sessionService.current(req);
    if (!user) { next(new AppError(401, 'Authentication required')); return; }
    if (await sessionService.twoFactorSetupPending(user)) {
      res.status(403).json(TWO_FACTOR_SETUP_REQUIRED);
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
}

/** requireAuth, and the account is a platform admin — per the database, not the session alone. */
export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await sessionService.current(req);
    if (!user) { next(new AppError(401, 'Authentication required')); return; }
    if (await sessionService.twoFactorSetupPending(user)) {
      res.status(403).json(TWO_FACTOR_SETUP_REQUIRED);
      return;
    }
    if (user.role !== 'admin') { next(new AppError(403, 'Admin access required')); return; }
    next();
  } catch (err) {
    next(err);
  }
}
