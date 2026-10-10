import { db } from '../db';
import { logger } from '../utils/logger';
import { appService } from './app.service';

/**
 * Push SSO user state changes to all connected apps.
 * Called when an admin deactivates, reactivates, or deletes a user on Obligate.
 */
export const ssoSyncService = {
  /**
   * Notify all connected apps of a user state change.
   * action: 'deactivate' | 'reactivate' | 'delete' | 'update-role'
   */
  async pushUserChange(obligateUserId: number, action: 'deactivate' | 'reactivate' | 'delete' | 'update-role', extra?: { role?: string }): Promise<void> {
    // Get user info
    const user = await db('users').where({ id: obligateUserId }).first() as {
      id: number; username: string; role: string; is_active: boolean;
    } | undefined;

    // For delete, user may already be gone — that's OK, we still notify apps
    const username = user?.username ?? `obligateUser#${obligateUserId}`;

    // Get all connected apps with their credentials (API key / inbound secret)
    const apps = await db('connected_apps')
      .where({ is_active: true })
      .select('id', 'name', 'base_url', 'api_key', 'inbound_secret') as Array<{
        id: number; name: string; base_url: string; api_key: string; inbound_secret: string | null;
      }>;

    // Get app links to know the remote_user_id for each app
    const links = await db('user_app_links')
      .where({ user_id: obligateUserId })
      .select('app_id', 'remote_user_id') as Array<{
        app_id: number; remote_user_id: number | null;
      }>;

    const linkMap = new Map(links.map(l => [l.app_id, l.remote_user_id]));

    for (const app of apps) {
      // Every app the user has a link with (signed in there, or provisioned
      // by it), local id known or not: a pointer cleared through
      // report-provision must not silence the push. The apps resolve the
      // account from obligateUserId and their own records.
      if (!linkMap.has(app.id)) continue; // User was never provisioned on this app
      const remoteUserId = linkMap.get(app.id) ?? null;

      // The app's inbound secret when one is set, else its API key (migration 014)
      const bearer = appService.outboundBearer(app);
      if (!bearer) continue; // inbound secret unreadable: logged by outboundBearer

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(`${app.base_url}/api/auth/sso-user-sync`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${bearer}`,
          },
          body: JSON.stringify({
            obligateUserId,
            obligateUsername: username,
            remoteUserId,
            action,
            role: extra?.role,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (res.ok) {
          logger.info(`SSO sync: ${action} user ${username} → ${app.name} OK`);
          // If deleted, clean up the app link
          if (action === 'delete') {
            await db('user_app_links').where({ user_id: obligateUserId, app_id: app.id }).del();
          }
        } else {
          logger.warn(`SSO sync: ${action} user ${username} → ${app.name} failed (${res.status})`);
        }
      } catch (err) {
        logger.warn(`SSO sync: ${action} user ${username} → ${app.name} unreachable`);
      }
    }
  },
};
