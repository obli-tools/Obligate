import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Common user preferences (synced to all apps on login)
  await knex.schema.alterTable('users', (t) => {
    t.string('preferred_theme', 16).notNullable().defaultTo('modern');
    t.boolean('toast_enabled').notNullable().defaultTo(true);
    t.string('toast_position', 32).notNullable().defaultTo('bottom-right');
    t.text('profile_photo_url').nullable(); // base64 data URL or external URL
  });

  // App-specific preference schemas — each app registers its specific fields
  await knex.schema.createTable('app_preference_schemas', (t) => {
    t.increments('id').primary();
    t.integer('app_id').notNullable().references('id').inTable('connected_apps').onDelete('CASCADE');
    t.string('key', 64).notNullable();       // e.g. 'preferred_rdp_client'
    t.string('label', 128).notNullable();     // e.g. 'Preferred Remote Desktop Client'
    t.string('field_type', 16).notNullable(); // 'text' | 'select' | 'boolean' | 'number'
    t.text('options').nullable();             // JSON array for 'select' type: ["RDP","VNC","AnyDesk"]
    t.string('default_value', 255).nullable();
    t.integer('sort_order').notNullable().defaultTo(0);
    t.unique(['app_id', 'key']);
  });

  // User-specific values for app-specific preferences
  await knex.schema.createTable('user_app_preferences', (t) => {
    t.increments('id').primary();
    t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('app_id').notNullable().references('id').inTable('connected_apps').onDelete('CASCADE');
    t.string('key', 64).notNullable();
    t.text('value').nullable();
    t.unique(['user_id', 'app_id', 'key']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('user_app_preferences');
  await knex.schema.dropTableIfExists('app_preference_schemas');
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('preferred_theme');
    t.dropColumn('toast_enabled');
    t.dropColumn('toast_position');
    t.dropColumn('profile_photo_url');
  });
}
