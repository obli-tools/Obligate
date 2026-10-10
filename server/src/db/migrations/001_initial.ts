import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // ── Users ──────────────────────────────────────────────────────────────────
  await knex.schema.createTable('users', (t) => {
    t.increments('id').primary();
    t.string('username', 128).notNullable().unique();
    t.string('email', 255).nullable();
    t.string('display_name', 255).nullable();
    t.string('password_hash', 255).nullable(); // NULL for LDAP-only users
    t.string('role', 16).notNullable().defaultTo('user'); // 'admin' | 'user'
    t.boolean('is_active').notNullable().defaultTo(true);
    t.string('auth_source', 32).notNullable().defaultTo('local'); // 'local' | 'ldap'
    t.integer('directory_id').nullable(); // FK added after ldap_directories table
    t.text('ldap_dn').nullable();
    t.boolean('totp_enabled').notNullable().defaultTo(false);
    t.string('totp_secret', 128).nullable();
    t.string('preferred_language', 8).notNullable().defaultTo('en');
    t.timestamps(true, true);
  });

  // ── Connected Apps ─────────────────────────────────────────────────────────
  await knex.schema.createTable('connected_apps', (t) => {
    t.increments('id').primary();
    t.string('app_type', 32).notNullable(); // 'obliview' | 'obliguard' | 'oblimap' | 'obliance'
    t.string('name', 128).notNullable();
    t.text('base_url').notNullable();
    t.string('api_key', 128).notNullable().unique();
    t.string('icon', 32).nullable();
    t.string('color', 16).nullable();
    t.boolean('is_active').notNullable().defaultTo(true);
    t.timestamps(true, true);
  });

  // ── Auth Codes (one-time, 60s TTL) ─────────────────────────────────────────
  await knex.schema.createTable('auth_codes', (t) => {
    t.increments('id').primary();
    t.string('code', 128).notNullable().unique();
    t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('app_id').notNullable().references('id').inTable('connected_apps').onDelete('CASCADE');
    t.text('redirect_uri').notNullable();
    t.timestamp('expires_at').notNullable();
    t.boolean('used').notNullable().defaultTo(false);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  // ── User-App Links (provisioning tracking) ─────────────────────────────────
  await knex.schema.createTable('user_app_links', (t) => {
    t.increments('id').primary();
    t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('app_id').notNullable().references('id').inTable('connected_apps').onDelete('CASCADE');
    t.integer('remote_user_id').nullable(); // local user ID on the app
    t.boolean('enabled').notNullable().defaultTo(true);
    t.timestamp('first_login_at').nullable();
    t.timestamp('last_login_at').nullable();
    t.unique(['user_id', 'app_id']);
  });

  // ── Permission Groups ──────────────────────────────────────────────────────
  await knex.schema.createTable('permission_groups', (t) => {
    t.increments('id').primary();
    t.string('name', 128).notNullable();
    t.text('description').nullable();
    t.string('scope', 16).notNullable().defaultTo('global'); // 'global' | 'tenant'
    t.integer('tenant_id').nullable(); // NULL for global groups
    t.integer('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  // ── Permission Group → App Mappings ────────────────────────────────────────
  await knex.schema.createTable('permission_group_app_mappings', (t) => {
    t.increments('id').primary();
    t.integer('group_id').notNullable().references('id').inTable('permission_groups').onDelete('CASCADE');
    t.integer('app_id').notNullable().references('id').inTable('connected_apps').onDelete('CASCADE');
    t.string('app_role', 32).notNullable(); // 'admin' | 'user' | 'viewer'
    t.string('tenant_slug', 128).nullable(); // target tenant on the app
    t.string('team_name', 128).nullable();   // target team on the app
    t.unique(['group_id', 'app_id', 'tenant_slug']);
  });

  // ── User ↔ Permission Group junction ───────────────────────────────────────
  await knex.schema.createTable('user_permission_groups', (t) => {
    t.increments('id').primary();
    t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('group_id').notNullable().references('id').inTable('permission_groups').onDelete('CASCADE');
    t.unique(['user_id', 'group_id']);
  });

  // ── Device Links (cross-app device UUID registry) ──────────────────────────
  await knex.schema.createTable('device_links', (t) => {
    t.increments('id').primary();
    t.string('device_uuid', 128).notNullable();
    t.integer('app_id').notNullable().references('id').inTable('connected_apps').onDelete('CASCADE');
    t.text('app_path').notNullable();
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    t.unique(['device_uuid', 'app_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('device_links');
  await knex.schema.dropTableIfExists('user_permission_groups');
  await knex.schema.dropTableIfExists('permission_group_app_mappings');
  await knex.schema.dropTableIfExists('permission_groups');
  await knex.schema.dropTableIfExists('user_app_links');
  await knex.schema.dropTableIfExists('auth_codes');
  await knex.schema.dropTableIfExists('connected_apps');
  await knex.schema.dropTableIfExists('users');
}
