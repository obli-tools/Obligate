import crypto from 'crypto';
import type { Knex } from 'knex';
import { db } from '../db';
import { config } from '../config';
import { encrypt, decrypt, parsePositiveInt } from '../utils/crypto';
import { logger } from '../utils/logger';
import { permissionGroupService } from './permissionGroup.service';

// ─────────────────────────────────────────────────────────────────────────────
// User-scoped delegation tokens
//
// Obligate authorizes IDENTITY, AUDIENCE and TENANT. It never decides whether
// the user may read device 123 -- that lives in the audience app's own
// permission model. A duplicated permission model drifts, and it drifts OPEN.
//
// So the token carries WHO, not WHAT THEY MAY DO. There is deliberately no
// capability, role or permission claim anywhere in this file. If a future
// change adds one, the whole reason this module exists has been undone.
//
// Data never transits Obligate: only the token does. The requesting app calls
// the audience app directly and the audience app re-derives every right.
//
// Crypto is Ed25519 via node:crypto, no new dependency:
//   * jose v5 is ESM-only and both servers are CommonJS -- it would break tsc.
//   * jsonwebtoken cannot serve JWKS without another package.
//   * Node 24 signs/verifies Ed25519 natively and exports straight to JWK.
// ASYMMETRIC IS NOT OPTIONAL. With a shared secret, every app able to VERIFY is
// also able to MINT, which is the same bypass with extra steps.
// ─────────────────────────────────────────────────────────────────────────────

/** Token lifetime. Short on purpose: a leaked token must be worthless before anyone can use it. */
const TOKEN_TTL_SECONDS = 120;

/** Clock skew tolerance the audience app should allow on nbf/exp. 30s, no more. */
export const CLOCK_SKEW_SECONDS = 30;

/**
 * How long a rotated key stays verifiable. The strict minimum is
 * TTL + skew (150s) -- past that no live token can still reference it. The
 * extra margin covers a queued request and a badly drifting clock; it costs one
 * extra public key in the JWKS document.
 */
const ROTATED_KEY_RETENTION_SECONDS = 3600;

/** Signing key cache TTL. See ensureKey() for why this is short. */
const KEY_CACHE_TTL_MS = 60_000;

/**
 * Allowed scope values. `scp` is a COARSE hint for logging and audit, NOT an
 * authorization input: the audience app must produce the same answer whether or
 * not it reads this claim. Kept as a strict allowlist so a caller cannot smuggle
 * something that looks like a capability ('devices:write:*') into the audit log
 * and have it mistaken for one later.
 */
const ALLOWED_SCOPES = ['read'] as const;

/** Advisory lock id for first-key generation. Arbitrary but stable. */
const KEYGEN_LOCK_ID = 828_412_001;

/** Storage markers for the private key at rest (see the migration for the warning). */
const SEAL_ENCRYPTED = 'enc:aes-256-gcm:';
const SEAL_PLAINTEXT = 'plain:';

export interface PublicJwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  kid: string;
  use: 'sig';
  alg: 'EdDSA';
}

export interface DelegationClaims {
  iss: string;
  aud: string;
  azp: string;
  sub: string;
  ost: string;
  scp: string;
  jti: string;
  iat: number;
  nbf: number;
  exp: number;
}

export type MintRefusal =
  | 'requesting_app_inactive'
  | 'requesting_app_key_exposed'
  | 'app_subject_not_allowed'
  | 'audience_invalid'
  | 'audience_is_self'
  | 'audience_not_registered'
  | 'audience_ambiguous'
  | 'subject_invalid'
  | 'subject_not_found'
  | 'subject_inactive'
  | 'subject_not_entitled'
  | 'subject_disabled_on_audience'
  | 'subject_admin_refused'
  | 'subject_not_linked_requester'
  | 'subject_not_linked_audience'
  | 'subject_type_invalid'
  | 'tenant_slug_invalid'
  | 'tenant_slug_numeric'
  | 'tenant_not_permitted'
  | 'scope_invalid';

export type MintResult =
  | { ok: true; token: string; expiresAt: string; kid: string; jti: string }
  | { ok: false; reason: MintRefusal; message: string };

