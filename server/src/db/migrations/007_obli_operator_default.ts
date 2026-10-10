import type { Knex } from 'knex';

// Make 'obli-operator' the default theme for newly-created users.
// Existing rows are NOT touched — users keep whatever theme they previously
// chose (e.g. 'modern' or 'neon').
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (t) => {
    t.string('preferred_theme', 32).notNullable().defaultTo('obli-operator').alter();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (t) => {
    t.string('preferred_theme', 16).notNullable().defaultTo('modern').alter();
  });
}
