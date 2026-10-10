import { Router } from 'express';
import { db } from '../db';
import { effectiveIcon } from '../services/app.service';
import { authService } from '../services/auth.service';
import { preferencesService } from '../services/preferences.service';
import { configService } from '../services/config.service';
import { ssoSyncQueue } from '../services/ssoSyncQueue.service';
import { sessionService } from '../services/session.service';
import { logger } from '../utils/logger';
import rateLimit from 'express-rate-limit';

export const accountRoutes = Router();

// Guessing the current password through a stolen session: 10 tries / 15 min
// per account.
const passwordChangeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => `pwchange:${req.session?.userId ?? req.ip ?? 'unknown'}`,
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * GET /api/account/apps
 * List connected apps with the user's link status.
 */
accountRoutes.get('/apps', async (req, res) => {
  try {
    const userId = req.session.userId!;

    // Only return apps where the user has at least one permission group mapping
    const authorizedAppIds = await db('user_permission_groups as upg')
      .join('permission_group_app_mappings as pgam', 'pgam.group_id', 'upg.group_id')
      .where('upg.user_id', userId)
      .distinct('pgam.app_id')
      .pluck('pgam.app_id') as number[];

    if (authorizedAppIds.length === 0) {
      res.json({ success: true, data: [] });
      return;
    }

    const rows = await db('connected_apps as ca')
      .leftJoin('user_app_links as ual', function () {
        this.on('ual.app_id', 'ca.id').andOnVal('ual.user_id', userId);
      })
      .where('ca.is_active', true)
      .whereIn('ca.id', authorizedAppIds)
      .orderBy('ca.sort_order').orderBy('ca.name')
      .select(
        'ca.id', 'ca.app_type', 'ca.name', 'ca.base_url', 'ca.icon', 'ca.color', 'ca.third_party',
        'ual.remote_user_id', 'ual.enabled', 'ual.first_login_at', 'ual.last_login_at',
      );

    res.json({
      success: true,
      data: rows.map(r => ({
        appId: r.id,
        appType: r.app_type,
        name: r.name,
        baseUrl: r.base_url,
        icon: effectiveIcon(r.base_url, r.icon),
        color: r.color,
        thirdParty: !!r.third_party,
        linked: r.remote_user_id != null,
        enabled: r.enabled ?? true,
        firstLoginAt: r.first_login_at?.toISOString() ?? null,
        lastLoginAt: r.last_login_at?.toISOString() ?? null,
      })),
    });
  } catch (err) {
    logger.error(err, 'Failed to list account apps');
    res.status(500).json({ success: false, error: 'Failed to list apps' });
  }
});

/**
 * GET /api/account/profile
 */
accountRoutes.get('/profile', async (req, res) => {
  try {
    const user = await authService.getUserById(req.session.userId!);
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }
    res.json({ success: true, data: user });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch profile' });
  }
});

/**
 * PUT /api/account/profile
 */
accountRoutes.put('/profile', async (req, res) => {
  try {
    const { displayName, email, preferredLanguage } = req.body as {
      displayName?: string; email?: string; preferredLanguage?: string;
    };

    const update: Record<string, unknown> = { updated_at: new Date() };
    if (displayName !== undefined) update.display_name = displayName;
    if (email !== undefined) update.email = email;
    if (preferredLanguage !== undefined) update.preferred_language = preferredLanguage;

    await db('users').where({ id: req.session.userId! }).update(update);

    const user = await authService.getUserById(req.session.userId!);
    res.json({ success: true, data: user });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to update profile' });
  }
});

/**
 * PUT /api/account/password
 * The current password is REQUIRED when the account has one. It used to be
 * checked only when supplied, so a session cookie alone could change the
 * password — and then pass the forced re-authentication (prompt=login) the
 * apps rely on for their strongest step-ups (forced re-authentication).
 * 400 currentPasswordRequired · 401 currentPasswordInvalid · 429 (10 / 15 min).
 * The change moves the user's mfa_epoch (DB trigger) and queues a
 * credentials-changed push to the linked apps (MFA epoch + push queue).
 */
accountRoutes.put('/password', passwordChangeLimiter, async (req, res) => {
  try {
    const { currentPassword, newPassword } = (req.body ?? {}) as { currentPassword?: unknown; newPassword?: unknown };
    const cfg = await configService.getAll();
    if (typeof newPassword !== 'string' || newPassword.length < cfg.minPasswordLength) {
      res.status(400).json({ success: false, error: `Password too short (min ${cfg.minPasswordLength} chars)` });
      return;
    }
    const user = await db('users').where({ id: req.session.userId! }).first() as { password_hash: string | null } | undefined;
    if (user?.password_hash) {
      if (typeof currentPassword !== 'string' || !currentPassword) {
        res.status(400).json({ success: false, code: 'currentPasswordRequired', error: 'Current password is required' });
        return;
      }
      const { comparePassword } = await import('../utils/crypto');
      const valid = await comparePassword(currentPassword, user.password_hash);
      if (!valid) {
        res.status(401).json({ success: false, code: 'currentPasswordInvalid', error: 'Current password is incorrect' });
        return;
      }
    }
    await authService.changePassword(req.session.userId!, newPassword);
    // mfa_epoch moved: every OTHER Obligate session of the account ends (a
    // user changing their password to expel an intruder expels it from
    // Obligate — and so from the apps it would keep signing in); this session
    // gets a new id and the new credential version.
    await sessionService.afterOwnCredentialChange(req);
    void ssoSyncQueue.kick();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to change password' });
  }
});

/**
 * GET /api/account/preferences
 * Returns common preferences + all app-specific preferences with schemas.
 */
accountRoutes.get('/preferences', async (req, res) => {
  try {
    const userId = req.session.userId!;
    const [common, appSchemas, allAppPrefs] = await Promise.all([
      preferencesService.getCommonPreferences(userId),
      preferencesService.getAllSchemasGroupedByApp(),
      preferencesService.getAllAppPreferences(userId),
    ]);

    // Merge schemas with user values
    const appSections = appSchemas.map(section => ({
      appId: section.appId,
      appName: section.appName,
      appType: section.appType,
      schemas: section.schemas,
      values: allAppPrefs[section.appId] ?? {},
    }));

    res.json({ success: true, data: { common, appSections } });
  } catch (err) {
    logger.error(err, 'Failed to get preferences');
    res.status(500).json({ success: false, error: 'Failed to get preferences' });
  }
});

/**
 * PUT /api/account/preferences/common
 */
accountRoutes.put('/preferences/common', async (req, res) => {
  try {
    await preferencesService.updateCommonPreferences(req.session.userId!, req.body);
    const common = await preferencesService.getCommonPreferences(req.session.userId!);
    res.json({ success: true, data: common });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to update preferences' });
  }
});

/**
 * PUT /api/account/preferences/app/:appId
 */
accountRoutes.put('/preferences/app/:appId', async (req, res) => {
  try {
    const appId = parseInt(req.params.appId, 10);
    const prefs = req.body as Record<string, string>;
    await preferencesService.setAppPreferences(req.session.userId!, appId, prefs);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to update app preferences' });
  }
});