interface KeyRow {
  id: number;
  kid: string;
  alg: string;
  public_jwk: PublicJwk | { kty: string; crv: string; x: string };
  private_pem: string;
  is_active: boolean;
  created_at: Date;
  rotated_at: Date | null;
}

interface ActiveKey {
  kid: string;
  privateKey: crypto.KeyObject;
  publicJwk: PublicJwk;
}

let activeCache: { key: ActiveKey; loadedAt: number } | null = null;

/**
 * Platform-admin subjects (Obligate `users.role = 'admin'`, or an app-wide
 * admin mapping on the audience app = god view there) are refused unless the
 * operator opts in with DELEGATION_ALLOW_ADMIN_SUBJECTS=true. Such a token
 * opens every tenant of the audience app, and an app key -- the only
 * credential of a mint -- may be public while its app sends it as client_id.
 * Read per mint (no restart needed to turn it off).
 */
function allowAdminSubjects(): boolean {
  return process.env.DELEGATION_ALLOW_ADMIN_SUBJECTS?.trim().toLowerCase() === 'true';
}

/**
 * App-scoped tokens (sub = app:<requester>) are minted only for the
 * (requester, audience) pairs the operator lists, DENIED BY DEFAULT:
 *   DELEGATION_APP_SUBJECT_PAIRS="oblihub:obliguard[,<requester>:<audience>...]"
 * Such a token names no user and rests on the requester's key alone — e.g.
 * Obliguard turns sub=app:oblihub into GLOBAL bans pushed to the routers.
 * Read per mint.
 */
export function appSubjectPairAllowed(requesterType: string, audienceType: string): boolean {
  const raw = process.env.DELEGATION_APP_SUBJECT_PAIRS?.trim().toLowerCase();
  if (!raw) return false;
  const pair = `${requesterType.toLowerCase()}:${audienceType.toLowerCase()}`;
  return raw.split(/[\s,;]+/).filter(Boolean).includes(pair);
}

/**
 * A requesting app whose API key went through a browser as its client_id
 * since the key was last rotated (connected_apps.raw_client_id_last_seen_at)
 * mints nothing: that key must be treated as public. Rotating the key (and
 * sending sha256(key) as client_id) lifts it. DELEGATION_ALLOW_EXPOSED_KEYS=true
 * overrides — knowingly — while an app is being migrated.
 */
function allowExposedKeys(): boolean {
  return process.env.DELEGATION_ALLOW_EXPOSED_KEYS?.trim().toLowerCase() === 'true';
}

/** Refusal rows are kept this long (see migration 015). Also the grants retention (maintenance.service). */
export const REFUSAL_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
let lastRefusalPrune = 0;

/**
 * Durable audit of a refused mint (a minted token has its delegation_grants
 * row). Every value comes from the caller and is bounded; a failure to write
 * is logged, never turned into an error for the caller.
 */
async function recordRefusal(
  params: {
    appId: number; appType: string; audience: unknown; subjectUserId: unknown;
    tenantSlug: unknown; subjectType?: unknown; ip?: string | null;
  },
  reason: MintRefusal,
): Promise<void> {
  const str = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.slice(0, max) : null);
  const subjectType = params.subjectType === undefined || params.subjectType === null
    ? 'user'
    : (str(params.subjectType, 8) ?? 'invalid');
  const subjectId = subjectType === 'user' ? parsePositiveInt(params.subjectUserId) : null;
  try {
    await db('delegation_mint_refusals').insert({
      app_id: params.appId,
      app_type: str(params.appType, 32),
      audience: str(params.audience, 64),
      subject_type: subjectType,
      // int4 column: an id past its range is not a user id anyway
      subject_user_id: subjectId !== null && subjectId <= 2_147_483_647 ? subjectId : null,
      tenant_slug: str(params.tenantSlug, 128),
      reason,
      ip: params.ip ? params.ip.slice(0, 64) : null,
    });
    const now = Date.now();
    if (now - lastRefusalPrune > 60 * 60 * 1000) {
      lastRefusalPrune = now;
      await db('delegation_mint_refusals').where('created_at', '<', new Date(now - REFUSAL_RETENTION_MS)).del();
    }
  } catch (err) {
    logger.error({ err, reason, appId: params.appId }, 'delegation: could not record a refused mint');
  }
}

