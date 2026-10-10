import { Router } from 'express';
import { db } from '../db';
import { authService } from '../services/auth.service';
import { preferencesService } from '../services/preferences.service';
import { configService } from '../services/config.service';
import { permissionGroupService } from '../services/permissionGroup.service';
import { authLimiter } from '../middleware/rateLimiter';
import { requireSession } from '../middleware/auth';
import { sessionService, saveSession, parseReauthTicket, satisfyTicket } from '../services/session.service';

const REQUIRED_ENROLLMENT_VERSION = 1;

export const authRoutes = Router();

/**
 * POST /api/auth/login  { username, password, reauthTicket? }
 * `reauthTicket`: the reauth_ticket of the /authorize URL this sign-in answers
 * (forced re-authentication; the sign-in page reads it from its
 * returnTo). Every successful step gets a NEW session id: a copy of the
 * previous cookie never inherits this authentication.
 */
authRoutes.post('/login', authLimiter, async (req, res) => {
  try {
    const { username, password, reauthTicket } = (req.body ?? {}) as { username?: unknown; password?: unknown; reauthTicket?: unknown };
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
      res.status(400).json({ success: false, error: 'Username and password required' });
      return;
    }

    // TODO: Add LDAP login resolution here (DOMAIN\user or user@domain)
    const user = await authService.login(username, password);
    if (!user) {
      res.status(401).json({ success: false, error: 'Invalid credentials' });
      return;
    }
    const epochRow = await db('users').where({ id: user.id }).first('mfa_epoch') as { mfa_epoch: number } | undefined;
    const mfaEpoch = Number(epochRow?.mfa_epoch ?? 1);
    const ticket = parseReauthTicket(reauthTicket);
    const now = Date.now();

    // 2FA check — if TOTP is enabled, don't complete session yet. A session
    // already signed in to THIS account (forced re-authentication)
    // keeps its previous authentication context until the code is verified.
    if (user.totpEnabled) {
      await sessionService.regenerate(req, (old) => ({
        ...(old.userId === user.id
          ? { userId: old.userId, username: old.username, role: old.role, mfaEpoch: old.mfaEpoch, authAt: old.authAt, amr: old.amr }
          : {}),
        reauthTickets: old.reauthTickets,
        pendingMfaUserId: user.id,
        pendingMfaAt: now,
        pendingMfaEpoch: mfaEpoch,
        pendingMfaFails: 0,
        ...(ticket ? { pendingReauthTicket: ticket } : {}),
      }));
      res.json({
        success: true,
        data: {
          requires2fa: true,
          methods: { totp: true },
        },
      });
      return;
    }

    // No MFA — establish session immediately (new id). Forced re-authentication context:
    // authentication context (password only).
    await sessionService.regenerate(req, (old) => ({ reauthTickets: satisfyTicket(old.reauthTickets, ticket, now) }));
    sessionService.establish(req, { id: user.id, username: user.username, role: user.role, mfaEpoch }, ['pwd'], now);
    await saveSession(req);

    res.json({ success: true, data: { user } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Login failed' });
  }
});

// POST /api/auth/logout
authRoutes.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

// GET /api/auth/me
authRoutes.get('/me', requireSession, async (req, res) => {
  try {
    const user = await authService.getUserById(req.session.userId!);
    if (!user) {
      res.status(401).json({ success: false, error: 'User not found' });
      return;
    }
    // Include enrollment check + force 2FA check
    const row = await db('users').where({ id: user.id }).select('enrollment_version', 'totp_enabled', 'require_2fa_setup').first() as
      { enrollment_version: number; totp_enabled: boolean; require_2fa_setup: boolean } | undefined;
    const enrollmentVersion = row?.enrollment_version ?? 0;
    const cfg = await configService.getAll();
    const smtpConfigured = !!(cfg.smtpHost && cfg.smtpFrom);
    // Either the group-resolved force-2FA policy requires it, or an admin reset this user's 2FA.
    const forced = await permissionGroupService.isForce2faRequiredForUser(user.id);
    const requires2faSetup = (forced || (row?.require_2fa_setup ?? false)) && !row?.totp_enabled;

    const isGroupManager = user.role !== 'admin' && (await db('permission_group_managers')
      .where({ user_id: user.id }).count<[{ count: string }]>({ count: '*' }).first())?.count !== '0';

    res.json({
      success: true,
      data: {
        user: { ...user, enrollmentVersion, isGroupManager },
        requiresEnrollment: enrollmentVersion < REQUIRED_ENROLLMENT_VERSION,
        requires2faSetup,
        smtpConfigured,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch user' });
  }
});

// POST /api/auth/enrollment
authRoutes.post('/enrollment', requireSession, async (req, res) => {
  try {
    const { displayName, email, preferredLanguage, preferredTheme, toastEnabled, toastPosition } = req.body as {
      displayName?: string; email?: string; preferredLanguage?: string;
      preferredTheme?: string; toastEnabled?: boolean; toastPosition?: string;
    };

    const userId = req.session.userId!;

    // Update user profile
    const userUpdate: Record<string, unknown> = {
      enrollment_version: REQUIRED_ENROLLMENT_VERSION,
      updated_at: new Date(),
    };
    if (displayName !== undefined) userUpdate.display_name = displayName;
    if (email !== undefined) userUpdate.email = email;
    if (preferredLanguage !== undefined) userUpdate.preferred_language = preferredLanguage;
    await db('users').where({ id: userId }).update(userUpdate);

    // Update common preferences
    await preferencesService.updateCommonPreferences(userId, {
      preferredTheme: preferredTheme ?? 'obli-operator',
      toastEnabled: toastEnabled ?? true,
      toastPosition: toastPosition ?? 'bottom-right',
      preferredLanguage: preferredLanguage ?? 'en',
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to complete enrollment' });
  }
});
