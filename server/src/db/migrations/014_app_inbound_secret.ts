import type { Knex } from 'knex';

// Optional per-app inbound secret.
//
// Obligate authenticates its own calls to an app (POST /api/auth/sso-user-sync,
// GET /api/auth/app-info, GET /api/auth/dashboard-stats) with a Bearer. Until
// now that Bearer was the app's API key — the same key the app presents to
// Obligate, and one several apps still send to browsers as client_id. When an
// inbound secret is set here, Obligate presents IT instead, so the app can
// require a secret that never left the two servers (Obliance:
// OBLIGATE_INBOUND_SECRET). NULL = today's behaviour (the API key).
//
// Stored sealed (utils/crypto sealSecret: AES-256-GCM with ENCRYPTION_KEY when
// configured, 'plain:' marker otherwise) because Obligate must present it in
// clear. It is never returned by the API except once, when generated.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('connected_apps', (t) => {
    t.text('inbound_secret').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('connected_apps', (t) => {
    t.dropColumn('inbound_secret');
  });
}
