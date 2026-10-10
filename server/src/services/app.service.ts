import crypto from 'crypto';
import { db } from '../db';
import { generateToken, safeEqual, sealSecret, unsealSecret } from '../utils/crypto';
import { logger } from '../utils/logger';
import { httpOrigin, extraRedirectOrigins, allExtraRedirectOrigins } from '../utils/redirect';
import type { ConnectedApp, AppType } from '@obligate/shared';

interface AppRow {
  id: number;
  app_type: string;
  name: string;
  base_url: string;
  api_key: string;
  icon: string | null;
  color: string | null;
  sort_order: number;
  third_party: boolean;
  is_active: boolean;
  /** Sealed (utils/crypto sealSecret) inbound secret, or null = the API key. See migration 014. */
  inbound_secret?: string | null;
  /** Sealed inbound secret generated but not activated yet (migration 017). */
  inbound_secret_pending?: string | null;
  /** Last time the RAW API key was presented as client_id (null = never since the last rotation). */
  raw_client_id_last_seen_at?: Date | null;
  raw_client_id_uses?: number;
  api_key_rotated_at?: Date | null;
  created_at: Date;
  updated_at: Date;
}

export type { AppRow };

const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

function rowToApp(row: AppRow): ConnectedApp {
  return {
    id: row.id,
    appType: row.app_type as AppType,
    name: row.name,
    baseUrl: row.base_url,
    apiKeySet: true, // never expose raw key
    inboundSecretSet: !!row.inbound_secret,
    inboundSecretPending: !!row.inbound_secret_pending,
    inboundSecretSupported: inboundSecretSupported(row.app_type),
    rawClientIdLastSeenAt: iso(row.raw_client_id_last_seen_at),
    rawClientIdUses: Number(row.raw_client_id_uses ?? 0),
    apiKeyRotatedAt: iso(row.api_key_rotated_at),
    icon: row.icon,
    color: row.color,
    sortOrder: row.sort_order,
    thirdParty: !!row.third_party,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Public OAuth client identifier of an app: lowercase hex SHA-256 of its API key.
 *
 * This is what apps put in the browser-facing /authorize URL (client_id). It is
 * not a secret: seeing it in a Location header, browser history or an access
 * log does not reveal the API key, which stays the server-to-server secret
 * (Bearer on /token/exchange, requireAppBearer, and Obligate -> app calls).
 * Every Obli* app derives it the same way from its own key, so the formula is
 * a cross-repo contract: do not change it on one side only.
 */
export function publicClientId(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

/**
 * Validate an app base URL set by an admin: absolute http(s), no credentials,
 * no query or fragment, no character a browser would rewrite. Returned without
 * its trailing slash (as stored before). Null when invalid.
 *
 * The base URL is now load-bearing for security: /authorize only sends codes
 * to its origin, and the device links are built on it.
 */
export function normalizeBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048 || /[\u0000-\u0020\u007f-\u009f\\]/.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password || url.search || url.hash || trimmed.includes('#') || trimmed.includes('?')) return null;
  } catch {
    return null;
  }
  return trimmed.replace(/\/+$/, '');
}

/**
 * Icon shown for an app in cross-app switchers: the admin-set override when
 * there is one, else the app's own official favicon.svg — every Obli* app
 * already serves one at its origin (confirmed on all 5: 2.5-3.2 KB each), so
 * a newly registered app gets a correct brand icon everywhere with zero
 * admin action, exactly like `color`/`sortOrder` need none once set.
 */
export function effectiveIcon(baseUrl: string, icon: string | null): string {
  return icon || `${baseUrl.replace(/\/+$/, '')}/favicon.svg`;
}

/**
 * Validate an app type slug set by an admin when registering a new app:
 * lowercase letters/digits/dash, 2-32 chars (fits `t.string('app_type', 32)`,
 * migration 001), not starting or ending with a dash. No closed list — any
 * app can be registered without a code change anywhere in the suite (see
 * `AppType` in shared/src/types.ts).
 */
export function isValidAppTypeSlug(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(value);
}

/** Comma / space separated list from the environment, lower-cased; undefined when unset or blank. */
function envList(name: string): string[] | undefined {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return undefined;
  return raw.split(/[\s,]+/).filter(Boolean);
}