// ── base64url + compact JWS ──────────────────────────────────────────────────

/**
 * base64url per RFC 4648 §5: standard base64 with '+' -> '-', '/' -> '_' and no
 * '=' padding. Node's 'base64url' encoding does exactly that, so there is no
 * hand-rolled character replacement to get subtly wrong.
 */
function b64url(input: Buffer): string {
  return input.toString('base64url');
}

function b64urlJson(value: unknown): string {
  return b64url(Buffer.from(JSON.stringify(value), 'utf8'));
}

/**
 * Compact JWS serialization (RFC 7515 §7.1):
 *
 *     BASE64URL(header) '.' BASE64URL(payload) '.' BASE64URL(signature)
 *
 * The signing input is the ASCII bytes of the first two segments joined by a
 * dot -- the SEGMENTS, not the raw JSON. Signing the JSON instead would let a
 * verifier and a signer disagree on whitespace and key order.
 *
 * alg is 'EdDSA' and the signature is produced with crypto.sign(null, ...):
 * `null` is how Node asks for pure EdDSA, which hashes internally. Passing
 * 'sha256' here would be a different, non-interoperable signature.
 *
 * There is no 'none' branch and no algorithm lookup from the header. The
 * verifier side must likewise pin alg to 'EdDSA' rather than trusting the
 * header, or the classic alg-confusion bypass reopens.
 */
function signCompactJws(claims: DelegationClaims, privateKey: crypto.KeyObject, kid: string): string {
  const header = { alg: 'EdDSA', typ: 'JWT', kid };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(claims)}`;
  // base64url output is ASCII by construction, so utf8 and ascii bytes are identical here.
  const signature = crypto.sign(null, Buffer.from(signingInput, 'utf8'), privateKey);
  return `${signingInput}.${b64url(signature)}`;
}

/**
 * RFC 7638 JWK thumbprint. For an OKP key the canonical form is the required
 * members only, in lexicographic order, with no whitespace: crv, kty, x.
 * The JSON is built by hand rather than via JSON.stringify on the exported JWK
 * because the exported object's key order is not something to depend on.
 */
function jwkThumbprint(jwk: { kty: string; crv: string; x: string }): string {
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}"}`;
  return b64url(crypto.createHash('sha256').update(canonical, 'utf8').digest());
}

// ── private key at rest ──────────────────────────────────────────────────────

function encryptionKeyConfigured(): boolean {
  // utils/crypto encrypt() expects a 32-byte hex AES-256 key. An empty or
  // malformed ENCRYPTION_KEY would throw inside createCipheriv, so check the
  // shape here rather than discovering it at mint time.
  return /^[0-9a-fA-F]{64}$/.test(config.encryptionKey);
}

function sealPrivateKey(pem: string): string {
  if (encryptionKeyConfigured()) {
    return SEAL_ENCRYPTED + encrypt(pem);
  }
  // Loud on purpose. See the migration comment: an invented cipher keyed off
  // something guessable would look like protection and provide none, so we store
  // it plainly and say so every single time.
  logger.error(
    'delegation: ENCRYPTION_KEY is not set (32-byte hex) - the Ed25519 signing key is stored ' +
    'in PLAINTEXT in delegation_keys.private_pem. Anyone who can read that column can mint a ' +
    'delegation token for ANY user on ANY app. Set ENCRYPTION_KEY and rotate the key.',
  );
  return SEAL_PLAINTEXT + pem;
}

function unsealPrivateKey(stored: string): string {
  if (stored.startsWith(SEAL_ENCRYPTED)) {
    return decrypt(stored.slice(SEAL_ENCRYPTED.length));
  }
  if (stored.startsWith(SEAL_PLAINTEXT)) {
    return stored.slice(SEAL_PLAINTEXT.length);
  }
  throw new Error('delegation: unrecognised private key storage format');
}

// ── key material ─────────────────────────────────────────────────────────────

