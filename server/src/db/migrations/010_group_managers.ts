import type { Knex } from 'knex';

// Group managers: users who can create/manage users within a permission group's scope.
// A manager can act on a user iff every group the user belongs to is managed by them.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('permission_group_managers', (t) => {
    t.integer('group_id').notNullable().references('id').inTable('permission_groups').onDelete('CASCADE');
    t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.primary(['group_id', 'user_id']);
    t.index('user_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('permission_group_managers');
}
