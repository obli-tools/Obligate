import type { Knex } from 'knex';

// Track the last time a user authenticated directly on Obligate (password flow).
// Per-app last logins are already tracked in user_app_links.last_login_at.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (t) => {
    t.timestamp('last_login_at').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('last_login_at');
  });
}
