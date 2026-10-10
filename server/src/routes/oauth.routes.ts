import { Router, type Request, type Response } from 'express';
import { db } from '../db';
import { oauthService } from '../services/oauth.service';
import { appService } from '../services/app.service';
import { permissionGroupService } from '../services/permissionGroup.service';
import { twoFactorService, TOTP_WINDOW_DEFAULT, TOTP_WINDOW_STRICT } from '../services/twoFactor.service';
import { requireAppBearer } from './api.routes';
import { logger } from '../utils/logger';
import { generateToken, parsePositiveInt } from '../utils/crypto';
import { checkRedirectUri, loopbackAllowedFor } from '../utils/redirect';
import { sessionService, saveSession } from '../services/session.service';
import { totpPairThrottle, totpUserThrottle } from '../services/totpThrottle.service';

const REQUIRED_ENROLLMENT_VERSION = 1;

export const oauthRoutes = Router();

// ── Device-bound 2FA of the connected apps for SSO accounts ─────────────────
//   totpReplayGuard  POST /verify-totp {consume:true} + users.totp_last_step
//   stepUpEpoch      GET /users/:id/mfa-epoch + users.mfa_epoch (DB trigger)
//   push queue       credentials-changed pushes (services/ssoSyncQueue)
//   reauth           /authorize honours prompt=login / max_age; the code
//                    exchange returns authTime + amr
//   capabilities     GET /capabilities announces the three flags

/** Capabilities announced to the connected apps (capabilities). */
export const OAUTH_LOT_O_CAPABILITIES = Object.freeze({ stepUpEpoch: 1, reauth: 1, totpReplayGuard: 1 } as const);

/**
 * Operator switch: OAUTH_LOT_O_CAPABILITIES=false withholds the announcement
 * (every step-up/re-auth behaviour stays in place, the apps just do not rely on it).
 */
function lotOAnnounced(): boolean {
  const v = (process.env.OAUTH_LOT_O_CAPABILITIES ?? '').trim().toLowerCase();
  return !['false', '0', 'off', 'no'].includes(v);
}

/** A forced re-authentication must be completed within this delay. */
const REAUTH_TICKET_TTL_MS = 10 * 60 * 1000;
/** Pending re-authentication tickets kept per session (newest first). */
const REAUTH_TICKET_MAX = 5;

function queryString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string').join(' ');
  return '';
}

/**
 * OIDC-style freshness request (forced re-authentication):
 *   - prompt=login         → always re-authenticate;
 *   - max_age=N (seconds)  → re-authenticate when the session authenticated
 *                            more than N s ago, or when that is unknown;
 *                            max_age=0 therefore always re-authenticates.
 * An unreadable max_age counts as 0 (the strictest reading).
 */
export function freshLoginRequired(query: Record<string, unknown>, authAtMs: number | undefined, now: number): boolean {
  const prompt = queryString(query.prompt).split(/\s+/).filter(Boolean);
  if (prompt.includes('login')) return true;
  if (query.max_age === undefined) return false;
  const raw = queryString(query.max_age).trim();
  const maxAge = /^\d{1,9}$/.test(raw) ? parseInt(raw, 10) : 0;
  if (!authAtMs) return true;
  return now - authAtMs > maxAge * 1000;
}

type ReauthTickets = Record<string, { at: number; appId: number; satisfiedAt?: number }>;

function pruneTickets(tickets: ReauthTickets | undefined, now: number): ReauthTickets {
  const kept = Object.entries(tickets ?? {})
    .filter(([, t]) => !!t && typeof t.at === 'number' && typeof t.appId === 'number' && t.at <= now && now - t.at <= REAUTH_TICKET_TTL_MS)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, REAUTH_TICKET_MAX);
  return Object.fromEntries(kept);
}

/** The /authorize URL to come back to after the forced sign-in, carrying the ticket. */
function withTicket(originalUrl: string, ticket: string): string {
  const u = new URL(originalUrl, 'http://obligate.invalid');
  u.searchParams.set('reauth_ticket', ticket);
  return `${u.pathname}${u.search}`;
}

