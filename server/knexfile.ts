import './src/env';
import path from 'path';
import type { Knex } from 'knex';

const isCompiled = __filename.endsWith('.js');

const config: Knex.Config = {
  client: 'pg',
  connection: process.env.DATABASE_URL || 'postgres://obligate:changeme@localhost:5432/obligate',
  searchPath: ['public'],
  migrations: {
    directory: isCompiled
      ? path.join(__dirname, 'src/db/migrations')
      : './src/db/migrations',
    extension: isCompiled ? 'js' : 'ts',
    loadExtensions: isCompiled ? ['.js'] : ['.ts'],
    schemaName: 'public',
  },
  pool: {
    min: 2,
    max: 10,
  },
};

export default config;
