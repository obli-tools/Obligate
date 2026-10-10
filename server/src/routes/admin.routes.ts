import { Router } from 'express';
import { appService, normalizeBaseUrl, isValidAppTypeSlug, inboundSecretSupported, type AppRow } from '../services/app.service';
import { sessionService } from '../services/session.service';
import { authService } from '../services/auth.service';
import { permissionGroupService } from '../services/permissionGroup.service';
import { configService } from '../services/config.service';
import { ssoSyncService } from '../services/ssoSync.service';
import { ssoSyncQueue } from '../services/ssoSyncQueue.service';
import { parsePositiveInt } from '../utils/crypto';
import { twoFactorService } from '../services/twoFactor.service';
import { mailService } from '../services/mail.service';
import { requireAdmin } from '../middleware/auth';
import { db } from '../db';
import { logger } from '../utils/logger';

export const adminRoutes = Router();

// Routes are mounted under /admin with requireAuth only; admin-only handlers
// individually use the requireAdmin middleware. A few user-management
// endpoints accept non-admin users who have group-manager rights covering
// the target user — those endpoints do their own scope check inline.

function isAdmin(req: any): boolean {
  return req.session?.role === 'admin';
}

async function canActOnUser(req: any, targetUserId: number): Promise<boolean> {
  return permissionGroupService.canActOnUser(req.session.userId, req.session.role, targetUserId);
}

// ── Connected Apps CRUD (admin only) ─────────────────────────────────────────

adminRoutes.get('/apps', requireAdmin, async (_req, res) => {
  try {
    const apps = await appService.listApps();
    res.json({ success: true, data: apps });
  } catch (err) {
    logger.error(err, 'Failed to list apps');
    res.status(500).json({ success: false, error: 'Failed to list apps' });
  }
});

adminRoutes.post('/apps', requireAdmin, async (req, res) => {
  try {
    const { appType, name, icon, color } = req.body;
    if (!isValidAppTypeSlug(appType)) {
      res.status(400).json({ success: false, error: 'Invalid app type (lowercase letters, digits, dash, 2-32 chars)' });
      return;
    }
    // The base URL decides where /authorize may send authorization codes:
    // only a plain http(s) origin (+ optional path) is accepted.
    const baseUrl = normalizeBaseUrl(req.body?.baseUrl);
    if (!baseUrl) {
      res.status(400).json({ success: false, error: 'Invalid base URL (absolute http(s) URL, no credentials, query or fragment)' });
      return;
    }
    const app = await appService.createApp({ appType, name, baseUrl, icon, color });
    res.status(201).json({ success: true, data: app });
  } catch (err) {
    logger.error(err, 'Failed to create app');
    res.status(500).json({ success: false, error: 'Failed to create app' });
  }
});

/**
 * PUT /admin/apps/reorder
 * Body: { ids: number[] } — the connected app ids in the desired display
 * order (drag-and-drop in AppsPage). Declared before PUT /apps/:id so
 * "reorder" is never captured by :id. Every app across the suite that
 * renders from the dynamic `/api/apps/connected` feed picks up the new
 * order without a code change on its side.
 */
adminRoutes.put('/apps/reorder', requireAdmin, async (req, res) => {
  try {
    const { ids } = req.body as { ids?: unknown };
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200 || !ids.every(id => Number.isInteger(id) && id > 0)) {
      res.status(400).json({ success: false, error: 'ids must be a non-empty array of positive integers' });
      return;
    }
    await appService.reorderApps(ids as number[]);
    res.json({ success: true, data: await appService.listApps() });
  } catch (err) {
    logger.error(err, 'Failed to reorder apps');
    res.status(500).json({ success: false, error: 'Failed to reorder apps' });
  }
});

adminRoutes.put('/apps/:id', requireAdmin, async (req: any, res) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (id === null) { res.status(400).json({ success: false, error: 'Invalid app id' }); return; }
    const patch = { ...(req.body ?? {}) };
    if (patch.baseUrl !== undefined) {
      const baseUrl = normalizeBaseUrl(patch.baseUrl);
      if (!baseUrl) {
        res.status(400).json({ success: false, error: 'Invalid base URL (absolute http(s) URL, no credentials, query or fragment)' });
        return;
      }
      patch.baseUrl = baseUrl;
    }
    const before = patch.baseUrl !== undefined ? await appService.getAppById(id) : null;
    const app = await appService.updateApp(id, patch);
    if (!app) {
      res.status(404).json({ success: false, error: 'App not found' });
      return;
    }
    if (before && before.baseUrl !== app.baseUrl) {
      // The base URL decides where /authorize sends codes: every change is traced.
      logger.warn({ appId: id, from: before.baseUrl, to: app.baseUrl, byUserId: req.session.userId }, 'connected app: base URL changed');
    }
    res.json({ success: true, data: app });
  } catch (err) {
    logger.error(err, 'Failed to update app');
    res.status(500).json({ success: false, error: 'Failed to update app' });
  }
});

