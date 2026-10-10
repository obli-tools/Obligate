import type { Knex } from 'knex';
import { logger } from '../../utils/logger';

/**
 * App-key hardening (second pass).
 *
 * connected_apps
 *   raw_client_id_last_seen_at / raw_client_id_uses
 *                        the app's RAW API key was presented as the public
 *                        client_id of /authorize (it went through a browser:
 *                        history, Referer, proxy logs). Set on every such use,
 *                        reset by a key rotation. While set, the key is
 *                        treated as public: no delegation token is minted for
 *                        that app (DELEGATION_ALLOW_EXPOSED_KEYS=true to
 *                        override) and the Connected Apps page asks for a
 *                        rotation.
 *   api_key_rotated_at   last "Regenerate API key".
 *   inbound_secret_pending
 *                        an inbound secret generated but not activated yet:
 *                        Obligate keeps presenting the current Bearer until
 *                        the app proves (app-info answers 200 with it) that it
 *                        is configured, then switches.
 *
 * user_app_links
 *   One local account of an app belongs to ONE Obligate user: unique
 *   (app_id, remote_user_id) when set. Duplicates left by the old
 *   last-writer-wins report-provision are cleared first (the link with the
 *   most recent SSO sign-in keeps the pointer).
 *   remote_user_reported_at  last accepted report-provision: a set pointer
 *                        changes at most once per SSO sign-in (window of
 *                        api.routes POINTER_CHANGE_WINDOW_MS).
 *
 * sso_sync_queue
 *   remote_user_id       the app's local id known when the change was queued.
 *   The outbox now gets a row for EVERY link of the user (with or without a
 *   local id): clearing the pointer (report-provision) can no longer suppress
 *   the credentials-changed push, which carries obligateUserId anyway.
 *
 * Idempotent; down() restores the migration-016 trigger function.
 */

const FN_ENQUEUE = 'obligate_users_mfa_epoch_enqueue';
const POINTER_UQ = 'user_app_links_app_remote_uq';

