import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // 1. Add capabilities column to permission_group_app_mappings
  await knex.schema.alterTable('permission_group_app_mappings', (t) => {
    t.jsonb('capabilities').nullable().defaultTo(null);
  });

  // 2. Fix unique constraint — allow multiple teams per tenant
  //    Drop old constraint: [group_id, app_id, tenant_slug]
  //    Replace with: [group_id, app_id, tenant_slug, team_name] handling NULLs
  await knex.raw(`
    ALTER TABLE permission_group_app_mappings
    DROP CONSTRAINT IF EXISTS permission_group_app_mappings_group_id_app_id_tenant_slug_unique
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX pgam_group_app_tenant_team_unique
    ON permission_group_app_mappings (
      group_id, app_id,
      COALESCE(tenant_slug, ''),
      COALESCE(team_name, '')
    )
  `);

  // 3. Create app_capability_schemas table (same pattern as app_preference_schemas)
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

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('app_capability_schemas');
  await knex.raw('DROP INDEX IF EXISTS pgam_group_app_tenant_team_unique');
  // Restore original constraint (best effort — may fail if data violates it)
  await knex.raw(`
    ALTER TABLE permission_group_app_mappings
    ADD CONSTRAINT permission_group_app_mappings_group_id_app_id_tenant_slug_unique
    UNIQUE (group_id, app_id, tenant_slug)
  `).catch(() => {});
  await knex.schema.alterTable('permission_group_app_mappings', (t) => {
    t.dropColumn('capabilities');
  });
}