adminRoutes.delete('/apps/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const deleted = await appService.deleteApp(id);
    if (!deleted) {
      res.status(404).json({ success: false, error: 'App not found' });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    logger.error(err, 'Failed to delete app');
    res.status(500).json({ success: false, error: 'Failed to delete app' });
  }
});

adminRoutes.get('/apps/:id/dashboard-stats', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const app = await db('connected_apps').where({ id, is_active: true }).first() as AppRow | undefined;
    if (!app) { res.json({ success: true, data: null }); return; }
    // The app's inbound secret when one is set, else its API key (A6)
    const bearer = appService.outboundBearer(app);
    if (!bearer) { res.json({ success: true, data: null }); return; }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(`${app.base_url}/api/auth/dashboard-stats`, {
      headers: { 'Authorization': `Bearer ${bearer}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) { res.json({ success: true, data: null }); return; }
    const data = await response.json() as { success: boolean; data?: unknown };
    res.json({ success: true, data: data.data ?? null });
  } catch {
    res.json({ success: true, data: null });
  }
});

adminRoutes.get('/apps/:id/remote-info', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const app = await db('connected_apps').where({ id, is_active: true }).first() as AppRow | undefined;
    if (!app) { res.json({ success: true, data: null }); return; }
    const bearer = appService.outboundBearer(app);
    if (!bearer) { res.json({ success: true, data: null }); return; }

    const response = await fetch(`${app.base_url}/api/auth/app-info`, {
      headers: { 'Authorization': `Bearer ${bearer}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) { res.json({ success: true, data: null }); return; }
    const data = await response.json() as { success: boolean; data?: unknown };
    res.json({ success: true, data: data.data ?? null });
  } catch (err) {
    logger.error(err, 'Failed to fetch remote app info');
    res.json({ success: true, data: null });
  }
});

/**
 * POST /admin/apps/:id/inbound-secret
 * Generate a new inbound secret — the secret Obligate presents when it calls
 * this app (sso-user-sync, app-info, dashboard-stats) instead of the app's
 * API key. Returned ONCE: { inboundSecret }. It is PENDING: Obligate keeps
 * presenting the current Bearer until POST .../inbound-secret/activate has
 * checked that the app accepts it (so a secret the app was never given
 * cannot cut Obligate off from it).
 * Only for the app types that can be configured with one
 * (INBOUND_SECRET_APP_TYPES, default obliance, oblimap, oblihub): any other
 * app compares the Bearer with its API key only → 400 inboundSecretUnsupported.
 */
adminRoutes.post('/apps/:id/inbound-secret', requireAdmin, async (req: any, res) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (id === null) { res.status(400).json({ success: false, error: 'Invalid app id' }); return; }
    const app = await appService.getAppById(id);
    if (!app) { res.status(404).json({ success: false, error: 'App not found' }); return; }
    if (!inboundSecretSupported(app.appType)) {
      res.status(400).json({
        success: false,
        code: 'inboundSecretUnsupported',
        error: `${app.appType} cannot be configured with an inbound secret: it only accepts its API key from Obligate`,
      });
      return;
    }
    const secret = await appService.generateInboundSecret(id);
    if (!secret) { res.status(404).json({ success: false, error: 'App not found' }); return; }
    logger.warn({ appId: id, byUserId: req.session.userId }, 'connected app: inbound secret generated (pending activation)');
    res.json({ success: true, data: { inboundSecret: secret, pending: true } });
  } catch (err) {
    logger.error(err, 'Failed to generate inbound secret');
    res.status(500).json({ success: false, error: 'Failed to generate inbound secret' });
  }
});

/**
 * POST /admin/apps/:id/inbound-secret/activate
 * Obligate calls the app's /api/auth/app-info with the PENDING secret; only a
 * 2xx { success: true } switches to it. Otherwise nothing changes:
 * 409 { code: 'inboundSecretRefused', httpStatus } (the app does not accept it
 * yet: set it on the app, restart it, retry), 502 inboundSecretUnreachable,
 * 409 noPendingInboundSecret, 500 inboundSecretUnreadable (ENCRYPTION_KEY).
 */
