import type { Knex } from 'knex';

// Set when an admin resets a user's 2FA: the user must configure a new TOTP
// secret at their next login, even when the global force_2fa setting is off.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (t) => {
    t.boolean('require_2fa_setup').notNullable().defaultTo(false);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('require_2fa_setup');
  });
}