/**
 * May this app still present its RAW API key as client_id?
 * OAUTH_ACCEPT_RAW_CLIENT_ID = '*' (default: every app, the legacy form still
 * works), 'none' (no app), or the list of the app types still sending it
 * (e.g. "oblidesk,oblifield" once the others send sha256). Read per call.
 */
export function rawClientIdAccepted(appType: string): boolean {
  const list = envList('OAUTH_ACCEPT_RAW_CLIENT_ID');
  if (!list) return true;
  if (list.includes('none')) return false;
  return list.includes('*') || list.includes(appType.toLowerCase());
}

/**
 * App types able to require an inbound secret on the calls Obligate makes to
 * them (Obliance: OBLIGATE_INBOUND_SECRET; Oblimap and Oblihub: same setting).
 * Every other app compares the Bearer with its API key only: an inbound
 * secret would get each Obligate call refused (401). INBOUND_SECRET_APP_TYPES
 * overrides the list ('*' = every app type, 'none' = no app).
 */
export const DEFAULT_INBOUND_SECRET_APP_TYPES = ['obliance', 'oblimap', 'oblihub'];
export function inboundSecretSupported(appType: string): boolean {
  const list = envList('INBOUND_SECRET_APP_TYPES') ?? DEFAULT_INBOUND_SECRET_APP_TYPES;
  if (list.includes('none')) return false;
  return list.includes('*') || list.includes(appType.toLowerCase());
}

/** Result of resolving a browser-facing client_id. */
export type ClientIdLookup =
  | { app: AppRow; form: 'public' | 'raw' }
  | { app: null; reason: 'unknown' | 'raw_refused'; appId?: number };

// App ids already warned about for using the legacy raw-key client_id (once per process)
const legacyClientIdWarned = new Set<number>();