adminRoutes.post('/apps/:id/inbound-secret/activate', requireAdmin, async (req: any, res) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (id === null) { res.status(400).json({ success: false, error: 'Invalid app id' }); return; }
    const r = await appService.activateInboundSecret(id);
    if (r.ok) {
      logger.warn({ appId: id, byUserId: req.session.userId }, 'connected app: inbound secret activated (the app accepted it)');
      res.json({ success: true });
      return;
    }
    switch (r.reason) {
      case 'not_found':
        res.status(404).json({ success: false, error: 'App not found' });
        return;
      case 'no_pending':
        res.status(409).json({ success: false, code: 'noPendingInboundSecret', error: 'No inbound secret waiting for activation' });
        return;
      case 'unreadable':
        res.status(500).json({ success: false, code: 'inboundSecretUnreadable', error: 'The pending secret cannot be read (ENCRYPTION_KEY changed?): generate a new one' });
        return;
      case 'unreachable':
        res.status(502).json({ success: false, code: 'inboundSecretUnreachable', error: 'The app could not be reached at its base URL' });
        return;
      default:
        res.status(409).json({
          success: false,
          code: 'inboundSecretRefused',
          httpStatus: r.httpStatus ?? null,
          error: `The app did not accept the secret (HTTP ${r.httpStatus ?? '?'}): set it on the app, restart it, then activate again`,
        });
    }
  } catch (err) {
    logger.error(err, 'Failed to activate inbound secret');
    res.status(500).json({ success: false, error: 'Failed to activate inbound secret' });
  }
});

/**
 * DELETE /admin/apps/:id/inbound-secret
 * Remove it (active and pending): Obligate presents the app's API key again.
 */
adminRoutes.delete('/apps/:id/inbound-secret', requireAdmin, async (req: any, res) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (id === null) { res.status(400).json({ success: false, error: 'Invalid app id' }); return; }
    const ok = await appService.clearInboundSecret(id);
    if (!ok) { res.status(404).json({ success: false, error: 'App not found' }); return; }
    logger.warn({ appId: id, byUserId: req.session.userId }, 'connected app: inbound secret removed (API key presented again)');
    res.json({ success: true });
  } catch (err) {
    logger.error(err, 'Failed to clear inbound secret');
    res.status(500).json({ success: false, error: 'Failed to clear inbound secret' });
  }
});

adminRoutes.post('/apps/:id/regenerate-key', requireAdmin, async (req: any, res) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (id === null) { res.status(400).json({ success: false, error: 'Invalid app id' }); return; }
    const newKey = await appService.regenerateApiKey(id);
    if (!newKey) {
      res.status(404).json({ success: false, error: 'App not found' });
      return;
    }
    logger.warn({ appId: id, byUserId: req.session.userId }, 'connected app: API key regenerated (exposure record reset)');
    res.json({ success: true, data: { apiKey: newKey } });
  } catch (err) {
    logger.error(err, 'Failed to regenerate key');
    res.status(500).json({ success: false, error: 'Failed to regenerate key' });
  }
});

// ── Users CRUD (admin OR group manager with scope) ───────────────────────────

adminRoutes.get('/users', async (req: any, res) => {
  try {
    const [users, userGroups, activity] = await Promise.all([
      authService.listUsers(),
      permissionGroupService.getAllUserGroupAssignments(),
      authService.getAggregatedActivity(),
    ]);

    let scopedUsers = users;
    let actionableMap: Record<number, boolean> = {};
    if (!isAdmin(req)) {
      const [visible, actionable] = await Promise.all([
        permissionGroupService.getVisibleUserIds(req.session.userId),
        permissionGroupService.getActionableUserIds(req.session.userId),
      ]);
      const visibleSet = new Set(visible);
      const actionableSet = new Set(actionable);
      scopedUsers = users.filter(u => visibleSet.has(u.id));
      actionableMap = Object.fromEntries(scopedUsers.map(u => [u.id, actionableSet.has(u.id)]));
    } else {
      actionableMap = Object.fromEntries(users.map(u => [u.id, true]));
    }

    const activityMap: Record<number, { lastActivityAt: string; lastActivityApp: string } | null> = {};
    activity.forEach((v, k) => { activityMap[k] = v; });

    res.json({ success: true, data: scopedUsers, userGroups, activity: activityMap, actionable: actionableMap });
  } catch (err) {
    logger.error(err, 'Failed to list users');
    res.status(500).json({ success: false, error: 'Failed to list users' });
  }
});