/** The /authorize URL without its freshness parameters (after a sign-in that is fresh anyway). */
function withoutFreshness(originalUrl: string): string {
  const u = new URL(originalUrl, 'http://obligate.invalid');
  for (const k of ['prompt', 'max_age', 'reauth_ticket']) u.searchParams.delete(k);
  return `${u.pathname}${u.search}`;
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (v: string): string => v.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

/** A browser navigation (a person reads the answer), as opposed to a server-side probe or API call. */
function wantsHtml(req: Request): boolean {
  return /\btext\/html\b/i.test(String(req.headers.accept ?? ''));
}

/** Styled error page of /authorize, same look as the Access Denied page. */
function sendHtmlError(res: Response, status: number, title: string, paragraphs: string[]): void {
  res.status(status).setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0d1117;color:#8b949e;font-family:-apple-system,BlinkMacSystemFont,sans-serif}.c{text-align:center;max-width:540px;padding:2rem}.h{color:#f85149;font-size:1.25rem;font-weight:600;margin-bottom:.75rem}.p{font-size:.875rem;margin-bottom:.75rem;line-height:1.5}code{color:#e6edf3;background:#161b22;padding:.1rem .35rem;border-radius:4px;word-break:break-all}a{color:#58a6ff;text-decoration:none}a:hover{text-decoration:underline}</style></head><body><div class="c"><div class="h">${escapeHtml(title)}</div>${paragraphs.map((p) => `<div class="p">${p}</div>`).join('')}<a href="/">Back to Obligate</a></div></body></html>`);
}

/**
 * GET /api/oauth/authorize
 * Entry point for the SSO flow. If user has a session, issue a code and redirect.
 * If not, redirect to the Obligate login page with return params.
 *
 * Query params: client_id, redirect_uri, state
 *   - client_id: the app's PUBLIC client id, sha256(api_key) as lowercase hex
 *     (see publicClientId). This URL goes through the browser (history,
 *     Referer, access logs), so it must never carry the API key. The raw key
 *     is still accepted for apps not yet migrated (deprecated).
 *   - redirect_uri: must be on the origin of the app's registered base URL
 *     (connected_apps.base_url, plus OAUTH_EXTRA_REDIRECT_ORIGINS for that app),
 *     or on a loopback host for the desktop / native flow (RFC 8252 §7.3) —
 *     for the app types of OAUTH_LOOPBACK_APP_TYPES only (default: obliance).
 *     Anything else: 400 { error: 'Invalid redirect_uri' } — checked before
 *     the session, so no login page and no code for a foreign URL.
 *   - state: optional, echoed back URL-encoded.
 *   - prompt=login and/or max_age=<seconds>: optional (forced re-authentication). Force a
 *     fresh sign-in — password, plus a NEW TOTP code when the user has TOTP —
 *     even with a live Obligate session. Tracked by a one-time
 *     `reauth_ticket` (10 min, bound to the app) kept in the session and
 *     appended to the return URL: the code is issued only once the session
 *     authenticated after the ticket was created, and the exchange then
 *     reports that authentication (authTime, amr). Without a signed-in
 *     session: the plain sign-in page, back to the URL without prompt /
 *     max_age (that sign-in is fresh anyway; nothing written for an
 *     anonymous request).
 */
oauthRoutes.get('/authorize', async (req, res) => {
  try {
    const { client_id, redirect_uri, state } = req.query as {
      client_id?: string; redirect_uri?: string; state?: string;
    };

    // typeof guards: a repeated query param arrives as an array
    if (typeof client_id !== 'string' || typeof redirect_uri !== 'string' || !client_id || !redirect_uri) {
      res.status(400).json({ error: 'Missing client_id or redirect_uri' });
      return;
    }

    // Validate the app (public client id, or legacy raw API key — recorded
    // as an exposure of the key, refused per OAUTH_ACCEPT_RAW_CLIENT_ID)
    const lookup = await appService.lookupClientId(client_id);
    if (!lookup.app) {
      res.status(400).json(lookup.reason === 'raw_refused'
        ? { error: 'Invalid client_id', reason: 'raw_client_id_refused' }
        : { error: 'Invalid client_id' });
      return;
    }
    const app = lookup.app;

    // The code goes to redirect_uri: only to the app's own registered origin,
    // or to loopback for the desktop / native flow. Checked BEFORE the session
    // (an unauthenticated user is not sent through the login page for a
    // request that can only fail) and before any code is generated.
    const redirectOrigins = appService.redirectOriginsFor(app);
    const redirect = checkRedirectUri(redirect_uri, redirectOrigins, { allowLoopback: loopbackAllowedFor(app.app_type) });
    if (!redirect.ok) {
      logger.warn(
        { appId: app.id, appName: app.name, reason: redirect.reason, redirectOrigin: redirect.origin, expected: redirectOrigins },
        'authorize: redirect_uri refused (neither the registered base URL origin of the app nor loopback) — fix the app base URL in Obligate (Connected Apps), or OAUTH_EXTRA_REDIRECT_ORIGINS',
      );
      if (wantsHtml(req)) {
        // A person is looking at this: say which app and which address (the
        // status stays 400 for the apps' probes, which send no text/html).
        sendHtmlError(res, 400, 'Sign-in address not registered', [
          `<b>${escapeHtml(app.name)}</b> (${escapeHtml(app.app_type)}, app #${app.id}) asked Obligate to send you back to `
            + (redirect.origin ? `<code>${escapeHtml(redirect.origin)}</code>` : 'an invalid address')
            + ', which is not the address registered for it.',
          `Registered: ${redirectOrigins.map((o) => `<code>${escapeHtml(o)}</code>`).join(', ') || '<i>none</i>'}.`,
          'An administrator can correct the base URL of this app in Obligate (Connected Apps), or allow the extra address with OAUTH_EXTRA_REDIRECT_ORIGINS.',
        ]);
        return;
      }
      res.status(400).json({ error: 'Invalid redirect_uri' });
      return;
    }
    // A repeated ?state= arrives as an array: dropped rather than joined
    const stateValue = typeof state === 'string' && state.length <= 1024 ? state : '';

    // The Obligate session, checked against its account (active, same
    // credential version and role): a session left behind by a password
    // change, a deactivation or a demotion is ended here and signs nobody in.
    const sessionUser = await sessionService.current(req);

    // Forced re-authentication (forced re-authentication): prompt=login / max_age. Checked after the
    // client and redirect checks, before anything else (enrolment included).
    const now = Date.now();
    let reauthTicket: string | null = null;
    if (freshLoginRequired(req.query as Record<string, unknown>, sessionUser ? req.session?.authAt : undefined, now)) {
      if (!sessionUser) {
        // Not signed in: the sign-in that follows is fresh by construction.
        // No ticket, so an anonymous request never writes a session: come
        // back without prompt / max_age.
        res.redirect(`/login?reauth=1&returnTo=${encodeURIComponent(withoutFreshness(req.originalUrl))}`);
        return;
      }
      const tickets = pruneTickets(req.session.reauthTickets, now);
      const presented = typeof req.query.reauth_ticket === 'string' ? req.query.reauth_ticket : '';
      const t = presented && Object.prototype.hasOwnProperty.call(tickets, presented) ? tickets[presented] : undefined;
      // Satisfied only by the sign-in that NAMED this ticket (POST /auth/login
      // { reauthTicket }, which also gives the session a new id) — not by any
      // later sign-in in the session, which a copy of the cookie could ride on.
      const satisfied = !!(t && t.appId === app.id
        && typeof t.satisfiedAt === 'number' && t.satisfiedAt >= t.at
        && typeof req.session.authAt === 'number' && req.session.authAt >= t.at);
      if (!satisfied) {
        const ticket = generateToken(16);
        tickets[ticket] = { at: now, appId: app.id };
        req.session.reauthTickets = pruneTickets(tickets, now);
        await saveSession(req);
        res.redirect(`/login?reauth=1&returnTo=${encodeURIComponent(withTicket(req.originalUrl, ticket))}`);
        return;
      }
      reauthTicket = presented;
      req.session.reauthTickets = tickets;
    }

    // If user is already authenticated, check enrollment then issue code
    if (sessionUser) {
      // Check if user has completed enrollment — if not, redirect to enroll first
      const row = await db('users').where({ id: sessionUser.id }).select('enrollment_version').first() as { enrollment_version: number } | undefined;
      if ((row?.enrollment_version ?? 0) < REQUIRED_ENROLLMENT_VERSION) {
        const enrollUrl = `/enroll?returnTo=${encodeURIComponent(req.originalUrl)}`;
        res.redirect(enrollUrl);
        return;
      }

      // A second factor must be configured first (admin 2FA reset, or the
      // force-2FA policy): no code for a password-only session.
      if (await sessionService.twoFactorSetupPending(sessionUser)) {
        res.redirect(`/setup-2fa?returnTo=${encodeURIComponent(req.originalUrl)}`);
        return;
      }

      // Check if user has permission group mapping for this app
      const resolved = await permissionGroupService.resolveForUserAndApp(sessionUser.id, app.id);
      if (!resolved.role) {
        // User has no permission to access this app — show an error page
        res.status(403).setHeader('Content-Type', 'text/html');
        res.end(`<!DOCTYPE html><html><head><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0d1117;color:#8b949e;font-family:-apple-system,BlinkMacSystemFont,sans-serif}.c{text-align:center;max-width:400px;padding:2rem}.h{color:#f85149;font-size:1.25rem;font-weight:600;margin-bottom:.5rem}.p{font-size:.875rem;margin-bottom:1.5rem}a{color:#58a6ff;text-decoration:none}a:hover{text-decoration:underline}</style></head><body><div class="c"><div class="h">Access Denied</div><div class="p">You do not have permission to access this application. Contact your administrator to request access.</div><a href="/">Back to Obligate</a></div></body></html>`);
        return;
      }

      // A satisfied re-authentication ticket is single-use.
      if (reauthTicket && req.session.reauthTickets) {
        delete req.session.reauthTickets[reauthTicket];
      }

      const code = await oauthService.generateCode(sessionUser.id, app.id, redirect_uri, {
        authAt: typeof req.session.authAt === 'number' ? req.session.authAt : null,
        amr: Array.isArray(req.session.amr) ? req.session.amr : [],
      });
      const separator = redirect_uri.includes('?') ? '&' : '?';
      // state is echoed URL-encoded: a raw '&code=...' in it can no longer
      // smuggle a second code parameter into the app's callback.
      const redirectUrl = `${redirect_uri}${separator}code=${encodeURIComponent(code)}${stateValue ? `&state=${encodeURIComponent(stateValue)}` : ''}`;
      res.redirect(redirectUrl);
      return;
    }

    // Not authenticated — redirect to login page with return params
    const loginUrl = `/login?returnTo=${encodeURIComponent(req.originalUrl)}`;
    res.redirect(loginUrl);
  } catch (err) {
    logger.error(err, 'OAuth authorize error');
    res.status(500).json({ error: 'Authorization failed' });
  }
});

/**
 * POST /api/oauth/token/exchange
 * Server-to-server code exchange. Called by connected apps.
 * Auth: Bearer <app_api_key>
 */
oauthRoutes.post('/token/exchange', async (req, res) => {
  try {
    // Validate Bearer token
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ success: false, error: 'Missing Bearer token' });
      return;
    }
    const apiKey = authHeader.slice(7);
    const app = await appService.getAppByApiKey(apiKey);
    if (!app) {
      res.status(401).json({ success: false, error: 'Invalid API key' });
      return;
    }

    const { code, redirect_uri } = (req.body ?? {}) as { code?: unknown; redirect_uri?: unknown };
    if (typeof code !== 'string' || typeof redirect_uri !== 'string' || !code || !redirect_uri) {
      res.status(400).json({ success: false, error: 'Missing code or redirect_uri' });
      return;
    }

    const result = await oauthService.exchangeCode(code, app.id, redirect_uri);
    if (!result) {
      res.status(401).json({ success: false, error: 'Invalid, expired, or already used code' });
      return;
    }

    res.json({ success: true, data: result });
  } catch (err) {
    logger.error(err, 'Token exchange error');
    res.status(500).json({ success: false, error: 'Exchange failed' });
  }
});

