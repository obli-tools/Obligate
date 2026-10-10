import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('obligate_config', (t) => {
    t.string('key', 128).primary();
    t.text('value').nullable();
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
  });

  // Seed defaults
  const defaults: Array<{ key: string; value: string }> = [
    { key: 'min_password_length', value: '4' },
    { key: 'force_2fa', value: 'false' },
    { key: 'smtp_host', value: '' },
    { key: 'smtp_port', value: '587' },
    { key: 'smtp_user', value: '' },
    { key: 'smtp_pass', value: '' },
    { key: 'smtp_from', value: '' },
    { key: 'smtp_tls', value: 'true' },
  ];
  for (const d of defaults) {
    await knex('obligate_config').insert({ ...d, updated_at: knex.fn.now() });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('obligate_config');
}