adminRoutes.get('/users/:id/activity', async (req: any, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isFinite(userId)) {
      res.status(400).json({ success: false, error: 'Invalid user id' });
      return;
    }
    // Reading one's own activity is fine; canActOnUser (actions) excludes oneself.
    if (!isAdmin(req) && userId !== req.session.userId && !(await canActOnUser(req, userId))) {
      res.status(403).json({ success: false, error: 'Out of scope' });
      return;
    }

    const user = await db('users').where({ id: userId })
      .select('last_login_at', 'totp_enabled', 'require_2fa_setup', 'created_at').first() as {
        last_login_at: Date | null; totp_enabled: boolean; require_2fa_setup: boolean; created_at: Date;
      } | undefined;
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    const rows = await db('user_app_links as ual')
      .join('connected_apps as ca', 'ca.id', 'ual.app_id')
      .where({ 'ual.user_id': userId, 'ca.is_active': true })
      .select(
        'ca.id as app_id', 'ca.app_type', 'ca.name', 'ca.color',
        'ual.first_login_at', 'ual.last_login_at', 'ual.enabled', 'ual.remote_user_id',
      ) as Array<{
        app_id: number; app_type: string; name: string; color: string | null;
        first_login_at: Date | null; last_login_at: Date | null;
        enabled: boolean; remote_user_id: number | null;
      }>;

    res.json({
      success: true,
      data: {
        obligateLastLogin: user.last_login_at?.toISOString() ?? null,
        totpEnabled: user.totp_enabled,
        require2faSetup: user.require_2fa_setup ?? false,
        createdAt: user.created_at.toISOString(),
        apps: rows
          .sort((a, b) => (b.last_login_at?.getTime() ?? 0) - (a.last_login_at?.getTime() ?? 0))
          .map(r => ({
            appId: r.app_id,
            appType: r.app_type,
            name: r.name,
            color: r.color,
            firstLoginAt: r.first_login_at?.toISOString() ?? null,
            lastLoginAt: r.last_login_at?.toISOString() ?? null,
            enabled: r.enabled,
            linked: r.remote_user_id != null,
          })),
      },
    });
  } catch (err) {
    logger.error(err, 'Failed to fetch user activity');
    res.status(500).json({ success: false, error: 'Failed to fetch user activity' });
  }
});

adminRoutes.post('/users', async (req: any, res) => {
  try {
    const { username, email, displayName, password, role, groupIds } = req.body as {
      username: string; email?: string; displayName?: string; password?: string;
      role?: 'admin' | 'user'; groupIds?: number[];
    };

    const requestedGroupIds = Array.isArray(groupIds) ? groupIds : [];

    if (!isAdmin(req)) {
      // Manager: cannot create admin users, must provide ≥1 group, all groups must be managed.
      if (role === 'admin') {
        res.status(403).json({ success: false, error: 'Only admins can create admin users' });
        return;
      }
      if (requestedGroupIds.length === 0) {
        res.status(400).json({ success: false, error: 'At least one permission group is required' });
        return;
      }
      const managed = new Set(await permissionGroupService.getManagedGroupIds(req.session.userId));
      if (!requestedGroupIds.every(gid => managed.has(gid))) {
        res.status(403).json({ success: false, error: 'One or more groups are outside your management scope' });
        return;
      }
    }

    const user = await authService.createUser({ username, email, displayName, password, role });

    for (const gid of requestedGroupIds) {
      await permissionGroupService.assignUserToGroup(user.id, gid);
    }

    res.status(201).json({ success: true, data: user });
  } catch (err) {
    logger.error(err, 'Failed to create user');
    res.status(500).json({ success: false, error: 'Failed to create user' });
  }
});

adminRoutes.put('/users/:id', async (req: any, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const before = await authService.getUserById(id);
    if (!before) { res.status(404).json({ success: false, error: 'User not found' }); return; }

    if (!isAdmin(req)) {
      if (!(await canActOnUser(req, id))) {
        res.status(403).json({ success: false, error: 'Out of scope' });
        return;
      }
      // Managers can only toggle isActive; no role/email/displayName edits.
      const allowed: Record<string, unknown> = {};
      if (req.body.isActive !== undefined) allowed.isActive = req.body.isActive;
      if (Object.keys(allowed).length === 0) {
        res.status(403).json({ success: false, error: 'Managers can only toggle active status' });
        return;
      }
      req.body = allowed;
    }

    const user = await authService.updateUser(id, req.body);
    if (!user) { res.status(404).json({ success: false, error: 'User not found' }); return; }

    // A deactivation or a role change ends the account's Obligate sessions at
    // once (they carry the role; a deactivated admin must not keep acting).
    if (before.isActive !== user.isActive || before.role !== user.role) {
      await sessionService.afterAccountChangeBy(req, id);
    }
    if (before.isActive && !user.isActive) {
      ssoSyncService.pushUserChange(id, 'deactivate').catch(() => {});
    } else if (!before.isActive && user.isActive) {
      ssoSyncService.pushUserChange(id, 'reactivate').catch(() => {});
    }
    // An activation change moved mfa_epoch (DB trigger): deliver the queued
    // credentials-changed pushes now (persisted, retried — push queue).
    if (before.isActive !== user.isActive) void ssoSyncQueue.kick();
    if (before.role !== user.role) {
      ssoSyncService.pushUserChange(id, 'update-role', { role: user.role }).catch(() => {});
    }

    res.json({ success: true, data: user });
  } catch (err) {
    logger.error(err, 'Failed to update user');
    res.status(500).json({ success: false, error: 'Failed to update user' });
  }
});