/**
 * POST /api/oauth/verify-totp
 * Server-to-server TOTP verification. Used by connected apps to validate a
 * fresh TOTP code for SSO-authenticated users when they perform a
 * "sensitive" action that requires step-up authentication.
 *
 * Auth: Bearer <app_api_key>
 * Body: { userId, code, consume? }
 *   - userId: the Obligate user id (what apps store as foreign_id). A JSON
 *     number (safe integer > 0) or its canonical decimal string ("42").
 *     Anything else — "42 ", "042", "42.0", [42], {}, -1, 0, 1.5 — is refused
 *     (400) BEFORE any lookup or counter: every accepted id has one single
 *     form, so the brute-force counters below cannot be sidestepped by
 *     spelling the same user differently.
 *   - code  : the 6-digit TOTP the user typed (string or number)
 *   - consume (TOTP replay guard): true = the code's time step must be strictly
 *     newer than every step already accepted for this user — Obligate sign-in
 *     and every app's checks included — and is then consumed; window ±1 step
 *     (±30 s). Absent / false = the historical check (window ±2 steps, the
 *     same code stays usable within its window), which still records its
 *     step. Anything but a boolean → 400.
 * Response 200: { success: true, data: { valid, step, mfaEpoch, reason? } }
 *   - valid   : boolean (the only field older callers read — unchanged)
 *   - step    : floor(unix s / 30) of the matched code, null when it does not match
 *   - mfaEpoch: the user's credential version (see /users/:id/mfa-epoch)
 *   - reason  : when valid is false — 'invalid' (wrong code, counted by the
 *               brute-force limits) or 'replayed' (right code whose step was
 *               already used; consume:true only; not counted)
 * Errors: 400 missing / malformed field · 401 bearer · 404 user unknown,
 *   inactive, or not an enabled user of the CALLING app who signed in there
 *   through SSO at least once (a key holder cannot probe or guess codes of
 *   other users) · 409 TOTP not configured ·
 *   429 locked out (Retry-After)
 */