function rowToActiveKey(row: KeyRow): ActiveKey {
  let pem: string;
  try {
    pem = unsealPrivateKey(row.private_pem);
  } catch (err) {
    // Almost always ENCRYPTION_KEY having changed under a sealed key. Fail with
    // something an operator can act on rather than a bare GCM auth failure -- and
    // fail rather than quietly minting a new key, which would silently invalidate
    // every verifier that has this kid cached.
    logger.error({ kid: row.kid, err }, 'delegation: cannot unseal the stored signing key (ENCRYPTION_KEY changed?)');
    throw new Error(`delegation: cannot unseal signing key ${row.kid}; restore ENCRYPTION_KEY or rotate()`);
  }
  const jwk = row.public_jwk as { kty: string; crv: string; x: string };
  return {
    kid: row.kid,
    privateKey: crypto.createPrivateKey(pem),
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid: row.kid, use: 'sig', alg: 'EdDSA' },
  };
}

/**
 * Generate an Ed25519 pair and persist it as the active key.
 *
 * Always called inside a transaction that already holds the advisory lock, so
 * the "at most one active key" partial unique index can never be hit as a race.
 */
async function createActiveKey(trx: Knex.Transaction): Promise<ActiveKey> {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string; d?: string };
  // A PUBLIC KeyObject can never export 'd'. Asserting anyway means a future
  // refactor that accidentally exports the private half fails here instead of
  // publishing the signing key on the public JWKS endpoint.
  if (jwk.d !== undefined) throw new Error('delegation: refusing to persist a JWK carrying private material');
  const kid = jwkThumbprint(jwk);
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

  await trx('delegation_keys').insert({
    kid,
    alg: 'EdDSA',
    // Stringified explicitly so the jsonb column never depends on how the pg
    // driver happens to serialise a plain object.
    public_jwk: JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x }),
    private_pem: sealPrivateKey(pem),
    is_active: true,
  });

  logger.info({ kid }, 'delegation: generated a new Ed25519 signing key');
  return { kid, privateKey, publicJwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid, use: 'sig', alg: 'EdDSA' } };
}