adminRoutes.put('/users/:id/password', async (req: any, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!isAdmin(req) && !(await canActOnUser(req, id))) {
      res.status(403).json({ success: false, error: 'Out of scope' });
      return;
    }
    const { password } = req.body as { password?: string };
    const cfg = await configService.getAll();
    if (!password || password.length < cfg.minPasswordLength) { res.status(400).json({ success: false, error: `Password too short (min ${cfg.minPasswordLength} chars)` }); return; }
    const ok = await authService.changePassword(id, password);
    if (!ok) { res.status(404).json({ success: false, error: 'User not found' }); return; }
    // Every Obligate session of the account ends (the acting one is kept and
    // refreshed when an admin changes their own password here).
    await sessionService.afterAccountChangeBy(req, id);
    void ssoSyncQueue.kick(); // mfa_epoch moved (DB trigger), credentials-changed queued
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to change password' });
  }
});

/**
 * POST /users/:id/2fa/reset
 * Clear the user's TOTP secret. The user must configure a new authenticator
 * at their next login (require_2fa_setup), and their sessions are dropped.
 */
adminRoutes.post('/users/:id/2fa/reset', async (req: any, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) { res.status(400).json({ success: false, error: 'Invalid user id' }); return; }
    if (!isAdmin(req) && !(await canActOnUser(req, id))) {
      res.status(403).json({ success: false, error: 'Out of scope' });
      return;
    }

    const ok = await twoFactorService.resetForUser(id);
    if (!ok) { res.status(404).json({ success: false, error: 'User not found' }); return; }

    logger.warn({ targetUserId: id, byUserId: req.session.userId }, '2FA reset by administrator');
    void ssoSyncQueue.kick(); // mfa_epoch bumped, credentials-changed queued
    res.json({ success: true });
  } catch (err) {
    logger.error(err, 'Failed to reset 2FA');
    res.status(500).json({ success: false, error: 'Failed to reset 2FA' });
  }
});

adminRoutes.delete('/users/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (id === req.session.userId) { res.status(400).json({ success: false, error: 'Cannot delete yourself' }); return; }

    await ssoSyncService.pushUserChange(id, 'delete');

    const ok = await authService.deleteUser(id);
    if (!ok) { res.status(404).json({ success: false, error: 'User not found' }); return; }

    await db('user_app_links').where({ user_id: id }).del();
    await db('user_permission_groups').where({ user_id: id }).del();
    await sessionService.dropUserSessions(id);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to delete user' });
  }
});

// ── Permission Groups CRUD ───────────────────────────────────────────────────

// Listing is open to managers (they need to see their managed groups in the UI).
// Mutations are admin-only.
adminRoutes.get('/permission-groups', async (_req, res) => {
  try {
    const [groups, managers] = await Promise.all([
      permissionGroupService.listGroups(),
      permissionGroupService.getAllGroupManagers(),
    ]);
    res.json({ success: true, data: groups, managers });
  } catch (err) {
    logger.error(err, 'Failed to list permission groups');
    res.status(500).json({ success: false, error: 'Failed to list groups' });
  }
});

// "My managed groups" — used by the manager's user-create form to populate
// the (mandatory) group picker.
adminRoutes.get('/my-managed-groups', async (req: any, res) => {
  try {
    if (isAdmin(req)) {
      const groups = await permissionGroupService.listGroups();
      res.json({ success: true, data: groups });
      return;
    }
    const ids = await permissionGroupService.getManagedGroupIds(req.session.userId);
    if (ids.length === 0) { res.json({ success: true, data: [] }); return; }
    const groups = await permissionGroupService.listGroups();
    res.json({ success: true, data: groups.filter(g => ids.includes(g.id)) });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to list managed groups' });
  }
});

adminRoutes.post('/permission-groups', requireAdmin, async (req: any, res) => {
  try {
    const group = await permissionGroupService.createGroup({
      ...req.body,
      createdBy: req.session.userId,
    });
    res.status(201).json({ success: true, data: group });
  } catch (err) {
    logger.error(err, 'Failed to create permission group');
    res.status(500).json({ success: false, error: 'Failed to create group' });
  }
});

