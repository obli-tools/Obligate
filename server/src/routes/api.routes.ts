import { Router } from 'express';
import { appService } from '../services/app.service';
import { preferencesService } from '../services/preferences.service';
import { permissionGroupService } from '../services/permissionGroup.service';
import { logger } from '../utils/logger';
import { parsePositiveInt } from '../utils/crypto';
import { isSafeAppPath } from '../utils/redirect';
import { db } from '../db';

export const apiRoutes = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Server-to-server API, authenticated by an app's API key (Bearer).
//
// Treat every request here as coming from whoever holds THAT key — several
// apps still send it to browsers as their client_id, so it may be public.
// Hence each route stays within the calling app: its own users, its own device
// links, its own info. Nothing here reads or writes another app's data, and
// no user id is looked up before being parsed to its one canonical form.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Middleware: validate Bearer API key for server-to-server calls.
 * Exported so delegation.routes reuses this exact check rather than keeping a
 * second copy: two implementations of an authentication gate drift apart.
 *
 * Only the raw API key authenticates. The public client id (sha256 of the
 * key) never does: it is printed in browser URLs.
 */
export async function requireAppBearer(req: any, res: any, next: any) {
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
    req.appId = app.id;
    req.appType = app.app_type;
    next();
  } catch (err) {
    logger.error(err, 'App bearer check failed');
    res.status(500).json({ success: false, error: 'Authentication failed' });
  }
}

/** Device UUIDs are free-form across apps (UUIDs, machine ids): bounded, printable, no spaces. */
function isDeviceUuid(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u0020\u007f-\u009f]/.test(value);
}

/**
 * GET /api/apps/connected
 * Returns active connected apps (for cross-app navigation buttons).
 *
 * If the optional `?userId=<obligateUserId>` query param is supplied, the
 * list is filtered to only the apps that user has access to via at least
 * one permission_group_app_mapping (platform admins get the full list) —
 * and only for a user of the CALLING app: for anyone else the answer is an
 * empty list (which apps a stranger may use is not the caller's business).
 * Without the param, returns every active app (names and public URLs only) —
 * preserves the legacy behaviour for callers that haven't been updated yet.
 *
 * The entry for the calling app itself (resolved from its Bearer key, same
 * as any other route here) is marked `self: true` — lets an app type with
 * several registered instances (several Obliguards, say) tell which one it
 * is without an APP_URL pin or an "exactly one registered" heuristic.
 */
apiRoutes.get('/connected', requireAppBearer, async (req: any, res) => {
  try {
    const userId = req.query.userId === undefined ? null : parsePositiveInt(req.query.userId);
    if (userId === null) {
      res.json({ success: true, data: await appService.getConnectedAppsPublic(req.appId) });
      return;
    }
    if (!(await permissionGroupService.belongsToApp(userId, req.appId))) {
      res.json({ success: true, data: [] });
      return;
    }
    res.json({ success: true, data: await appService.getConnectedAppsForUser(userId, req.appId) });
  } catch (err) {
    logger.error(err, 'Failed to list connected apps');
    res.status(500).json({ success: false, error: 'Failed to list apps' });
  }
});

/**
 * GET /api/apps/users
 * Directory export for the calling app: every Obligate user who has access to
 * THIS app (via a permission-group→app mapping, or platform admin), each with
 * the same { role, tenants, teams } an SSO login would assert. Lets an app
 * pre-provision its roster without waiting for each user's first login.
 * Scoped to the calling app by construction (req.appId only).
 */