// ── Brute-force limits for /verify-totp (in-process) ─────────────────────────
// Any holder of an app key can ask Obligate to check codes, so:
//   - per (calling app, user): 5 wrong codes in 5 min → THAT app is locked out
//     of that user's checks for 15 min. One app key can neither guess fast
//     nor, as before, lock the user's step-up on every other app.
//   - per user, all apps together: 20 wrong codes in 30 min → every app locked
//     out for 15 min. Bounds a spray over several keys; a single app cannot
//     reach it alone (its own lock caps it at 10 failures per 30 min).
// Every 429 is logged so SOC tooling can catch a distributed spray.
// (instances in services/totpThrottle.service: the per-user budget is shared
// with the Obligate sign-in)

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || v === '';
}

oauthRoutes.post('/verify-totp', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ success: false, error: 'Missing Bearer token' });
      return;
    }
    const app = await appService.getAppByApiKey(authHeader.slice(7));
    if (!app) {
      res.status(401).json({ success: false, error: 'Invalid API key' });
      return;
    }

    const body = (req.body ?? {}) as { userId?: unknown; code?: unknown; consume?: unknown };
    if (isBlank(body.userId) || isBlank(body.code)) {
      res.status(400).json({ success: false, error: 'Missing userId or code' });
      return;
    }
    // Canonical id first: the counters and the lookup below only ever see it
    const userId = parsePositiveInt(body.userId);
    if (userId === null) {
      res.status(400).json({ success: false, error: 'Invalid userId' });
      return;
    }
    if ((typeof body.code !== 'string' && typeof body.code !== 'number') || String(body.code).length > 32) {
      res.status(400).json({ success: false, error: 'Invalid code' });
      return;
    }
    const code = String(body.code).trim();
    if (body.consume !== undefined && body.consume !== null && typeof body.consume !== 'boolean') {
      res.status(400).json({ success: false, error: 'Invalid consume' });
      return;
    }
    const consume = body.consume === true;

    // ── Brute-force gate ──────────────────────────────────────────────
    const pairKey = `${app.id}:${userId}`;
    const userKey = String(userId);
    const retryAfterSec = Math.max(totpPairThrottle.retryAfterSec(pairKey), totpUserThrottle.retryAfterSec(userKey));
    if (retryAfterSec > 0) {
      logger.warn({ userId, appId: app.id, retryAfterSec },
        'verify-totp: locked out after repeated failures');
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({
        success: false,
        error: 'Too many failed 2FA attempts — try again later',
      });
      return;
    }

    // Only a user of the CALLING app: active, with an enabled link to it AND
    // at least one real SSO sign-in there (last_login_at is only written by a
    // code exchange: a key holder cannot forge it, unlike the link rows that
    // report-provision creates). Anyone else is "not found" — the same answer
    // as an unknown id, so nothing is disclosed (not even whether a platform
    // admin has TOTP: 409 vs 200).
    const row = await db('users as u')
      .join('user_app_links as l', 'l.user_id', 'u.id')
      .where({ 'u.id': userId, 'u.is_active': true, 'l.app_id': app.id, 'l.enabled': true })
      .whereNotNull('l.last_login_at')
      .first('u.id') as { id: number } | undefined;
    if (!row) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    // One check of the STORED secret, recording its step (replay guard): consuming or not.
    const r = await twoFactorService.checkUserTotp(userId, code, {
      consume,
      window: consume ? TOTP_WINDOW_STRICT : TOTP_WINDOW_DEFAULT,
    });
    switch (r.status) {
      case 'not_found':
      case 'inactive':
        res.status(404).json({ success: false, error: 'User not found' });
        return;
      case 'not_configured':
        res.status(409).json({ success: false, error: 'TOTP not configured for this user' });
        return;
      case 'replayed':
        // The right code, but its step was already used (here or at a sign-in):
        // refused, not counted as a guess.
        logger.info({ userId, appId: app.id, step: r.step }, 'verify-totp: code already used (consume) — refused');
        res.json({ success: true, data: { valid: false, step: r.step, mfaEpoch: r.mfaEpoch, reason: 'replayed' } });
        return;
      case 'valid':
        totpPairThrottle.reset(pairKey);
        res.json({ success: true, data: { valid: true, step: r.step, mfaEpoch: r.mfaEpoch } });
        return;
      case 'invalid': {
        totpPairThrottle.fail(pairKey);
        const userLocked = totpUserThrottle.fail(userKey);
        logger.info({ userId, appId: app.id, consume },
          'verify-totp: invalid code (brute-force counters incremented)');
        if (userLocked) {
          logger.warn({ userId, appId: app.id },
            'verify-totp: too many failures for this user across apps — every app locked out of their checks for 15 min');
        }
        res.json({ success: true, data: { valid: false, step: null, mfaEpoch: r.mfaEpoch, reason: 'invalid' } });
        return;
      }
    }
  } catch (err) {
    logger.error(err, 'verify-totp error');
    res.status(500).json({ success: false, error: 'Verification failed' });
  }
});