export const delegationService = {
  /**
   * Return the active signing key, generating one on first use.
   *
   * The cache is short-lived rather than permanent because Obligate can run as
   * more than one process: after another process rotates, this one keeps signing
   * with the old key until the cache expires. That is safe -- the old key stays
   * in the JWKS document for ROTATED_KEY_RETENTION_SECONDS, so those tokens still
   * verify -- but it should not last forever.
   */
  async ensureKey(): Promise<ActiveKey> {
    if (activeCache && Date.now() - activeCache.loadedAt < KEY_CACHE_TTL_MS) {
      return activeCache.key;
    }

    const existing = await db('delegation_keys')
      .where({ is_active: true })
      .orderBy('created_at', 'desc')
      .first() as KeyRow | undefined;
    if (existing) {
      const key = rowToActiveKey(existing);
      activeCache = { key, loadedAt: Date.now() };
      return key;
    }

    // First use. Two processes booting together would otherwise both generate,
    // and the partial unique index would fail one of them with a raw constraint
    // error. Serialise on an advisory lock and re-check inside it.
    const key = await db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(?)', [KEYGEN_LOCK_ID]);
      const raced = await trx('delegation_keys')
        .where({ is_active: true })
        .orderBy('created_at', 'desc')
        .first() as KeyRow | undefined;
      if (raced) return rowToActiveKey(raced);
      return createActiveKey(trx);
    });

    activeCache = { key, loadedAt: Date.now() };
    return key;
  },

  /**
   * Retire the current key and start signing with a new one.
   *
   * The old row is KEPT, not deleted: a token signed 60 seconds ago is still
   * valid for another 60 and must still verify. Deleting on rotation would break
   * every in-flight request in the suite. purgeExpiredKeys() removes it once no
   * live token can reference it.
   */
  async rotate(): Promise<{ kid: string; retiredKid: string | null }> {
    const result = await db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(?)', [KEYGEN_LOCK_ID]);
      const current = await trx('delegation_keys').where({ is_active: true }).first() as KeyRow | undefined;
      // Deactivate BEFORE inserting: the partial unique index allows only one
      // active row, so the insert would otherwise fail.
      if (current) {
        await trx('delegation_keys')
          .where({ id: current.id })
          .update({ is_active: false, rotated_at: new Date() });
      }
      const fresh = await createActiveKey(trx);
      return { kid: fresh.kid, retiredKid: current?.kid ?? null };
    });

    activeCache = null; // force a reload; other processes catch up within KEY_CACHE_TTL_MS
    await this.purgeExpiredKeys();
    logger.warn({ kid: result.kid, retiredKid: result.retiredKid }, 'delegation: signing key rotated');
    return result;
  },

  /**
   * Drop retired keys that can no longer be referenced by a live token.
   * Only ever touches rows already marked inactive and rotated long enough ago.
   */
  async purgeExpiredKeys(): Promise<number> {
    const cutoff = new Date(Date.now() - ROTATED_KEY_RETENTION_SECONDS * 1000);
    const deleted = await db('delegation_keys')
      .where('is_active', false)
      .whereNotNull('rotated_at')
      .where('rotated_at', '<', cutoff)
      .del();
    if (deleted > 0) logger.info({ deleted }, 'delegation: purged retired signing keys');
    return deleted;
  },

  /**
   * Every key still capable of verifying an unexpired token: the active one plus
   * any retired within the retention window.
   *
   * PUBLIC MATERIAL ONLY. The returned objects are rebuilt field by field from
   * (kty, crv, x) instead of spreading the stored row, so private_pem cannot ride
   * along even if the query changes, and the assertion below fails loudly rather
   * than quietly publishing a signing key.
   */
  async publicJwks(): Promise<PublicJwk[]> {
    const cutoff = new Date(Date.now() - ROTATED_KEY_RETENTION_SECONDS * 1000);
    const rows = await db('delegation_keys')
      .where('is_active', true)
      .orWhere((qb) => { qb.where('is_active', false).where('rotated_at', '>=', cutoff); })
      .orderBy('created_at', 'desc') as KeyRow[];

    const keys: PublicJwk[] = [];
    for (const row of rows) {
      const jwk = row.public_jwk as { kty: string; crv: string; x: string; d?: string };
      if (!jwk || typeof jwk.x !== 'string') {
        logger.error({ kid: row.kid }, 'delegation: stored public_jwk is malformed, omitting from JWKS');
        continue;
      }
      if ('d' in jwk) {
        // Never serve it. A JWK carrying 'd' on a public endpoint hands the
        // whole suite the ability to mint.
        logger.error({ kid: row.kid }, 'delegation: stored public_jwk contains private material, omitting from JWKS');
        continue;
      }
      keys.push({ kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid: row.kid, use: 'sig', alg: 'EdDSA' });
    }
    return keys;
  },

  /**
   * Mint a delegation token.
   *
   * Every check below is about IDENTITY, AUDIENCE and TENANT. None of them is
   * about what the subject may read on the audience app: that question belongs
   * to the audience app and is deliberately left unanswered here.
   *
   * The result is a discriminated union rather than an exception so the route
   * can map each refusal to a precise status without pattern-matching on strings.
   */
  async mint(params: {
    appId: number;
    appType: string;
    audience: unknown;
    subjectUserId: unknown;
    tenantSlug: unknown;
    scope?: unknown;
    ip?: string | null;
    subjectType?: unknown;
  }): Promise<MintResult> {
    // Every mint is audited: a token by its delegation_grants row (written in
    // _mint), a refusal by a delegation_mint_refusals row (here).
    const result = await this._mint(params);
    if (!result.ok) await recordRefusal(params, result.reason);
    return result;
  },

  /** The checks and the signature; see mint(). */
  async _mint(params: {
    appId: number;
    appType: string;
    audience: unknown;
    subjectUserId: unknown;
    tenantSlug: unknown;
    scope?: unknown;
    ip?: string | null;
    /**
     * 'user' (default, back-compat) — mint a user-scoped token, subjectUserId must be a real
     * active Obligate user entitled to the audience app + tenant. This is the Desk/Ance flow.
     *
     * 'app' — mint an app-scoped token. The requester acts in its own name (system push,
     * telemetry sync, honeypot ban propagation). No user is named. `sub` becomes
     * `app:<requester.app_type>`. Only for the (requester, audience) pairs of
     * DELEGATION_APP_SUBJECT_PAIRS (denied by default). Subject-related checks (c/d/e in the
     * user flow) are skipped because there is no user to check; the audience app is expected
     * to allowlist which source apps can trigger which endpoints in its own logic.
     */
    subjectType?: unknown;
  }): Promise<MintResult> {
    const { appId, appType } = params;

    // ── Input shape ──────────────────────────────────────────────────────────
    // aud is ONE app type. Never an array, never a wildcard: a token good for
    // two audiences is a token the second audience never agreed to accept.
    if (typeof params.audience !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/.test(params.audience)) {
      return { ok: false, reason: 'audience_invalid', message: 'audience must be a single app type string' };
    }
    const audience = params.audience;

    const subjectType: 'user' | 'app' = params.subjectType === undefined || params.subjectType === null
      ? 'user'
      : params.subjectType === 'user' || params.subjectType === 'app'
        ? params.subjectType
        : 'invalid' as never;
    if (subjectType !== 'user' && subjectType !== 'app') {
      return { ok: false, reason: 'subject_type_invalid', message: 'subjectType must be "user" or "app"' };
    }

    // subjectUserId is REQUIRED and validated for user-scoped tokens. For app-scoped tokens the
    // field is ignored — apps don't act on behalf of anyone but themselves.
    let subjectUserId = 0;
    if (subjectType === 'user') {
      // One canonical form per id (a number, or its exact decimal string):
      // "042" / "42 " are refused rather than silently meaning user 42.
      subjectUserId = parsePositiveInt(params.subjectUserId) ?? NaN;
      if (!Number.isSafeInteger(subjectUserId) || subjectUserId <= 0) {
        return { ok: false, reason: 'subject_invalid', message: 'subjectUserId must be a positive integer' };
      }
    }

    if (typeof params.tenantSlug !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(params.tenantSlug)) {
      return { ok: false, reason: 'tenant_slug_invalid', message: 'tenantSlug must be a slug' };
    }
    const tenantSlug = params.tenantSlug;
    // Hard rules 3 and 13: cross-app tenant identity joins on the human SLUG.
    // An all-digits value is almost certainly a per-app numeric tenant id that
    // leaked through a caller, and it means something different on every app --
    // silently accepting it would join two unrelated tenants together.
    if (/^\d+$/.test(tenantSlug)) {
      return { ok: false, reason: 'tenant_slug_numeric', message: 'tenantSlug must be a slug, not a numeric tenant id' };
    }

    const scope = params.scope === undefined || params.scope === null ? 'read' : params.scope;
    if (typeof scope !== 'string' || !(ALLOWED_SCOPES as readonly string[]).includes(scope)) {
      return { ok: false, reason: 'scope_invalid', message: `scope must be one of: ${ALLOWED_SCOPES.join(', ')}` };
    }

    // ── (a) the requesting app is active ─────────────────────────────────────
    // requireAppBearer already matched an active app, but it did so before this
    // request queued. Re-read: a deactivation that lands in between must stop the
    // mint, not merely the next one.
    const requester = await db('connected_apps')
      .where({ id: appId, is_active: true })
      .first('id', 'app_type', 'raw_client_id_last_seen_at') as
        { id: number; app_type: string; raw_client_id_last_seen_at: Date | null } | undefined;
    if (!requester) {
      return { ok: false, reason: 'requesting_app_inactive', message: 'Requesting app is not active' };
    }
    // The requester's key was seen in clear as a client_id since its last
    // rotation: it is public, it authenticates no mint.
    if (requester.raw_client_id_last_seen_at && !allowExposedKeys()) {
      logger.error({ appId, appType: requester.app_type, seenAt: requester.raw_client_id_last_seen_at },
        'delegation: mint refused — the requesting app sent its raw API key as client_id (exposed): rotate its key and migrate it to sha256(api_key)');
      return {
        ok: false,
        reason: 'requesting_app_key_exposed',
        message: 'The requesting app\'s API key was exposed as a client_id: rotate it (Connected Apps) before minting',
      };
    }
    // azp is taken from the database row below, never from the caller. This
    // compares the two only to surface a stale bearer mapping in the log; it is
    // not a gate, because the DB row is the authority either way.
    if (appType && appType !== requester.app_type) {
      logger.warn({ appId, claimed: appType, actual: requester.app_type },
        'delegation: caller app_type disagrees with the connected_apps row');
    }

    // An app minting a token whose audience is itself is not a delegation, it is
    // a self-signed pass into its own resource server. Refuse it outright.
    if (audience === requester.app_type) {
      return { ok: false, reason: 'audience_is_self', message: 'audience must be a different app than the requester' };
    }

    // ── (b) the audience app is registered and active ────────────────────────
    const audienceApps = await db('connected_apps')
      .where({ app_type: audience, is_active: true })
      .select('id', 'app_type') as Array<{ id: number; app_type: string }>;
    if (audienceApps.length === 0) {
      return { ok: false, reason: 'audience_not_registered', message: 'Audience app is not registered or not active' };
    }
    if (audienceApps.length > 1) {
      // app_type is not unique in connected_apps. Two active instances of the
      // same type have two SEPARATE entitlement sets, so picking one arbitrarily
      // could hand the user authority they only hold on the other. Fail closed.
      logger.error({ audience, count: audienceApps.length },
        'delegation: multiple active apps share this app_type, refusing to guess which one the token is for');
      return { ok: false, reason: 'audience_ambiguous', message: 'Multiple active apps share this app type' };
    }
    const audienceApp = audienceApps[0];

    // App-scoped tokens: only for the pairs the operator allowed.
    if (subjectType === 'app' && !appSubjectPairAllowed(requester.app_type, audience)) {
      return {
        ok: false,
        reason: 'app_subject_not_allowed',
        message: `App-scoped tokens from ${requester.app_type} to ${audience} are not allowed (DELEGATION_APP_SUBJECT_PAIRS)`,
      };
    }

    // ── (c/d/e) subject validation — USER-scoped tokens only ────────────────
    // App-scoped tokens (subjectType === 'app') skip this whole block: no user to look up, no
    // entitlement to derive. The audience app is expected to allowlist which SOURCE APPS can
    // trigger which endpoints, symmetrical to the way it allowlists user permissions today.
    // The tenant slug is still recorded (apps operate within a tenant scope on the audience),
    // but the tenant-per-user permission-groups check doesn't apply — there is no user.
    if (subjectType === 'user') {
      // The only credential of this request is the requesting app's key, and
      // that key may be public (apps still sending it as client_id). So the
      // key alone must never be enough to borrow a user: the user must be a
      // REAL, CURRENT user of BOTH apps, and admins are opt-in.

      // (c) subject user exists and is active
      const subject = await db('users')
        .where({ id: subjectUserId })
        .first('id', 'role', 'is_active') as { id: number; role: string; is_active: boolean } | undefined;
      if (!subject) {
        return { ok: false, reason: 'subject_not_found', message: 'Subject user does not exist' };
      }
      if (!subject.is_active) {
        return { ok: false, reason: 'subject_inactive', message: 'Subject user is not active' };
      }

      const [onAudience, onRequester] = await Promise.all([
        permissionGroupService.getAppMembership(subjectUserId, audienceApp.id),
        permissionGroupService.getAppMembership(subjectUserId, requester.id),
      ]);

      // (d) subject is entitled to the audience app
      if (onAudience.link && !onAudience.link.enabled) {
        return { ok: false, reason: 'subject_disabled_on_audience', message: 'Subject user is disabled on the audience app' };
      }
      const isPlatformAdmin = subject.role === 'admin';
      const audienceWideAdmin = onAudience.mappings.some(m => !m.tenantSlug && m.appRole === 'admin');

      // (e) no platform-admin subject unless the operator opted in: such a
      // token is a god view on every tenant of the audience app.
      if ((isPlatformAdmin || audienceWideAdmin) && !allowAdminSubjects()) {
        return {
          ok: false,
          reason: 'subject_admin_refused',
          message: 'Subject user is a platform admin; delegation for admins is disabled (DELEGATION_ALLOW_ADMIN_SUBJECTS)',
        };
      }
      if (!isPlatformAdmin && onAudience.mappings.length === 0) {
        return { ok: false, reason: 'subject_not_entitled', message: 'Subject user has no access to the audience app' };
      }

      // (f) actively linked to the REQUESTING app: enabled link, entitled
      // there now, and at least one real SSO sign-in there (last_login_at is
      // only written by a code exchange -- a key holder cannot forge it, unlike
      // remote_user_id which report-provision sets).
      const reqLink = onRequester.link;
      if (!reqLink || !reqLink.enabled || !reqLink.lastLoginAt || !onRequester.entitled) {
        return { ok: false, reason: 'subject_not_linked_requester', message: 'Subject user is not an active user of the requesting app' };
      }

      // (g) actively linked to the AUDIENCE app: enabled link, with an SSO
      // sign-in there or a local account the audience app itself reported
      // (only its own key writes that pointer). No link = no local account to
      // resolve the token to on the audience side anyway.
      const audLink = onAudience.link;
      if (!audLink || !audLink.enabled || (!audLink.lastLoginAt && audLink.remoteUserId == null)) {
        return { ok: false, reason: 'subject_not_linked_audience', message: 'Subject user has no account on the audience app' };
      }

      // (h) tenant slug is one the subject belongs to
      const hasAllTenants = onAudience.mappings.some(m => !m.tenantSlug);
      const grantedSlugs = new Set(onAudience.mappings.filter(m => m.tenantSlug).map(m => m.tenantSlug as string));
      if (!isPlatformAdmin && !hasAllTenants && !grantedSlugs.has(tenantSlug)) {
        return { ok: false, reason: 'tenant_not_permitted', message: 'Subject user does not belong to this tenant on the audience app' };
      }
    }

    // ── Sign ─────────────────────────────────────────────────────────────────
    // `sub` shape:
    //   user-scoped: numeric user id as string ("42")
    //   app-scoped:  "app:<requester_app_type>" ("app:oblihub")
    // The prefix is stable and machine-parseable, so audience apps can `sub.startsWith('app:')`
    // to route to their app-source allowlist instead of their user-permission logic.
    const key = await this.ensureKey();
    const nowSec = Math.floor(Date.now() / 1000);
    const jti = crypto.randomUUID();
    const subClaim = subjectType === 'app' ? `app:${requester.app_type}` : String(subjectUserId);
    const claims: DelegationClaims = {
      iss: issuer(),
      aud: audience,
      azp: requester.app_type,
      sub: subClaim,
      ost: tenantSlug,
      scp: scope,
      jti,
      iat: nowSec,
      nbf: nowSec,
      exp: nowSec + TOKEN_TTL_SECONDS,
    };
    const token = signCompactJws(claims, key.privateKey, key.kid);

    const expiresAt = new Date(claims.exp * 1000);
    await db('delegation_grants').insert({
      jti,
      app_id: requester.id,
      audience,
      // Nullable in the schema since migration 013 — app-scoped tokens leave it empty.
      subject_user_id: subjectType === 'user' ? subjectUserId : null,
      subject_type: subjectType,
      tenant_slug: tenantSlug,
      scope,
      issued_at: new Date(claims.iat * 1000),
      expires_at: expiresAt,
      ip: params.ip ? params.ip.slice(0, 64) : null,
    });

    logger.info({ jti, azp: requester.app_type, aud: audience, sub: subClaim, subjectType, ost: tenantSlug, scp: scope, kid: key.kid },
      'delegation: token minted');

    return { ok: true, token, expiresAt: expiresAt.toISOString(), kid: key.kid, jti };
  },

  /** Exposed so callers and tests agree on the wire contract without duplicating the numbers. */
  ttlSeconds: TOKEN_TTL_SECONDS,
  clockSkewSeconds: CLOCK_SKEW_SECONDS,
};

/**
 * The `iss` claim. Obligate serves its own client from the same origin, so
 * CLIENT_ORIGIN is the public base URL; OBLIGATE_PUBLIC_URL overrides it for
 * deployments where the two differ. Read at mint time rather than cached so a
 * config change does not need a restart. Trailing slash stripped: the audience
 * compares `iss` by exact string.
 */
function issuer(): string {
  return (process.env.OBLIGATE_PUBLIC_URL || config.clientOrigin).replace(/\/$/, '');
}
