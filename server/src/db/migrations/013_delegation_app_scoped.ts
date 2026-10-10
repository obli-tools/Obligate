import type { Knex } from 'knex';

/**
 * Delegation extension — app-scoped tokens (system-to-system).
 *
 * Original delegation flow (migration 011) always names a user in the `sub` claim: Oblidesk
 * mints a token to read a device in Obliance on behalf of user 42. Every check downstream in
 * `mint()` assumes that user exists, is active, is entitled to the audience app, and belongs
 * to the tenant.
 *
 * That works when the delegation exists because a HUMAN is doing something. It doesn't fit
 * server-to-server push flows — the Oblihub honeypot bans a scanner IP with nobody at the
 * keyboard, and needs to POST that ban to Obliguard. We could invent a `system-oblihub` user,
 * but that would leak a synthetic identity into the users listing, `authorize` gate, audit,
 * SSO — every place that treats users as things a human logs into.
 *
 * Instead: an app-scoped token, where `sub = "app:<requester.app_type>"`. The audience app
 * treats it symmetrically to a user token — same JWKS, same TTL, same signature check — and
 * decides in its OWN logic what actions each app source is allowed to trigger (Obliguard
 * accepts `app:oblihub` on `/api/external-bans`, refuses everything else).
 *
 * This migration relaxes the delegation_grants audit trail to accept a null subject_user_id
 * (the app-scoped case leaves it empty). Every user-scoped mint keeps writing the numeric id
 * exactly as before — backward compatible.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('delegation_grants', (t) => {
    t.integer('subject_user_id').nullable().alter();
    // New column captures WHICH kind of subject this mint was for. Not a discriminant we key
    // on later (jti + subject_user_id vs app-scoped is enough), just an audit hint so
    // "who did this ban push in September?" is one column read instead of a regex on sub.
    t.string('subject_type', 8).notNullable().defaultTo('user');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('delegation_grants', (t) => {
    t.dropColumn('subject_type');
    // NOT flipping subject_user_id back to notNullable — any rows written while this migration
    // was up would fail. The rollback is intentionally lossy on that specific constraint;
    // recreate the table cleanly if you truly need the strict shape back.
  });
}