adminRoutes.put('/permission-groups/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const group = await permissionGroupService.updateGroup(id, req.body);
    if (!group) {
      res.status(404).json({ success: false, error: 'Group not found' });
      return;
    }
    res.json({ success: true, data: group });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to update group' });
  }
});

adminRoutes.delete('/permission-groups/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const deleted = await permissionGroupService.deleteGroup(id);
    if (!deleted) {
      res.status(404).json({ success: false, error: 'Group not found' });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to delete group' });
  }
});

// ── Permission Group Managers (admin only) ───────────────────────────────────

adminRoutes.get('/permission-groups/:id/managers', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const userIds = await permissionGroupService.getManagersForGroup(id);
    res.json({ success: true, data: userIds });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to list managers' });
  }
});

adminRoutes.put('/permission-groups/:id/managers', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { userIds } = req.body as { userIds?: number[] };
    if (!Array.isArray(userIds)) {
      res.status(400).json({ success: false, error: 'userIds array required' });
      return;
    }
    await permissionGroupService.setManagers(id, userIds);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to set managers' });
  }
});

// ── Permission Group Mappings (admin only) ───────────────────────────────────

adminRoutes.get('/permission-groups/:id/mappings', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const mappings = await permissionGroupService.getMappingsForGroup(id);
    res.json({ success: true, data: mappings });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to list mappings' });
  }
});

adminRoutes.post('/permission-groups/:id/mappings', requireAdmin, async (req, res) => {
  try {
    const groupId = parseInt(req.params.id, 10);
    const mapping = await permissionGroupService.addMapping({ groupId, ...req.body });
    res.status(201).json({ success: true, data: mapping });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to add mapping' });
  }
});

adminRoutes.put('/permission-groups/:gid/mappings/:mid', requireAdmin, async (req, res) => {
  try {
    const mid = parseInt(req.params.mid, 10);
    const { appRole } = req.body as { appRole?: string };
    const mapping = await permissionGroupService.updateMapping(mid, { appRole });
    if (!mapping) { res.status(404).json({ success: false, error: 'Mapping not found' }); return; }
    res.json({ success: true, data: mapping });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to update mapping' });
  }
});

adminRoutes.delete('/permission-groups/:gid/mappings/:mid', requireAdmin, async (req, res) => {
  try {
    const mid = parseInt(req.params.mid, 10);
    const deleted = await permissionGroupService.deleteMapping(mid);
    if (!deleted) {
      res.status(404).json({ success: false, error: 'Mapping not found' });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to delete mapping' });
  }
});

// ── User ↔ Group assignments (admin or manager-with-scope) ───────────────────

adminRoutes.get('/users/:id/groups', async (req: any, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    // Reading one's own groups is fine; canActOnUser (actions) excludes oneself.
    if (!isAdmin(req) && userId !== req.session.userId && !(await canActOnUser(req, userId))) {
      res.status(403).json({ success: false, error: 'Out of scope' });
      return;
    }
    const groups = await permissionGroupService.getGroupsForUser(userId);
    res.json({ success: true, data: groups });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to list user groups' });
  }
});

