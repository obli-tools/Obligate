import type { Knex } from 'knex';

/**
 * Per-group exemption from the global "force 2FA" policy (Settings page).
 *
 * The global toggle (`obligate_config.force_2fa`) still applies to everyone
 * by default. A permission group marked `force_2fa_exempt` opts its members
 * out — but only if EVERY group the user belongs to is exempt: a single
 * non-exempt group is enough to keep 2FA forced (the more restrictive group
 * wins, by design — see permissionGroup.service.ts `isForce2faExempt`). A
 * user with no group at all is never exempt.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('permission_groups', (t) => {
    t.boolean('force_2fa_exempt').notNullable().defaultTo(false);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('permission_groups', (t) => {
    t.dropColumn('force_2fa_exempt');
  });
}
