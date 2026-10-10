import type { Knex } from 'knex';

/**
 * Obligate side of the device-bound 2FA of the connected apps (step-up
 * support for SSO accounts).
 *
 * users.totp_last_step  highest TOTP time step (floor(unix s / 30)) ever
 *                       accepted for the user, by ANY verification (Obligate
 *                       sign-in, app step-up, enable, disable). A consuming
 *                       check requires a strictly greater step, so a code seen
 *                       once can never be consumed again, anywhere.
 * users.mfa_epoch       credential version. Kept by a trigger, not by the
 *                       routes: ANY change of password_hash, totp_secret,
 *                       totp_enabled or is_active bumps it, whatever the code
 *                       path (a forgotten hook, a manual SQL fix, an older
 *                       build after a rollback). It never goes backwards. The
 *                       admin MFA reset also bumps it explicitly (a user
 *                       without TOTP has nothing else that changes).
 * auth_codes.auth_time  authentication context of the Obligate session
 * auth_codes.amr        when the code was issued, returned by the code
 *                       exchange (authTime, amr).
 * sso_sync_queue        persisted outbox of the credentials-changed
 *                       pushes to the connected apps. Filled by a trigger on
 *                       every mfa_epoch change (one row per linked app),
 *                       drained with retries by services/ssoSyncQueue.service.
 *
 * Idempotent (guards + CREATE OR REPLACE / IF [NOT] EXISTS); down() undoes
 * everything.
 */

const FN_GUARD = 'obligate_users_mfa_epoch_guard';
const FN_ENQUEUE = 'obligate_users_mfa_epoch_enqueue';
const TRG_GUARD = 'users_mfa_epoch_guard';
const TRG_ENQUEUE = 'users_mfa_epoch_enqueue';

