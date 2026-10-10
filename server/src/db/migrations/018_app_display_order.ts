import type { Knex } from 'knex';

/**
 * Lets an admin control, from Obligate alone, the order apps are shown in
 * across the whole suite (Obligate's own dashboard/switcher and every
 * connected app's cross-app nav, which already renders from the dynamic
 * `/api/apps/connected` feed): `sort_order` joins `color` and `icon` as a
 * per-app display attribute owned by Obligate, not duplicated per app.
 *
 * Backfilled from the current admin listing order (`name` ascending) so
 * existing deployments see no visible reshuffle on upgrade.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('connected_apps', (t) => {
    t.integer('sort_order').notNullable().defaultTo(0);
  });

  const rows = await knex('connected_apps').select('id').orderBy('name') as Array<{ id: number }>;
  for (let i = 0; i < rows.length; i++) {
    await knex('connected_apps').where({ id: rows[i].id }).update({ sort_order: i });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('connected_apps', (t) => {
    t.dropColumn('sort_order');
  });
}