apiRoutes.get('/users', requireAppBearer, async (req: any, res) => {
  try {
    // Candidates: users mapped to this app via a permission group, plus platform
    // admins (implicit access, never materialised as explicit mappings).
    const mappedIds = await db('user_permission_groups as upg')
      .join('permission_group_app_mappings as pgam', 'pgam.group_id', 'upg.group_id')
      .where('pgam.app_id', req.appId)
      .distinct('upg.user_id')
      .pluck('upg.user_id') as number[];
    const adminIds = await db('users')
      .where({ role: 'admin', is_active: true })
      .pluck('id') as number[];
    const ids = Array.from(new Set([...mappedIds, ...adminIds]));
    if (ids.length === 0) { res.json({ success: true, data: [] }); return; }

    const users = await db('users')
      .whereIn('id', ids)
      .andWhere('is_active', true)
      .select('id', 'username', 'email', 'display_name', 'auth_source', 'role') as Array<{
        id: number; username: string; email: string | null; display_name: string | null;
        auth_source: string; role: string;
      }>;
    const links = await db('user_app_links')
      .where({ app_id: req.appId })
      .whereIn('user_id', ids)
      .select('user_id', 'enabled', 'remote_user_id') as Array<{
        user_id: number; enabled: boolean; remote_user_id: number | null;
      }>;
    const linkMap = new Map(links.map(l => [l.user_id, l]));

    const out = [];
    for (const u of users) {
      const link = linkMap.get(u.id);
      if (link && !link.enabled) continue; // explicitly disabled on this app
      const resolved = await permissionGroupService.resolveForUserAndApp(u.id, req.appId);
      // Platform admins get 'admin' implicitly even without a mapping (mirrors login).
      const role = u.role === 'admin' ? 'admin' : resolved.role;
      if (!role) continue; // no effective access → not part of this app's roster
      out.push({
        obligateUserId: u.id,
        username: u.username,
        email: u.email,
        displayName: u.display_name,
        role,
        tenants: resolved.tenants,
        teams: resolved.teams,
        authSource: u.auth_source === 'ldap' ? 'ldap' : 'local',
        linkedLocalUserId: link?.remote_user_id ?? null,
      });
    }
    res.json({ success: true, data: out });
  } catch (err) {
    logger.error(err, 'Failed to list app users');
    res.status(500).json({ success: false, error: 'Failed to list users' });
  }
});

/**
 * POST /api/apps/self-info
 * App reports its own branding (called on startup, alongside the schema
 * syncs). Body: { color?: string, icon?: string }.
 *   color — the app's accent color is its own: the announced value always
 *           wins, so a rebrand propagates to every switcher at the next
 *           restart with nothing to set by hand in AppsPage.
 *   icon  — only fills an unset icon (an admin URL override is kept).
 * Scoped to the calling app (req.appId from its Bearer key): an app can only
 * ever describe itself.
 */
apiRoutes.post('/self-info', requireAppBearer, async (req: any, res) => {
  try {
    const { color, icon } = req.body as { color?: unknown; icon?: unknown };
    const update: Record<string, string> = {};
    if (typeof color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(color)) update.color = color;
    if (typeof icon === 'string' && icon.length > 0 && icon.length <= 2048) update.icon = icon;
    if (Object.keys(update).length === 0) { res.json({ success: true }); return; }
    if (update.color) await db('connected_apps').where({ id: req.appId }).update({ color: update.color, updated_at: new Date() });
    if (update.icon) await db('connected_apps').where({ id: req.appId }).whereNull('icon').update({ icon: update.icon, updated_at: new Date() });
    res.json({ success: true });
  } catch (err) {
    logger.error(err, 'Failed to sync app self-info');
    res.status(500).json({ success: false, error: 'Failed to sync self-info' });
  }
});

/**
 * POST /api/apps/sync-preference-schemas
 * App registers its specific preference fields (called on app startup or admin config change).
 */
apiRoutes.post('/sync-preference-schemas', requireAppBearer, async (req: any, res) => {
  try {
    const schemas = req.body.schemas as Array<{
      key: string; label: string; fieldType: string;
      options?: string[] | null; defaultValue?: string | null; sortOrder?: number;
    }>;
    if (!Array.isArray(schemas)) {
      res.status(400).json({ success: false, error: 'Missing schemas array' });
      return;
    }
    await preferencesService.syncSchemas(req.appId, schemas.map((s, i) => ({
      key: s.key,
      label: s.label,
      fieldType: s.fieldType as 'text' | 'select' | 'boolean' | 'number',
      options: s.options ?? null,
      defaultValue: s.defaultValue ?? null,
      sortOrder: s.sortOrder ?? i,
    })));
    res.json({ success: true });
  } catch (err) {
    logger.error(err, 'Failed to sync preference schemas');
    res.status(500).json({ success: false, error: 'Failed to sync schemas' });
  }
});