adminRoutes.post('/users/:uid/groups/:gid', async (req: any, res) => {
  try {
    const userId = parseInt(req.params.uid, 10);
    const groupId = parseInt(req.params.gid, 10);

    if (!isAdmin(req)) {
      // Manager: target must already be entirely in scope AND the new group must be managed.
      if (!(await canActOnUser(req, userId))) {
        res.status(403).json({ success: false, error: 'Out of scope' });
        return;
      }
      const managed = await permissionGroupService.getManagedGroupIds(req.session.userId);
      if (!managed.includes(groupId)) {
        res.status(403).json({ success: false, error: 'Group is outside your management scope' });
        return;
      }
    }

    await permissionGroupService.assignUserToGroup(userId, groupId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to assign group' });
  }
});

adminRoutes.delete('/users/:uid/groups/:gid', async (req: any, res) => {
  try {
    const userId = parseInt(req.params.uid, 10);
    const groupId = parseInt(req.params.gid, 10);

    if (!isAdmin(req)) {
      if (!(await canActOnUser(req, userId))) {
        res.status(403).json({ success: false, error: 'Out of scope' });
        return;
      }
      const managed = await permissionGroupService.getManagedGroupIds(req.session.userId);
      if (!managed.includes(groupId)) {
        res.status(403).json({ success: false, error: 'Group is outside your management scope' });
        return;
      }
      // Prevent a manager from removing the user's last managed group — that
      // would orphan the user (no groups → no one can act on them but admin).
      const userGroups = await permissionGroupService.getGroupsForUser(userId);
      if (userGroups.length === 1 && userGroups[0].id === groupId) {
        res.status(400).json({ success: false, error: 'Cannot remove the last group — only an admin can fully unassign a user' });
        return;
      }
    }

    await permissionGroupService.removeUserFromGroup(userId, groupId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to remove group' });
  }
});

// ── Platform-wide dashboard stats (admin only) ───────────────────────────────

adminRoutes.get('/platform-stats', requireAdmin, async (_req, res) => {
  try {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [userCounts, groupCount, appCounts, logins24h, loginsPerApp, recent] = await Promise.all([
      db('users').select(
        db.raw('COUNT(*)::int as total'),
        db.raw('SUM(CASE WHEN is_active THEN 1 ELSE 0 END)::int as active'),
        db.raw('SUM(CASE WHEN totp_enabled THEN 1 ELSE 0 END)::int as with2fa'),
        db.raw("SUM(CASE WHEN auth_source = 'ldap' THEN 1 ELSE 0 END)::int as ldap"),
      ).first(),
      db('permission_groups').count<[{ count: string }]>({ count: '*' }).first(),
      db('connected_apps').select(
        db.raw('COUNT(*)::int as total'),
        db.raw('SUM(CASE WHEN is_active THEN 1 ELSE 0 END)::int as active'),
      ).first(),
      db('user_app_links')
        .where('last_login_at', '>=', dayAgo)
        .count<[{ count: string }]>({ count: '*' })
        .first(),
      db('user_app_links as ual')
        .join('connected_apps as ca', 'ca.id', 'ual.app_id')
        .where('ual.last_login_at', '>=', dayAgo)
        .groupBy('ca.id', 'ca.app_type', 'ca.name', 'ca.color')
        .select('ca.id', 'ca.app_type', 'ca.name', 'ca.color', db.raw('COUNT(*)::int as count'))
        .orderBy('count', 'desc') as unknown as Promise<Array<{
          id: number; app_type: string; name: string; color: string | null; count: number;
        }>>,
      db('user_app_links as ual')
        .join('users as u', 'u.id', 'ual.user_id')
        .join('connected_apps as ca', 'ca.id', 'ual.app_id')
        .whereNotNull('ual.last_login_at')
        .orderBy('ual.last_login_at', 'desc')
        .limit(6)
        .select(
          'u.id as user_id', 'u.username', 'u.display_name',
          'ca.app_type', 'ca.name as app_name', 'ca.color as app_color',
          'ual.last_login_at',
        ) as unknown as Promise<Array<{
          user_id: number; username: string; display_name: string | null;
          app_type: string; app_name: string; app_color: string | null;
          last_login_at: Date;
        }>>,
    ]);

    // Hourly buckets for the last 24h (24 datapoints)
    const hourlyRows = await db('user_app_links')
      .where('last_login_at', '>=', dayAgo)
      .select(db.raw("date_trunc('hour', last_login_at) as h"), db.raw('COUNT(*)::int as count'))
      .groupBy('h') as Array<{ h: Date; count: number }>;

    const perHour: number[] = new Array(24).fill(0);
    for (const r of hourlyRows) {
      const hoursAgo = Math.floor((now.getTime() - r.h.getTime()) / (60 * 60 * 1000));
      const idx = 23 - hoursAgo;
      if (idx >= 0 && idx < 24) perHour[idx] = r.count;
    }

    res.json({
      success: true,
      data: {
        users: {
          total: (userCounts as any)?.total ?? 0,
          active: (userCounts as any)?.active ?? 0,
          with2fa: (userCounts as any)?.with2fa ?? 0,
          ldap: (userCounts as any)?.ldap ?? 0,
        },
        apps: {
          total: (appCounts as any)?.total ?? 0,
          active: (appCounts as any)?.active ?? 0,
        },
        groups: parseInt(String(groupCount?.count ?? 0), 10),
        logins: {
          last24h: parseInt(String((logins24h as any)?.count ?? 0), 10),
          perHour,
          perApp: loginsPerApp.map((r: any) => ({
            appType: r.app_type,
            name: r.name,
            color: r.color,
            count: r.count,
          })),
        },
        recent: recent.map((r: any) => ({
          userId: r.user_id,
          username: r.username,
          displayName: r.display_name,
          appType: r.app_type,
          appName: r.app_name,
          appColor: r.app_color,
          at: r.last_login_at.toISOString(),
        })),
      },
    });
  } catch (err) {
    logger.error(err, 'Failed to build platform stats');
    res.status(500).json({ success: false, error: 'Failed to build platform stats' });
  }
});

// ── SSO sync queue (admin only, push queue) ─────────────────────────────────
// credentials-changed pushes: pending / refused counts, and the deliveries
// given up after 24 h (shown as an alert on the Connected Apps page).

adminRoutes.get('/sso-sync/queue', requireAdmin, async (_req, res) => {
  try {
    res.json({ success: true, data: await ssoSyncQueue.listForAdmin() });
  } catch (err) {
    logger.error(err, 'Failed to list SSO sync queue');
    res.status(500).json({ success: false, error: 'Failed to list SSO sync queue' });
  }
});

adminRoutes.post('/sso-sync/queue/:id/retry', requireAdmin, async (req: any, res) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (id === null) { res.status(400).json({ success: false, error: 'Invalid id' }); return; }
    const out = await ssoSyncQueue.retry(id);
    if (out === 'not_found') { res.status(404).json({ success: false, error: 'Entry not found' }); return; }
    logger.info({ queueId: id, byUserId: req.session.userId, result: out }, 'SSO sync: failed delivery retried by an admin');
    res.json({ success: true, data: { result: out } });
  } catch (err) {
    logger.error(err, 'Failed to retry SSO sync entry');
    res.status(500).json({ success: false, error: 'Failed to retry' });
  }
});