export const appService = {
  async listApps(): Promise<ConnectedApp[]> {
    const rows = await db('connected_apps').orderBy('sort_order').orderBy('name') as AppRow[];
    return rows.map(rowToApp);
  },

  /**
   * Persist a new display order for (a subset of) the connected apps: each
   * id in `orderedIds` gets `sort_order` set to its index. Ids not in the
   * app's current set are ignored; ids not present in `orderedIds` keep
   * their existing `sort_order` (so a stale/partial payload cannot silently
   * drop apps to the top).
   */
  async reorderApps(orderedIds: number[]): Promise<void> {
    const existing = new Set((await db('connected_apps').select('id') as Array<{ id: number }>).map(r => r.id));
    await db.transaction(async (trx) => {
      for (let i = 0; i < orderedIds.length; i++) {
        const id = orderedIds[i];
        if (!existing.has(id)) continue;
        await trx('connected_apps').where({ id }).update({ sort_order: i, updated_at: new Date() });
      }
    });
  },

  async getAppById(id: number): Promise<ConnectedApp | null> {
    const row = await db('connected_apps').where({ id }).first() as AppRow | undefined;
    if (!row) return null;
    return rowToApp(row);
  },

  /**
   * Resolve the active app authenticated by a server-to-server Bearer (its API
   * key — the secret, never the public client id).
   *
   * Matched in memory with constant-time comparisons, like getAppByClientId:
   * the presented secret is never bound into SQL (knex inlines bindings in its
   * error messages, which end up in the logs) and a mismatch does not answer
   * faster than a match. connected_apps only holds a few rows.
   */
  async getAppByApiKey(apiKey: unknown): Promise<AppRow | null> {
    if (typeof apiKey !== 'string' || apiKey.length === 0 || apiKey.length > 512) return null;
    const rows = await db('connected_apps').where({ is_active: true }) as AppRow[];
    return rows.find(row => typeof row.api_key === 'string' && row.api_key.length > 0 && safeEqual(row.api_key, apiKey)) ?? null;
  },

  /**
   * Origins a browser may be sent back to for this app by /authorize: the
   * origin of its registered base URL, plus any extra origin the operator
   * allowed for it (OAUTH_EXTRA_REDIRECT_ORIGINS). Loopback (desktop / native
   * flow) is handled by the caller.
   */
  redirectOriginsFor(row: Pick<AppRow, 'id' | 'base_url'>): string[] {
    const own = httpOrigin(row.base_url);
    return [...(own ? [own] : []), ...extraRedirectOrigins(row.id)];
  },

  /**
   * Every origin Obligate may send a browser to without naming an app (the
   * /logout redirect): the active apps' base URL origins, the operator's extra
   * origins, and Obligate's own public origin.
   */
  async knownBrowserOrigins(): Promise<Set<string>> {
    const rows = await db('connected_apps').where({ is_active: true }).select('base_url') as Array<{ base_url: string }>;
    const set = new Set<string>();
    for (const r of rows) {
      const o = httpOrigin(r.base_url);
      if (o) set.add(o);
    }
    for (const o of allExtraRedirectOrigins()) set.add(o);
    const self = httpOrigin(process.env.OBLIGATE_PUBLIC_URL || process.env.CLIENT_ORIGIN || '');
    if (self) set.add(self);
    return set;
  },

  /**
   * The Bearer Obligate presents when IT calls this app (sso-user-sync,
   * app-info, dashboard-stats): the app's inbound secret when one is set,
   * otherwise its API key (the historical behaviour).
   *
   * Null when a set inbound secret cannot be unsealed (ENCRYPTION_KEY changed):
   * the call is then skipped — falling back to the API key would only get a
   * 401 from an app that expects the secret, and would send the key to it.
   */
  outboundBearer(row: Pick<AppRow, 'id' | 'name' | 'api_key' | 'inbound_secret'>): string | null {
    if (!row.inbound_secret) return row.api_key;
    try {
      return unsealSecret(row.inbound_secret);
    } catch (err) {
      logger.error({ appId: row.id, appName: row.name, err: (err as Error)?.message },
        'connected app: cannot unseal its inbound secret (ENCRYPTION_KEY changed?) — call skipped; generate a new inbound secret');
      return null;
    }
  },

  /**
   * Generate a new inbound secret for an app, PENDING: Obligate keeps
   * presenting its current Bearer (API key, or the active inbound secret) until
   * activateInboundSecret() has checked that the app accepts the new one.
   * Returns it in clear, ONCE; null when the app does not exist.
   */
  async generateInboundSecret(id: number): Promise<string | null> {
    const secret = generateToken(32);
    const count = await db('connected_apps')
      .where({ id })
      .update({ inbound_secret_pending: sealSecret(secret), updated_at: new Date() });
    return count === 0 ? null : secret;
  },

  /**
   * Switch to the pending inbound secret once the app accepts it: Obligate
   * calls the app's GET /api/auth/app-info with it and promotes it only on a
   * 2xx { success: true }. Anything else leaves everything as it was (the
   * current Bearer stays in use) and says why.
   */
  async activateInboundSecret(id: number): Promise<
    | { ok: true }
    | { ok: false; reason: 'not_found' | 'no_pending' | 'unreadable' | 'refused' | 'unreachable'; httpStatus?: number }
  > {
    const row = await db('connected_apps').where({ id }).first() as AppRow | undefined;
    if (!row) return { ok: false, reason: 'not_found' };
    if (!row.inbound_secret_pending) return { ok: false, reason: 'no_pending' };
    let pending: string;
    try {
      pending = unsealSecret(row.inbound_secret_pending);
    } catch {
      return { ok: false, reason: 'unreadable' };
    }
    let status = 0;
    let success = false;
    try {
      const res = await fetch(`${row.base_url}/api/auth/app-info`, {
        headers: { Authorization: `Bearer ${pending}` },
        // A redirect is a misconfigured base URL: never followed with the secret.
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
      });
      status = res.status;
      try { success = ((await res.json()) as { success?: unknown } | null)?.success === true; } catch { success = false; }
    } catch {
      return { ok: false, reason: 'unreachable' };
    }
    if (status < 200 || status >= 300 || !success) return { ok: false, reason: 'refused', httpStatus: status };
    const n = await db('connected_apps')
      .where({ id, inbound_secret_pending: row.inbound_secret_pending })
      .update({ inbound_secret: row.inbound_secret_pending, inbound_secret_pending: null, updated_at: new Date() });
    return n > 0 ? { ok: true } : { ok: false, reason: 'no_pending' };
  },

  /** Remove the inbound secret (active and pending) of an app: Obligate presents its API key again. */
  async clearInboundSecret(id: number): Promise<boolean> {
    const count = await db('connected_apps')
      .where({ id })
      .update({ inbound_secret: null, inbound_secret_pending: null, updated_at: new Date() });
    return count > 0;
  },

  /**
   * Resolve the active app named by the client_id of a browser-facing
   * /authorize request.
   *
   * Accepted forms, tried in this order:
   *   1. publicClientId(api_key), sent by migrated apps;
   *   2. the raw API key itself (legacy, deprecated): apps not yet migrated
   *      still send it, which exposes their secret in the browser URL. Every
   *      such use is recorded on the app (raw_client_id_last_seen_at / _uses,
   *      reset by a key rotation): the key is then treated as public (no
   *      delegation mint for that app, "rotate the key" on the Connected Apps
   *      page), and OAUTH_ACCEPT_RAW_CLIENT_ID can refuse the form per app type.
   * A raw key can itself be 64 hex chars, hence the hashed form goes first.
   *
   * Both forms are matched in memory with constant-time comparisons rather
   * than with a WHERE clause: the presented value is never bound into SQL, so
   * a raw key can't end up in a knex error message (knex inlines bindings
   * there) and from there in the logs. connected_apps only holds a few rows.
   */
  async lookupClientId(clientId: string): Promise<ClientIdLookup> {
    if (clientId.length > 512) return { app: null, reason: 'unknown' };
    const rows = await db('connected_apps').where({ is_active: true }) as AppRow[];

    const byPublicId = rows.find(row => safeEqual(publicClientId(row.api_key), clientId));
    if (byPublicId) return { app: byPublicId, form: 'public' };

    const byRawKey = rows.find(row => safeEqual(row.api_key, clientId));
    if (!byRawKey) return { app: null, reason: 'unknown' };

    // The key went through a browser: recorded durably, refused or not.
    try {
      await db('connected_apps').where({ id: byRawKey.id }).update({
        raw_client_id_last_seen_at: new Date(),
        raw_client_id_uses: db.raw('raw_client_id_uses + 1'),
      });
    } catch (err) {
      logger.error({ appId: byRawKey.id, err: (err as Error)?.message }, 'authorize: could not record the raw client_id use');
    }
    // Never log the presented value itself: here it IS the app's API key
    if (!rawClientIdAccepted(byRawKey.app_type)) {
      logger.error({ appId: byRawKey.id, appName: byRawKey.name, appType: byRawKey.app_type },
        'authorize: raw API key sent as client_id REFUSED (OAUTH_ACCEPT_RAW_CLIENT_ID) — the app must send sha256(api_key); rotate its key, it went through a browser');
      return { app: null, reason: 'raw_refused', appId: byRawKey.id };
    }
    if (!legacyClientIdWarned.has(byRawKey.id)) {
      legacyClientIdWarned.add(byRawKey.id);
      logger.warn({ appId: byRawKey.id, appName: byRawKey.name },
        'authorize: app sent its raw API key as client_id (legacy) — migrate it to sha256(api_key) and rotate the key');
    }
    return { app: byRawKey, form: 'raw' };
  },

  /** lookupClientId, the app only (null when unknown or refused). */
  async getAppByClientId(clientId: string): Promise<AppRow | null> {
    return (await this.lookupClientId(clientId)).app;
  },

  async createApp(data: {
    appType: AppType;
    name: string;
    baseUrl: string;
    icon?: string | null;
    color?: string | null;
  }): Promise<ConnectedApp & { apiKey: string }> {
    const apiKey = generateToken(32);
    const [row] = await db('connected_apps')
      .insert({
        app_type: data.appType,
        name: data.name,
        base_url: data.baseUrl.replace(/\/$/, ''),
        api_key: apiKey,
        icon: data.icon ?? null,
        color: data.color ?? null,
        is_active: true,
      })
      .returning('*') as AppRow[];
    return { ...rowToApp(row), apiKey };
  },

  async updateApp(id: number, data: {
    name?: string;
    baseUrl?: string;
    icon?: string | null;
    color?: string | null;
    isActive?: boolean;
    thirdParty?: boolean;
  }): Promise<ConnectedApp | null> {
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (data.name !== undefined) update.name = data.name;
    if (data.baseUrl !== undefined) update.base_url = data.baseUrl.replace(/\/$/, '');
    if (data.icon !== undefined) update.icon = data.icon;
    if (data.color !== undefined) update.color = data.color;
    if (data.isActive !== undefined) update.is_active = data.isActive;
    if (typeof data.thirdParty === 'boolean') update.third_party = data.thirdParty;

    const [row] = await db('connected_apps')
      .where({ id })
      .update(update)
      .returning('*') as AppRow[];
    if (!row) return null;
    return rowToApp(row);
  },

  async deleteApp(id: number): Promise<boolean> {
    const count = await db('connected_apps').where({ id }).del();
    return count > 0;
  },

  /**
   * New API key. The exposure record of the old one is reset (the new key has
   * never been through a browser): delegation mints work again for the app
   * once it presents the new key.
   */
  async regenerateApiKey(id: number): Promise<string | null> {
    const apiKey = generateToken(32);
    const now = new Date();
    const count = await db('connected_apps')
      .where({ id })
      .update({
        api_key: apiKey,
        api_key_rotated_at: now,
        raw_client_id_last_seen_at: null,
        raw_client_id_uses: 0,
        updated_at: now,
      });
    if (count === 0) return null;
    legacyClientIdWarned.delete(id);
    return apiKey;
  },

  /**
   * Get active apps list for cross-app navigation (no sensitive data).
   *
   * `callerAppId` — when given (the Bearer-authenticated caller's own
   * `connected_apps.id`) — marks that caller's own entry with `self: true` so
   * an app with several registered instances (e.g. several Obliguards) can
   * identify which one it is without an APP_URL pin or an "exactly one
   * registered" heuristic. Omitted (not `false`) on every other entry, and
   * entirely absent when `callerAppId` isn't passed, so callers that predate
   * this field see an unchanged response.
   */
  async getConnectedAppsPublic(callerAppId?: number): Promise<Array<{ appType: string; name: string; baseUrl: string; icon: string; color: string | null; thirdParty: boolean; self?: true }>> {
    const rows = await db('connected_apps')
      .where({ is_active: true })
      .orderBy('sort_order').orderBy('name')
      .select('id', 'app_type', 'name', 'base_url', 'icon', 'color', 'third_party') as Array<{
        id: number; app_type: string; name: string; base_url: string; icon: string | null; color: string | null; third_party: boolean;
      }>;
    return rows.map(r => ({
      appType: r.app_type,
      name: r.name,
      baseUrl: r.base_url,
      icon: effectiveIcon(r.base_url, r.icon),
      color: r.color,
      thirdParty: !!r.third_party,
      ...(callerAppId !== undefined && r.id === callerAppId ? { self: true as const } : {}),
    }));
  },

  /**
   * Get active apps list filtered to those the given user has access to
   * via at least one `permission_group_app_mappings` row. Platform admins
   * (users.role = 'admin') get the full unfiltered list — their access is
   * implicit and not materialised as explicit mappings.
   *
   * Used by app servers to populate the topbar app switcher so apps the
   * user has no permission on are hidden entirely instead of being shown
   * as inert buttons.
   */
  async getConnectedAppsForUser(userId: number, callerAppId?: number): Promise<Array<{ appType: string; name: string; baseUrl: string; icon: string; color: string | null; thirdParty: boolean; self?: true }>> {
    const user = await db('users').where({ id: userId }).select('role').first() as { role: string } | undefined;
    if (!user) return [];
    if (user.role === 'admin') return this.getConnectedAppsPublic(callerAppId);

    const rows = await db('connected_apps as ca')
      .where('ca.is_active', true)
      .whereIn('ca.id', function () {
        this.select('pgam.app_id')
          .from('permission_group_app_mappings as pgam')
          .join('user_permission_groups as upg', 'upg.group_id', 'pgam.group_id')
          .where('upg.user_id', userId);
      })
      .orderBy('ca.sort_order').orderBy('ca.name')
      .select('ca.id', 'ca.app_type', 'ca.name', 'ca.base_url', 'ca.icon', 'ca.color', 'ca.third_party') as Array<{
        id: number; app_type: string; name: string; base_url: string; icon: string | null; color: string | null; third_party: boolean;
      }>;
    return rows.map(r => ({
      appType: r.app_type,
      name: r.name,
      baseUrl: r.base_url,
      icon: effectiveIcon(r.base_url, r.icon),
      color: r.color,
      thirdParty: !!r.third_party,
      ...(callerAppId !== undefined && r.id === callerAppId ? { self: true as const } : {}),
    }));
  },
};