/**
 * A local-account pointer (user_app_links.remote_user_id) may be CHANGED —
 * rewritten or cleared — only this long after an SSO sign-in of that user on
 * that app, and only by the FIRST report after that sign-in: the app's own
 * callback reports right after the code exchange (first provisioning,
 * re-provisioning of a deleted local account, or the same id again) and so
 * closes the window (remote_user_reported_at). The code exchange is the only
 * writer of last_login_at, so an app key alone cannot open a window for a
 * user it does not sign in as, nor reuse the one the app already used.
 *
 * Kept SHORT (60 s): the app's own report comes
 * within a second or two of the exchange (same callback request). Apps that
 * do not report at every sign-in (ObliDesk, Oblifield: only when they
 * provision) leave the window open — and those two still trust the pointer
 * (sso-user-sync remoteUserId) — so a key holder polling for a user's sign-in
 * must hit this short window, each miss being a logged incident.
 */
export const POINTER_CHANGE_WINDOW_MS = 60 * 1000;

function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === '23505';
}

/**
 * POST /api/apps/report-provision
 * App reports the local user ID after provisioning an Obligate user.
 * Body: { obligateUserId, remoteUserId }  (remoteUserId 0 / null = the local
 * account was deleted: the stale pointer is cleared)
 *
 * The key may be public (apps still sending it as client_id), so the pointer
 * is only this app's claim about ITSELF, and it is guarded:
 *   - setting one requires the user to be active and entitled to the calling
 *     app (the users GET /api/apps/users lists);
 *   - a pointer not set yet may be set at any time (pre-provisioning from the
 *     roster, or an app repairing a missing pointer);
 *   - a CHANGE of an existing pointer (another value, or clearing) is
 *     accepted only by the first report within POINTER_CHANGE_WINDOW_MS after
 *     an SSO sign-in of that user on that app (the app's own callback); any
 *     other → 409 pointer_locked, logged as an incident;
 *   - one local account belongs to one Obligate user (unique per app): a
 *     local id already linked to another user → 409 local_account_taken,
 *     logged as an incident;
 *   - reporting the value already recorded is a no-op (200) — and, like any
 *     accepted report, it closes the window of the last sign-in;
 *   - clearing never creates a link.
 * The pointer is never returned in the code exchange any more
 * (linkedLocalUserId is always null): apps resolve their local account from
 * their own records.
 */