adminRoutes.post('/sso-sync/queue/:id/dismiss', requireAdmin, async (req: any, res) => {
  try {
    const id = parsePositiveInt(req.params.id);
    if (id === null) { res.status(400).json({ success: false, error: 'Invalid id' }); return; }
    const ok = await ssoSyncQueue.dismiss(id);
    if (!ok) { res.status(404).json({ success: false, error: 'Entry not found' }); return; }
    logger.info({ queueId: id, byUserId: req.session.userId }, 'SSO sync: failed delivery dismissed by an admin');
    res.json({ success: true });
  } catch (err) {
    logger.error(err, 'Failed to dismiss SSO sync entry');
    res.status(500).json({ success: false, error: 'Failed to dismiss' });
  }
});

// ── App Settings (admin only) ────────────────────────────────────────────────

adminRoutes.get('/settings', requireAdmin, async (_req, res) => {
  try {
    const config = await configService.getAll();
    res.json({ success: true, data: { ...config, smtpPass: config.smtpPass ? '••••••••' : '' } });
  } catch (err) {
    logger.error(err, 'Failed to get settings');
    res.status(500).json({ success: false, error: 'Failed to get settings' });
  }
});

// Send a test email using the given (unsaved) SMTP config — lets the admin
// validate credentials before hitting Save.
adminRoutes.post('/settings/smtp-test', requireAdmin, async (req: any, res) => {
  try {
    const { smtpHost, smtpPort, smtpUser, smtpPass, smtpFrom, smtpTls, to } = req.body as {
      smtpHost?: string; smtpPort?: number | string;
      smtpUser?: string; smtpPass?: string; smtpFrom?: string;
      smtpTls?: boolean | string; to?: string;
    };

    // If password is the masked placeholder from the settings response, fall
    // back to the persisted value — otherwise the test would send with
    // "••••••••" as the actual password.
    let effectivePass = smtpPass ?? '';
    if (effectivePass === '••••••••' || effectivePass === '') {
      const saved = await configService.getAll();
      effectivePass = saved.smtpPass ?? '';
    }

    const recipient = (to && to.trim()) || (await db('users').where({ id: req.session.userId })
      .select('email').first() as { email: string | null } | undefined)?.email || '';

    if (!recipient) {
      res.status(400).json({ success: false, error: 'No recipient — set your account email or pass a "to" address' });
      return;
    }

    const senderName = req.session.username || 'admin';
    const result = await mailService.sendTest({
      smtpHost: smtpHost ?? '',
      smtpPort: typeof smtpPort === 'string' ? parseInt(smtpPort, 10) : (smtpPort ?? 587),
      smtpUser: smtpUser ?? '',
      smtpPass: effectivePass,
      smtpFrom: smtpFrom ?? '',
      smtpTls: smtpTls === true || smtpTls === 'true',
    }, recipient, senderName);

    res.json({ success: true, data: { to: recipient, messageId: result.messageId, accepted: result.accepted } });
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'SMTP test failed');
    res.status(400).json({ success: false, error: err?.message || 'SMTP test failed' });
  }
});

adminRoutes.put('/settings', requireAdmin, async (req, res) => {
  try {
    const patch = req.body as Record<string, string>;
    if (patch.smtpPass === '••••••••') delete patch.smtpPass;
    const config = await configService.update(patch);
    res.json({ success: true, data: { ...config, smtpPass: config.smtpPass ? '••••••••' : '' } });
  } catch (err) {
    logger.error(err, 'Failed to update settings');
    res.status(500).json({ success: false, error: 'Failed to update settings' });
  }
});