export async function up(knex: Knex): Promise<void> {
  // ── connected_apps ───────────────────────────────────────────────────────
  if (!(await knex.schema.hasColumn('connected_apps', 'raw_client_id_last_seen_at'))) {
    await knex.schema.alterTable('connected_apps', (t) => {
      t.timestamp('raw_client_id_last_seen_at', { useTz: true }).nullable();
    });
  }
  if (!(await knex.schema.hasColumn('connected_apps', 'raw_client_id_uses'))) {
    await knex.schema.alterTable('connected_apps', (t) => {
      t.integer('raw_client_id_uses').notNullable().defaultTo(0);
    });
  }
  if (!(await knex.schema.hasColumn('connected_apps', 'api_key_rotated_at'))) {
    await knex.schema.alterTable('connected_apps', (t) => {
      t.timestamp('api_key_rotated_at', { useTz: true }).nullable();
    });
  }
  if (!(await knex.schema.hasColumn('connected_apps', 'inbound_secret_pending'))) {
    await knex.schema.alterTable('connected_apps', (t) => {
      t.text('inbound_secret_pending').nullable();
    });
  }

  // ── user_app_links: one Obligate user per local account ──────────────────
  const dup = await knex.raw(`
    WITH ranked AS (
      SELECT user_id, app_id,
             ROW_NUMBER() OVER (PARTITION BY app_id, remote_user_id
                                ORDER BY last_login_at DESC NULLS LAST, first_login_at DESC NULLS LAST, user_id) AS rn
        FROM user_app_links
       WHERE remote_user_id IS NOT NULL)
    UPDATE user_app_links l
       SET remote_user_id = NULL
      FROM ranked r
     WHERE r.user_id = l.user_id AND r.app_id = l.app_id AND r.rn > 1
    RETURNING l.user_id, l.app_id
  `) as { rows?: Array<{ user_id: number; app_id: number }> };
  const cleared = dup.rows ?? [];
  if (cleared.length > 0) {
    logger.warn({ cleared }, 'migration 017: local account pointers shared by several Obligate users cleared (each app re-reports its own at the next SSO sign-in)');
  }
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ${POINTER_UQ}
    ON user_app_links (app_id, remote_user_id) WHERE remote_user_id IS NOT NULL`);
  // Last accepted report-provision for the link: a pointer may change only
  // once per SSO sign-in (the app's own callback reports right after the code
  // exchange and so closes the window before anyone else can use it).
  if (!(await knex.schema.hasColumn('user_app_links', 'remote_user_reported_at'))) {
    await knex.schema.alterTable('user_app_links', (t) => {
      t.timestamp('remote_user_reported_at', { useTz: true }).nullable();
    });
  }

  // ── sso_sync_queue ───────────────────────────────────────────────────────
  if (!(await knex.schema.hasColumn('sso_sync_queue', 'remote_user_id'))) {
    await knex.schema.alterTable('sso_sync_queue', (t) => {
      t.integer('remote_user_id').nullable();
    });
  }
  await knex.raw(`
    CREATE OR REPLACE FUNCTION ${FN_ENQUEUE}() RETURNS trigger AS $$
    BEGIN
      IF NEW.mfa_epoch IS DISTINCT FROM OLD.mfa_epoch THEN
        INSERT INTO sso_sync_queue (app_id, user_id, action, mfa_epoch, remote_user_id)
        SELECT l.app_id, NEW.id, 'credentials-changed', NEW.mfa_epoch, l.remote_user_id
          FROM user_app_links l
          JOIN connected_apps a ON a.id = l.app_id
         WHERE l.user_id = NEW.id
           AND a.is_active
        ON CONFLICT (app_id, user_id, action) WHERE status = 'pending'
        DO UPDATE SET mfa_epoch = GREATEST(sso_sync_queue.mfa_epoch, EXCLUDED.mfa_epoch),
                      remote_user_id = COALESCE(EXCLUDED.remote_user_id, sso_sync_queue.remote_user_id),
                      attempts = 0,
                      next_attempt_at = now();
      END IF;
      RETURN NULL;
    END
    $$ LANGUAGE plpgsql
  `);
}

export async function down(knex: Knex): Promise<void> {
  // The migration-016 version of the outbox fill (linked apps with a local id only).
  await knex.raw(`
    CREATE OR REPLACE FUNCTION ${FN_ENQUEUE}() RETURNS trigger AS $$
    BEGIN
      IF NEW.mfa_epoch IS DISTINCT FROM OLD.mfa_epoch THEN
        INSERT INTO sso_sync_queue (app_id, user_id, action, mfa_epoch)
        SELECT l.app_id, NEW.id, 'credentials-changed', NEW.mfa_epoch
          FROM user_app_links l
          JOIN connected_apps a ON a.id = l.app_id
         WHERE l.user_id = NEW.id
           AND l.remote_user_id IS NOT NULL
           AND a.is_active
        ON CONFLICT (app_id, user_id, action) WHERE status = 'pending'
        DO UPDATE SET mfa_epoch = GREATEST(sso_sync_queue.mfa_epoch, EXCLUDED.mfa_epoch),
                      attempts = 0,
                      next_attempt_at = now();
      END IF;
      RETURN NULL;
    END
    $$ LANGUAGE plpgsql
  `);
  if (await knex.schema.hasColumn('sso_sync_queue', 'remote_user_id')) {
    await knex.schema.alterTable('sso_sync_queue', (t) => { t.dropColumn('remote_user_id'); });
  }
  await knex.raw(`DROP INDEX IF EXISTS ${POINTER_UQ}`);
  if (await knex.schema.hasColumn('user_app_links', 'remote_user_reported_at')) {
    await knex.schema.alterTable('user_app_links', (t) => { t.dropColumn('remote_user_reported_at'); });
  }
  for (const col of ['inbound_secret_pending', 'api_key_rotated_at', 'raw_client_id_uses', 'raw_client_id_last_seen_at']) {
    if (await knex.schema.hasColumn('connected_apps', col)) {
      await knex.schema.alterTable('connected_apps', (t) => { t.dropColumn(col); });
    }
  }
}