apiRoutes.post('/report-provision', requireAppBearer, async (req: any, res) => {
  try {
    const body = (req.body ?? {}) as { obligateUserId?: unknown; remoteUserId?: unknown };
    const obligateUserId = parsePositiveInt(body.obligateUserId);
    if (obligateUserId === null) {
      res.status(400).json({ success: false, error: 'Missing or invalid obligateUserId' });
      return;
    }
    const clear = body.remoteUserId === undefined || body.remoteUserId === null || body.remoteUserId === 0 || body.remoteUserId === '0';
    const remoteUserId = clear ? null : parsePositiveInt(body.remoteUserId);
    if (!clear && remoteUserId === null) {
      res.status(400).json({ success: false, error: 'Invalid remoteUserId' });
      return;
    }

    const m = await permissionGroupService.getAppMembership(obligateUserId, req.appId);
    const current = m.link?.remoteUserId ?? null;
    const now = Date.now();
    const lastLoginAt = m.link?.lastLoginAt ? new Date(m.link.lastLoginAt).getTime() : null;
    const reportedAt = m.link?.remoteUserReportedAt ? new Date(m.link.remoteUserReportedAt).getTime() : null;
    // The window of the last SSO sign-in, still unused by any accepted report.
    const freshSignIn = lastLoginAt !== null && now - lastLoginAt >= 0 && now - lastLoginAt <= POINTER_CHANGE_WINDOW_MS
      && (reportedAt === null || reportedAt < lastLoginAt);
    const incident = (reason: string, extra: Record<string, unknown> = {}) => logger.error(
      { appId: req.appId, appType: req.appType, obligateUserId, current, requested: remoteUserId, reason, ip: req.ip, ...extra },
      'report-provision REFUSED (incident): attempt to repoint or clear the local account of an Obligate user outside the report of its SSO sign-in — the app key may be in the wrong hands',
    );
    const reportedNow = { remote_user_reported_at: new Date(now) };

    if (remoteUserId === null) {
      // remoteUserId=0 means the local user was deleted — clear the stale link.
      if (!m.link || current === null) { res.json({ success: true }); return; }
      if (!freshSignIn) {
        incident('clear_outside_sign_in');
        res.status(409).json({ success: false, code: 'pointer_locked', error: 'The local account link can only change right after an SSO sign-in of this user' });
        return;
      }
      await db('user_app_links')
        .where({ user_id: obligateUserId, app_id: req.appId })
        .update({ remote_user_id: null, ...reportedNow });
      logger.warn({ appId: req.appId, obligateUserId, previous: current }, 'report-provision: local account pointer cleared after an SSO sign-in');
      res.json({ success: true });
      return;
    }

    if (!m.user || !m.user.isActive || !m.entitled || (m.link && !m.link.enabled)) {
      logger.warn({ appId: req.appId, obligateUserId, reason: !m.user ? 'unknown' : !m.user.isActive ? 'inactive' : m.link && !m.link.enabled ? 'disabled_on_app' : 'not_entitled' },
        'report-provision refused: not a user of the calling app');
      res.status(403).json({ success: false, error: 'User has no access to this app' });
      return;
    }
    if (current === remoteUserId) {
      // The app confirms its pointer: that closes the window of the sign-in.
      await db('user_app_links').where({ user_id: obligateUserId, app_id: req.appId }).update(reportedNow);
      res.json({ success: true });
      return;
    }

    // A pointer not set yet may be set (pre-provisioning, or an app repairing
    // a missing one); an existing one only moves right after an SSO sign-in
    // of that user on this app.
    if (current !== null && !freshSignIn) {
      incident('rewrite_outside_sign_in');
      res.status(409).json({ success: false, code: 'pointer_locked', error: 'The local account link can only change right after an SSO sign-in of this user' });
      return;
    }

    try {
      // Upsert (not update): a user pre-provisioned via GET /api/apps/users has
      // no link row yet, so we must create it here for the mapping to persist.
      await db('user_app_links')
        .insert({ user_id: obligateUserId, app_id: req.appId, enabled: true, remote_user_id: remoteUserId, ...reportedNow })
        .onConflict(['user_id', 'app_id'])
        .merge({ remote_user_id: remoteUserId, ...reportedNow });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const owner = await db('user_app_links').where({ app_id: req.appId, remote_user_id: remoteUserId }).first('user_id') as { user_id: number } | undefined;
      incident('local_account_taken', { linkedToObligateUserId: owner?.user_id ?? null });
      res.status(409).json({ success: false, code: 'local_account_taken', error: 'This local account is already linked to another Obligate user' });
      return;
    }
    if (current !== null) {
      logger.warn({ appId: req.appId, obligateUserId, previous: current, next: remoteUserId },
        'report-provision: local account pointer changed after an SSO sign-in (re-provisioned local account)');
    }

    res.json({ success: true });
  } catch (err) {
    logger.error(err, 'Failed to report provision');
    res.status(500).json({ success: false, error: 'Failed to report provision' });
  }
});

/**
 * POST /api/devices/register
 * App registers a device UUID + path for cross-app linking.
 * Body: { uuid, path }. The path is appended to the app's base URL and shown
 * as a link by the OTHER apps: it must be a plain path (see isSafeAppPath —
 * single leading '/', no '//', '@', '\', control characters). 400 otherwise.
 */
apiRoutes.post('/register', requireAppBearer, async (req: any, res) => {
  try {
    const { uuid, path } = (req.body ?? {}) as { uuid?: unknown; path?: unknown };
    if (!uuid || !path) {
      res.status(400).json({ success: false, error: 'Missing uuid or path' });
      return;
    }
    if (!isDeviceUuid(uuid)) {
      res.status(400).json({ success: false, error: 'Invalid uuid' });
      return;
    }
    if (!isSafeAppPath(path)) {
      logger.warn({ appId: req.appId, path: typeof path === 'string' ? path.slice(0, 200) : typeof path },
        'device register refused: unsafe path');
      res.status(400).json({ success: false, error: 'Invalid path (must be a plain path starting with a single "/")' });
      return;
    }

    await db('device_links')
      .insert({ device_uuid: uuid, app_id: req.appId, app_path: path, updated_at: new Date() })
      .onConflict(['device_uuid', 'app_id'])
      .merge({ app_path: path, updated_at: new Date() });

    res.json({ success: true });
  } catch (err) {
    logger.error(err, 'Failed to register device');
    res.status(500).json({ success: false, error: 'Failed to register device' });
  }
});

