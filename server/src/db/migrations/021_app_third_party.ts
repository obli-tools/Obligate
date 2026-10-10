import type { Knex } from 'knex';

/**
 * Third-party apps (not part of the Obli* suite, e.g. Passly) that use
 * Obligate as their SSO: an admin files them under "More…" in AppsPage, and
 * every app's header shows them apart, in a "More…" dropdown, instead of in
 * the main app switcher. Ordering (sort_order) still applies inside each group.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('connected_apps', (t) => {
    t.boolean('third_party').notNullable().defaultTo(false);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('connected_apps', (t) => {
    t.dropColumn('third_party');
  });
}
