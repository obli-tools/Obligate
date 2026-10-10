import { FailureThrottle } from '../utils/failureThrottle';

// ─────────────────────────────────────────────────────────────────────────────
// Brute-force budgets of the TOTP checks (in-process, like the rate limiters).
//
// App step-ups (POST /api/oauth/verify-totp), any holder of an app key:
//   - per (calling app, user): 5 wrong codes in 5 min → THAT app is locked
//     out of the user's checks for 15 min;
//   - per user, all apps together: 20 wrong codes in 30 min → every app
//     locked out for 15 min.
// Obligate sign-in (POST /api/profile/2fa/verify), a holder of the password:
//   - per user: 5 wrong codes in 5 min → 15 min lock, and 20 in 24 h → 24 h
//     lock (no more rotating IPs: the key is the account, not the address);
//   - each failure is ALSO counted in the per-user budget of the app
//     step-ups (one budget of guesses per account), but not the other way
//     round: an app key must not be able to lock a user out of Obligate.
// Replays of a right code (TOTP replay guard) are never counted.
// ─────────────────────────────────────────────────────────────────────────────

export const totpPairThrottle = new FailureThrottle({ maxFails: 5, windowMs: 5 * 60 * 1000, lockMs: 15 * 60 * 1000 });
export const totpUserThrottle = new FailureThrottle({ maxFails: 20, windowMs: 30 * 60 * 1000, lockMs: 15 * 60 * 1000 });
export const signInTotpThrottle = new FailureThrottle({ maxFails: 5, windowMs: 5 * 60 * 1000, lockMs: 15 * 60 * 1000 });
export const signInTotpDailyThrottle = new FailureThrottle({ maxFails: 20, windowMs: 24 * 60 * 60 * 1000, lockMs: 24 * 60 * 60 * 1000 });