/**
 * GET /api/apps/:id/remote-info — REMOVED (410).
 * It made Obligate call the app's /api/auth/app-info with the app's INBOUND
 * SECRET and hand the answer (tenants, teams, permission sets) to whoever
 * held the app key — the very reader the inbound secret keeps out. No app
 * uses it; the admin UI reads /api/admin/apps/:id/remote-info. Kept as an
 * explicit 410 so the path never falls through to anything else.
 */
apiRoutes.get('/:id/remote-info', (_req, res) => {
  res.status(410).json({ success: false, error: 'Removed: app info is only read by Obligate administrators' });
});

/**
 * GET /api/apps/user-preferences/:userId
 * Returns common + app-specific preferences for a given Obligate user.
 * Called by connected apps to sync preferences in real-time. Only for a user
 * of the calling app (404 otherwise, like an unknown id).
 */
apiRoutes.get('/user-preferences/:userId', requireAppBearer, async (req: any, res) => {
  try {
    const userId = parsePositiveInt(req.params.userId);
    if (userId === null) {
      res.status(400).json({ success: false, error: 'Invalid userId' });
      return;
    }
    if (!(await permissionGroupService.belongsToApp(userId, req.appId))) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    const [common, appPrefs] = await Promise.all([
      preferencesService.getCommonPreferences(userId),
      preferencesService.getAppPreferences(userId, req.appId),
    ]);

    res.json({ success: true, data: { ...common, appSpecific: appPrefs } });
  } catch (err) {
    logger.error(err, 'Failed to fetch user preferences');
    res.status(500).json({ success: false, error: 'Failed to fetch preferences' });
  }
});

/**
 * GET /api/devices/links?uuid=xxx
 * Returns ALL linked apps for a device UUID (excluding the calling app).
 * A stored path that is not a plain path (registered before the check) is
 * never served.
 */
apiRoutes.get('/links', requireAppBearer, async (req: any, res) => {
  try {
    const { uuid } = req.query as { uuid?: unknown };
    if (!uuid) {
      res.status(400).json({ success: false, error: 'Missing uuid' });
      return;
    }
    if (!isDeviceUuid(uuid)) {
      res.status(400).json({ success: false, error: 'Invalid uuid' });
      return;
    }

    const rows = await db('device_links as dl')
      .join('connected_apps as ca', 'ca.id', 'dl.app_id')
      .where({ 'dl.device_uuid': uuid, 'ca.is_active': true })
      .whereNot('dl.app_id', req.appId)
      .select('ca.app_type', 'ca.name', 'ca.base_url', 'ca.icon', 'ca.color', 'dl.app_path') as Array<{
        app_type: string; name: string; base_url: string; icon: string | null; color: string | null; app_path: string;
      }>;

    res.json({
      success: true,
      data: rows.filter(r => isSafeAppPath(r.app_path)).map(r => ({
        appType: r.app_type,
        name: r.name,
        url: `${r.base_url}${r.app_path}`,
        icon: r.icon,
        color: r.color,
      })),
    });
  } catch (err) {
    logger.error(err, 'Failed to resolve device links');
    res.status(500).json({ success: false, error: 'Failed to resolve links' });
  }
});

/**
 * GET /api/devices/link?uuid=xxx&target_app=obliguard
 * Resolve a device UUID to a URL on another app.
 */
apiRoutes.get('/link', requireAppBearer, async (req, res) => {
  try {
    const { uuid, target_app } = req.query as { uuid?: unknown; target_app?: unknown };
    if (!uuid || !target_app) {
      res.status(400).json({ success: false, error: 'Missing uuid or target_app' });
      return;
    }
    if (!isDeviceUuid(uuid) || typeof target_app !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/.test(target_app)) {
      res.status(400).json({ success: false, error: 'Invalid uuid or target_app' });
      return;
    }

    const links = await db('device_links as dl')
      .join('connected_apps as ca', 'ca.id', 'dl.app_id')
      .where({ 'dl.device_uuid': uuid, 'ca.app_type': target_app, 'ca.is_active': true })
      .select('ca.base_url', 'dl.app_path') as Array<{ base_url: string; app_path: string }>;
    const link = links.find(l => isSafeAppPath(l.app_path));

    if (!link) {
      res.json({ success: true, data: null });
      return;
    }

    res.json({ success: true, data: { url: `${link.base_url}${link.app_path}` } });
  } catch (err) {
    logger.error(err, 'Failed to resolve device link');
    res.status(500).json({ success: false, error: 'Failed to resolve device link' });
  }
});
