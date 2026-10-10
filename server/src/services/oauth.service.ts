import { db } from '../db';
import { generateToken } from '../utils/crypto';
import { logger } from '../utils/logger';
import { permissionGroupService } from './permissionGroup.service';
import { preferencesService } from './preferences.service';

const AUTH_CODE_TTL_MS = 60 * 1000; // 60 seconds
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
let lastCleanup = 0;

/** RFC 8176 values Obligate may assert. */
const AMR_VALUES = new Set(['pwd', 'otp']);

function authAmrColumn(amr: string[]): string | null {
  const kept = [...new Set(amr.filter((m) => AMR_VALUES.has(m)))];
  return kept.length > 0 ? kept.join(',') : null;
}

export const oauthService = {
  /**
   * Generate a one-time authorization code for a user + app.
   * `authContext` (forced re-authentication) is the authentication context of the Obligate
   * session issuing the code: when (ms epoch) and how (RFC 8176 'pwd' / 'otp')
   * it authenticated. Returned by the exchange as authTime / amr.
   */
  async generateCode(
    userId: number,
    appId: number,
    redirectUri: string,
    authContext: { authAt: number | null; amr: string[] } = { authAt: null, amr: [] },
  ): Promise<string> {
    // Periodic cleanup of expired codes
    const now = Date.now();
    if (now - lastCleanup > CLEANUP_INTERVAL_MS) {
      lastCleanup = now;
      await db('auth_codes').where('expires_at', '<', new Date()).del().catch(() => {});
    }

    const code = generateToken(32);
    await db('auth_codes').insert({
      code,
      user_id: userId,
      app_id: appId,
      redirect_uri: redirectUri,
      expires_at: new Date(now + AUTH_CODE_TTL_MS),
      auth_time: authContext.authAt ? new Date(authContext.authAt) : null,
      amr: authAmrColumn(authContext.amr),
    });
    return code;
  },

  /**
   * Exchange a one-time code for user info. Returns null if invalid/expired/used.
   * Atomically marks the code as used to prevent replay.
   */
  async exchangeCode(code: string, appId: number, redirectUri: string) {
    // Atomically claim the code
    const [row] = await db('auth_codes')
      .where({ code, app_id: appId, redirect_uri: redirectUri, used: false })
      .where('expires_at', '>', new Date())
      .update({ used: true })
      .returning('*') as Array<{
        user_id: number;
        app_id: number;
        auth_time: Date | string | null;
        amr: string | null;
      }>;

    if (!row) return null;

    // Fetch user
    const user = await db('users').where({ id: row.user_id, is_active: true }).first() as {
      id: number; username: string; email: string | null; display_name: string | null;
      auth_source: string;
    } | undefined;
    if (!user) return null;

    // Check if user is explicitly disabled on this app
    const link = await db('user_app_links')
      .where({ user_id: user.id, app_id: appId })
      .first() as { enabled: boolean; remote_user_id: number | null } | undefined;

    if (link && !link.enabled) {
      logger.warn(`User ${user.id} (${user.username}) denied access to app ${appId} (disabled)`);
      return null;
    }

    // Resolve permissions for this app from permission groups
    const resolved = await permissionGroupService.resolveForUserAndApp(user.id, appId);

    // DENY access if user has no permission group mapping for this app (no role = no access)
    // This prevents users without explicit group assignments from accessing apps
    if (!resolved.role || resolved.role === '') {
      logger.warn(`User ${user.id} (${user.username}) denied access to app ${appId} (no permission group mapping)`);
      return null;
    }

    // Update or create app link on successful access
    if (link) {
      await db('user_app_links')
        .where({ user_id: user.id, app_id: appId })
        .update({ last_login_at: new Date() });
    } else {
      await db('user_app_links').insert({
        user_id: user.id,
        app_id: appId,
        enabled: true,
        first_login_at: new Date(),
        last_login_at: new Date(),
      }).onConflict(['user_id', 'app_id']).merge({ last_login_at: new Date() });
    }

    // Fetch preferences (common + app-specific)
    const [commonPrefs, appPrefs] = await Promise.all([
      preferencesService.getCommonPreferences(user.id),
      preferencesService.getAppPreferences(user.id, appId),
    ]);

    return {
      obligateUserId: user.id,
      username: user.username,
      email: user.email,
      displayName: user.display_name,
      role: resolved.role,
      tenants: resolved.tenants,
      teams: resolved.teams,
      authSource: user.auth_source as 'local' | 'ldap',
      // Always null (kept for the shape older apps parse). It used to echo
      // user_app_links.remote_user_id — the local id the app reported through
      // report-provision, which any holder of the app key can write: an app
      // trusting it (ObliDesk, Oblifield) opened a session on the local
      // account the attacker named. Apps resolve their local account from
      // their own records.
      linkedLocalUserId: null,
      // Forced re-authentication context: when and how the Obligate session that issued this code
      // authenticated. authTime = unix seconds (null for a session opened
      // before this version); amr = ['pwd'] or ['pwd', 'otp'] (the TOTP step
      // is replay-guarded). A forced re-authentication (prompt=login /
      // max_age) makes it THIS authentication.
      authTime: row.auth_time ? Math.floor(new Date(row.auth_time).getTime() / 1000) : null,
      amr: row.amr ? row.amr.split(',').filter((m) => AMR_VALUES.has(m)) : [],
      preferences: {
        ...commonPrefs,
        appSpecific: appPrefs,
      },
    };
  },
};
