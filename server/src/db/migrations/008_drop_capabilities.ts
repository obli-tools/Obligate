import type { Knex } from 'knex';

// Strip the tenant-level capabilities feature.
// Capabilities are now derived exclusively from the app-side permission set
// (role) assigned to each tenant — there is no separate per-tenant capability
// override on Obligate anymore.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('app_capability_schemas');
  await knex.schema.alterTable('permission_group_app_mappings', (t) => {
    t.dropColumn('capabilities');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('permission_group_app_mappings', (t) => {
    t.jsonb('capabilities').nullable().defaultTo(null);
  });
  await knex.schema.createTable('app_capability_schemas', (t) => {
    t.increments('id').primary();
    t.integer('app_id').notNullable().references('id').inTable('connected_apps').onDelete('CASCADE');
    t.string('key', 64).notNullable();
    t.string('label', 128).notNullable();
    t.text('description').nullable();
    t.integer('sort_order').notNullable().defaultTo(0);
    t.unique(['app_id', 'key']);
  });
}
