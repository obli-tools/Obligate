import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import { requireAppBearer } from './api.routes';
import { delegationService, type MintRefusal } from '../services/delegation.service';
import { logger } from '../utils/logger';

export const delegationRoutes = Router();

/**
 * Per-app rate limit on minting.
 *
 * A mint is cheap, which is exactly the problem: unbounded minting turns this
 * endpoint into a signing oracle. The key is a hash of the presented Bearer
 * credential so each connected app gets its own bucket and one noisy app cannot
 * starve the others. Hashed rather than used raw so the app's API key never
 * becomes a lookup key sitting in the limiter's in-memory store.
 *
 * Placed BEFORE requireAppBearer so a flood of bad credentials is capped too;
 * requests with no Bearer at all share one bucket and are additionally covered
 * by the global apiLimiter mounted on /api in app.ts.
 */
const mintLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120, // a context rail renders a handful of panels per page; 2/s per app is generous
  keyGenerator: (req) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return 'anonymous';
    return crypto.createHash('sha256').update(header.slice(7)).digest('hex').slice(0, 32);
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Refusal -> HTTP status.
 *
 * 400 = the caller sent something malformed. 403 = the caller sent something
 * well-formed that Obligate will not authorize.
 *
 * The precise machine reason is returned even for the subject_* refusals. That
 * does let a caller probe which user ids exist, but the caller is an
 * authenticated first-party app that can already enumerate the roster through
 * GET /api/apps/users, so nothing is disclosed that it could not already read,
 * and a vague refusal would make every integration bug indistinguishable.
 */
const REFUSAL_STATUS: Record<MintRefusal, number> = {
  audience_invalid: 400,
  subject_invalid: 400,
  subject_type_invalid: 400,
  tenant_slug_invalid: 400,
  tenant_slug_numeric: 400,
  scope_invalid: 400,
  requesting_app_inactive: 403,
  requesting_app_key_exposed: 403,
  app_subject_not_allowed: 403,
  audience_is_self: 403,
  audience_not_registered: 403,
  audience_ambiguous: 403,
  subject_not_found: 403,
  subject_inactive: 403,
  subject_not_entitled: 403,
  subject_disabled_on_audience: 403,
  subject_admin_refused: 403,
  subject_not_linked_requester: 403,
  subject_not_linked_audience: 403,
  tenant_not_permitted: 403,
};

/**
 * POST /api/delegation/token
 *
 * Auth: Bearer <static app API key>. The static key is now the credential for
 * MINTING a delegation token; it stops being the credential for reading another
 * app's data as that app.
 *
 * Body: { audience, subjectUserId?, tenantSlug, scope?, subjectType? }
 *   - subjectType = 'user' (default): user-scoped, subjectUserId required. The Desk/Ance flow.
 *   - subjectType = 'app': app-scoped, subjectUserId ignored. The requester acts in its own
 *     name (system push, telemetry sync, honeypot ban propagation). `sub` becomes
 *     `app:<requester_app_type>`. Only for the (requester, audience) pairs listed in
 *     DELEGATION_APP_SUBJECT_PAIRS (e.g. "oblihub:obliguard"), denied by default → else
 *     403 app_subject_not_allowed. Audience apps still allowlist which source apps are
 *     accepted per endpoint in their own logic.
 *
 * No token at all (user or app) for a requesting app whose API key was seen in clear as a
 * client_id since its last rotation (connected_apps.raw_client_id_last_seen_at) → 403
 * requesting_app_key_exposed; rotate the key (DELEGATION_ALLOW_EXPOSED_KEYS=true overrides).
 *
 * A user-scoped token is never minted on the strength of the key alone (the key may be
 * public while its app sends it as client_id). The subject must be:
 *   - active, entitled to the audience app and to the tenant (as before);
 *   - an ACTIVE user of the REQUESTING app: enabled link, entitled there, and at least one
 *     real SSO sign-in there (user_app_links.last_login_at) → else 403 subject_not_linked_requester;
 *   - linked to the AUDIENCE app: enabled link with an SSO sign-in there or a local account
 *     that app reported → else 403 subject_not_linked_audience;
 *   - not a platform admin (Obligate admin, or app-wide admin on the audience) unless
 *     DELEGATION_ALLOW_ADMIN_SUBJECTS=true → else 403 subject_admin_refused.
 * Every mint is audited: delegation_grants (token) or delegation_mint_refusals (refusal).
 *
 * Returns: { success: true, data: { token, expiresAt, kid } }
 *
 * The token says WHO (a user id, or a source app). It carries no permission list — the
 * audience app must re-derive every right from its own model.
 */
delegationRoutes.post('/token', mintLimiter, requireAppBearer, async (req: any, res) => {
  try {
    const { audience, subjectUserId, tenantSlug, scope, subjectType } = req.body ?? {};

    const result = await delegationService.mint({
      appId: req.appId,
      appType: req.appType,
      audience,
      subjectUserId,
      tenantSlug,
      scope,
      subjectType,
      ip: req.ip ?? null,
    });

    if (!result.ok) {
      // Every refusal is logged with full context: a refused mint is the signal
      // that either an app is misconfigured or someone is probing the boundary.
      logger.warn(
        { appId: req.appId, appType: req.appType, audience, subjectUserId, tenantSlug, reason: result.reason },
        'delegation: mint refused',
      );
      res.status(REFUSAL_STATUS[result.reason]).json({
        success: false,
        error: result.message,
        reason: result.reason,
      });
      return;
    }

    res.json({
      success: true,
      data: { token: result.token, expiresAt: result.expiresAt, kid: result.kid },
    });
  } catch (err) {
    logger.error(err, 'delegation: mint failed');
    res.status(500).json({ success: false, error: 'Failed to mint delegation token' });
  }
});

/**
 * GET /api/delegation/jwks
 *
 * PUBLIC, no auth: a JWKS document is public key material by definition, and
 * requiring a credential here would mean every verifier needs one before it can
 * check a signature.
 *
 * Returns the standard { keys: [...] } shape rather than the repo's
 * { success, data } envelope, so an off-the-shelf JWKS client works unmodified.
 *
 * Includes every key still capable of verifying an unexpired token, so a token
 * signed just before a rotation still checks out.
 */
delegationRoutes.get('/jwks', async (_req, res) => {
  try {
    // Generate on first use so a fresh install serves a usable JWKS immediately
    // instead of an empty key set until someone happens to mint.
    await delegationService.ensureKey();
    const keys = await delegationService.publicJwks();

    // The service already strips to public members and refuses to emit a JWK
    // carrying 'd'. Asserted AGAIN at the boundary because this is the one
    // endpoint where a leak would hand the whole suite the power to mint, and an
    // assertion in code outlives an assurance in a review comment.
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(key, 'd')) {
        logger.error('delegation: JWKS assembly produced private key material, refusing to serve');
        res.status(500).json({ error: 'JWKS unavailable' });
        return;
      }
    }

    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json({ keys });
  } catch (err) {
    logger.error(err, 'delegation: failed to serve JWKS');
    res.status(500).json({ error: 'JWKS unavailable' });
  }
});