/**
 * GET /api/oauth/capabilities (public; capabilities announcement)
 * Response: { success: true, data: { stepUpEpoch: 1, reauth: 1, totpReplayGuard: 1 } }
 * Announces what this Obligate implements for the connected apps' step-up of
 * SSO accounts (Obliance enables its phone keys for them only when every flag
 * is exactly 1). `data: {}` when the operator withholds the announcement
 * (OAUTH_LOT_O_CAPABILITIES=false). Never cached.
 */
oauthRoutes.get('/capabilities', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, data: lotOAnnounced() ? { ...OAUTH_LOT_O_CAPABILITIES } : {} });
});

/**
 * GET /api/oauth/users/:id/mfa-epoch (MFA epoch)
 * Auth: Bearer <app_api_key>. `:id` = the Obligate user id (the app's
 * foreign_id), canonical decimal only (400 otherwise).
 * Response: { success: true, data: { mfaEpoch: number, active: boolean } }
 *   - mfaEpoch: the user's credential version. It moves at every password
 *     change / reset, TOTP enable / replace / disable, deactivation /
 *     reactivation and admin MFA reset (DB trigger, whatever the code path),
 *     and never goes backwards.
 *   - active  : active in Obligate AND enabled on the calling app AND still
 *     entitled to it (platform admin or a permission-group mapping).
 * 404 when the user does not exist or never signed in to the CALLING app
 * through SSO (no user_app_links row, or one created by report-provision
 * only) — the same answer, so a key holder learns nothing about other users.
 * Apps must treat any non-2xx as "unusable" (fail closed). Never cached.
 */
oauthRoutes.get('/users/:id/mfa-epoch', requireAppBearer, async (req: any, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const userId = parsePositiveInt(req.params.id);
    if (userId === null) {
      res.status(400).json({ success: false, error: 'Invalid user id' });
      return;
    }
    const m = await permissionGroupService.getAppMembership(userId, req.appId);
    // A user of the calling app with at least one real SSO sign-in there (a
    // link row alone may come from report-provision, i.e. from the key).
    if (!m.user || !m.link || !m.link.lastLoginAt) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }
    const row = await db('users').where({ id: userId }).first('mfa_epoch') as { mfa_epoch: number } | undefined;
    if (!row) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }
    res.json({
      success: true,
      data: { mfaEpoch: Number(row.mfa_epoch), active: !!(m.user.isActive && m.link.enabled && m.entitled) },
    });
  } catch (err) {
    logger.error(err, 'mfa-epoch error');
    res.status(500).json({ success: false, error: 'Lookup failed' });
  }
});