export async function up(knex: Knex): Promise<void> {
  // ── users ────────────────────────────────────────────────────────────────
  if (!(await knex.schema.hasColumn('users', 'totp_last_step'))) {
    await knex.schema.alterTable('users', (t) => {
      // floor(unix s / 30) ≈ 5.9e7 today: an int4 lasts until the year ~4000.
      t.integer('totp_last_step').nullable();
    });
  }
  if (!(await knex.schema.hasColumn('users', 'mfa_epoch'))) {
    await knex.schema.alterTable('users', (t) => {
      // Starts at 1 so no consumer mistakes it for "missing" (0 is falsy in JS).
      t.integer('mfa_epoch').notNullable().defaultTo(1);
    });
  }

  // ── auth_codes ───────────────────────────────────────────────────────────
  if (!(await knex.schema.hasColumn('auth_codes', 'auth_time'))) {
    await knex.schema.alterTable('auth_codes', (t) => {
      t.timestamp('auth_time', { useTz: true }).nullable();
    });
  }
  if (!(await knex.schema.hasColumn('auth_codes', 'amr'))) {
    await knex.schema.alterTable('auth_codes', (t) => {
      t.string('amr', 64).nullable(); // comma-separated RFC 8176 values: "pwd" or "pwd,otp"
    });
  }

  // ── sso_sync_queue ───────────────────────────────────────────────────────
  if (!(await knex.schema.hasTable('sso_sync_queue'))) {
    await knex.schema.createTable('sso_sync_queue', (t) => {
      t.increments('id').primary();
      t.integer('app_id').notNullable().references('id').inTable('connected_apps').onDelete('CASCADE');
      // A deleted user's pending pushes go with them: the 'delete' push covers
      // it, and the app's mfa-epoch read then answers 404 (fail closed).
      t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
      t.string('action', 32).notNullable();
      t.integer('mfa_epoch').nullable();
      // pending | done | rejected (the app refused the action for good: 4xx) |
      // failed (gave up after 24 h, admin alerted) | dismissed
      t.string('status', 16).notNullable().defaultTo('pending');
      t.integer('attempts').notNullable().defaultTo(0);
      t.timestamp('first_enqueued_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('next_attempt_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('locked_until', { useTz: true }).nullable();
      t.timestamp('last_attempt_at', { useTz: true }).nullable();
      t.integer('last_status').nullable();
      t.text('last_error').nullable();
      t.timestamp('done_at', { useTz: true }).nullable();
      t.timestamp('alerted_at', { useTz: true }).nullable();
    });
  }
  // One pending row per (app, user, action): repeated changes coalesce into it.
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS sso_sync_queue_pending_uq
    ON sso_sync_queue (app_id, user_id, action) WHERE status = 'pending'`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS sso_sync_queue_due_idx
    ON sso_sync_queue (status, next_attempt_at)`);

  // ── mfa_epoch guard (BEFORE UPDATE) ──────────────────────────────────────
  await knex.raw(`
    CREATE OR REPLACE FUNCTION ${FN_GUARD}() RETURNS trigger AS $$
    BEGIN
      -- Never backwards: an explicit decrease (or NULL) counts as a change.
      IF NEW.mfa_epoch IS NULL OR NEW.mfa_epoch < OLD.mfa_epoch THEN
        NEW.mfa_epoch := OLD.mfa_epoch + 1;
      END IF;
      IF (NEW.password_hash IS DISTINCT FROM OLD.password_hash
          OR NEW.totp_secret IS DISTINCT FROM OLD.totp_secret
          OR NEW.totp_enabled IS DISTINCT FROM OLD.totp_enabled
          OR NEW.is_active IS DISTINCT FROM OLD.is_active)
         AND NEW.mfa_epoch <= OLD.mfa_epoch THEN
        NEW.mfa_epoch := OLD.mfa_epoch + 1;
      END IF;
      RETURN NEW;
    END
    $$ LANGUAGE plpgsql
  `);
  await knex.raw(`DROP TRIGGER IF EXISTS ${TRG_GUARD} ON users`);
  await knex.raw(`CREATE TRIGGER ${TRG_GUARD} BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE PROCEDURE ${FN_GUARD}()`);

  // ── outbox fill (AFTER UPDATE) ───────────────────────────────────────────
  // Plain AFTER UPDATE (not "UPDATE OF mfa_epoch"): a column changed by the
  // BEFORE trigger does not count as an UPDATE OF target. Every linked app
  // (a local account id is known) gets a row, enabled on the app or not: the
  // push only makes the app re-read the epoch, it never grants anything.
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
  await knex.raw(`DROP TRIGGER IF EXISTS ${TRG_ENQUEUE} ON users`);
  await knex.raw(`CREATE TRIGGER ${TRG_ENQUEUE} AFTER UPDATE ON users
    FOR EACH ROW EXECUTE PROCEDURE ${FN_ENQUEUE}()`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TRIGGER IF EXISTS ${TRG_ENQUEUE} ON users`);
  await knex.raw(`DROP TRIGGER IF EXISTS ${TRG_GUARD} ON users`);
  await knex.raw(`DROP FUNCTION IF EXISTS ${FN_ENQUEUE}()`);
  await knex.raw(`DROP FUNCTION IF EXISTS ${FN_GUARD}()`);
  await knex.schema.dropTableIfExists('sso_sync_queue');
  if (await knex.schema.hasColumn('auth_codes', 'amr')) {
    await knex.schema.alterTable('auth_codes', (t) => { t.dropColumn('amr'); });
  }
  if (await knex.schema.hasColumn('auth_codes', 'auth_time')) {
    await knex.schema.alterTable('auth_codes', (t) => { t.dropColumn('auth_time'); });
  }
  if (await knex.schema.hasColumn('users', 'mfa_epoch')) {
    await knex.schema.alterTable('users', (t) => { t.dropColumn('mfa_epoch'); });
  }
  if (await knex.schema.hasColumn('users', 'totp_last_step')) {
    await knex.schema.alterTable('users', (t) => { t.dropColumn('totp_last_step'); });
  }
}
