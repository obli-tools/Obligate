import type { Knex } from 'knex';

// Audit of REFUSED delegation mints.
//
// A minted token already leaves a delegation_grants row. A refused mint only
// left a log line — yet a refusal is exactly the signal worth keeping: an app
// misconfigured, or someone holding an app key probing which users it could
// borrow. One row per refusal, kept 90 days (pruned by delegation.service).
//
// No foreign keys, like delegation_grants: an audit trail has to outlive the
// app or user it names. Every free-text column is bounded and filled from
// truncated caller input (the audience of a refused mint can be garbage).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('delegation_mint_refusals', (t) => {
    t.increments('id').primary();
    t.integer('app_id').notNullable();            // the REQUESTING app (bearer)
    t.string('app_type', 32).nullable();
    t.string('audience', 64).nullable();
    t.string('subject_type', 8).nullable();       // 'user' | 'app' | raw (truncated) when invalid
    t.integer('subject_user_id').nullable();      // null for app-scoped or unparseable
    t.string('tenant_slug', 128).nullable();
    t.string('reason', 64).notNullable();
    t.string('ip', 64).nullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['app_id', 'created_at']);
    t.index(['subject_user_id', 'created_at']);
    t.index('created_at');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('delegation_mint_refusals');
}
