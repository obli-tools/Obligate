import type { Knex } from 'knex';

// User-scoped delegation tokens.
//
// Today a cross-app read carries the CALLING APP's static API key, so the
// resource server answers with the app's authority instead of the authority of
// the human looking at the screen. That is a permission bypass. The fix is a
// short-lived, asymmetrically signed token that says WHO the request is for --
// never what they may do. The audience app re-derives every right from its own
// permission model.
//
// Two tables:
//   delegation_keys   -- the Ed25519 signing keys (Obligate holds the private
//                        half; every other app only ever sees the public JWK).
//   delegation_grants -- one row per minted token. The audit trail, and the
//                        substrate replay detection would need if it is ever
//                        added (jti is unique).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('delegation_keys', (t) => {
    t.increments('id').primary();
    // RFC 7638 JWK thumbprint of the public key: base64url(SHA-256) == 43 chars.
    // Deriving the kid from the key itself means a kid can never point at the
    // wrong key material, and two Obligate instances never collide by accident.
    t.string('kid', 64).notNullable().unique();
    t.string('alg', 16).notNullable().defaultTo('EdDSA');
    t.jsonb('public_jwk').notNullable();
    // The private key at rest. Sealed with the instance ENCRYPTION_KEY when one
    // is configured (see delegation.service.ts sealPrivateKey) and stored with a
    // marker prefix so the storage mode is self-describing.
    //
    // WARNING: ENCRYPTION_KEY is OPTIONAL in this deployment (config.ts defaults
    // it to ''), and .env.example ships it commented out. When it is absent the
    // PEM is written PLAINTEXT with a 'plain:' prefix, because a homemade cipher
    // keyed off something guessable would be worse than honest plaintext: it
    // would look like protection and provide none. Anyone with read access to
    // this column then holds the power to mint a token for ANY user on ANY app
    // in the suite. Set ENCRYPTION_KEY before going to production.
    t.text('private_pem').notNullable();
    t.boolean('is_active').notNullable().defaultTo(true);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    // Set when the key is retired. The row is KEPT: a token signed 60 seconds
    // before a rotation must still verify for the rest of its 120s life.
    t.timestamp('rotated_at').nullable();
    t.index('rotated_at');
  });

  // At most one active signing key, enforced by the database rather than by
  // convention. Two processes racing to create the first key would otherwise
  // both succeed and the suite would have two "current" signers.
  await knex.raw(`
    CREATE UNIQUE INDEX delegation_keys_one_active
    ON delegation_keys (is_active) WHERE is_active
  `);

  await knex.schema.createTable('delegation_grants', (t) => {
    t.increments('id').primary();
    t.string('jti', 64).notNullable().unique();
    // app_id and subject_user_id are deliberately NOT foreign keys.
    // ON DELETE CASCADE would erase the audit trail exactly when it matters most
    // (a user or app was removed), and ON DELETE RESTRICT would make an audit row
    // block user deletion. An audit ledger has to outlive what it references.
    t.integer('app_id').notNullable();          // the REQUESTING app (azp)
    t.string('audience', 32).notNullable();     // the target app type (aud)
    t.integer('subject_user_id').notNullable(); // the Obligate user (sub)
    // Tenant SLUG, never a numeric tenant id: ids are per-app and mean nothing
    // to the audience, slugs are the cross-app identity join.
    t.string('tenant_slug', 128).notNullable();
    t.string('scope', 32).notNullable().defaultTo('read');
    t.timestamp('issued_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('expires_at').notNullable();
    t.string('ip', 64).nullable(); // 45 chars covers IPv6, 64 leaves room for ::ffff: forms
    t.index(['subject_user_id', 'issued_at']);
    t.index(['app_id', 'issued_at']);
    t.index('expires_at');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('delegation_grants');
  await knex.raw('DROP INDEX IF EXISTS delegation_keys_one_active');
  await knex.schema.dropTableIfExists('delegation_keys');
}
