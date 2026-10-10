import type { Knex } from 'knex';
import { db } from '../db';
import { logger } from '../utils/logger';
import { delegationService, REFUSAL_RETENTION_MS } from './delegation.service';

/**
 * Hourly retention purges.
 *
 * Some tables were only pruned lazily, on the request path that writes them
 * (auth_codes on code generation, delegation_mint_refusals on a refusal,
 * delegation_keys on rotation), so an idle instance never pruned them; and
 * delegation_grants (one audit row per minted cross-app token) was never pruned
 * at all. This timer runs every purge regardless of traffic. The lazy calls stay
 * in place: they are harmless and keep busy instances tidy between two runs.
 *
 * Deletes go in bounded batches (DELETE ... WHERE id IN (SELECT ... LIMIT n)) so
 * a large backlog never turns into one long lock-holding statement.
 */

const RUN_EVERY_MS = 60 * 60_000;
/** First run shortly after boot (migrations are done by then), not in the startup path. */
const FIRST_RUN_DELAY_MS = 60_000;
const BATCH_SIZE = 5_000;
/** Per table and per run; a bigger backlog simply continues on the next run. */
const MAX_BATCHES = 200;

/**
 * delegation_grants rows are kept 90 days past their expiry, the same window as
 * delegation_mint_refusals (migration 015): the refused and the granted mints of
 * one period stay comparable for the whole retention window.
 */
const GRANT_RETENTION_MS = REFUSAL_RETENTION_MS;

let timer: NodeJS.Timeout | null = null;
let running = false;

async function deleteInBatches(
  table: string,
  where: (qb: Knex.QueryBuilder) => void,
): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const ids = db(table).select('id').where(where).limit(BATCH_SIZE);
    const n = await db(table).whereIn('id', ids).del();
    total += n;
    if (n < BATCH_SIZE) break;
  }
  return total;
}

async function step(name: string, fn: () => Promise<number>): Promise<void> {
  try {
    const deleted = await fn();
    if (deleted > 0) logger.info({ deleted }, `maintenance: purged ${name}`);
  } catch (err) {
    // One failing purge never stops the others.
    logger.error({ err: err instanceof Error ? err.message : err }, `maintenance: purge of ${name} failed`);
  }
}

async function runOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const now = Date.now();
    await step('delegation_grants', () => deleteInBatches('delegation_grants',
      (qb) => { qb.where('expires_at', '<', new Date(now - GRANT_RETENTION_MS)); }));
    await step('delegation_mint_refusals', () => deleteInBatches('delegation_mint_refusals',
      (qb) => { qb.where('created_at', '<', new Date(now - REFUSAL_RETENTION_MS)); }));
    await step('auth_codes', () => deleteInBatches('auth_codes',
      (qb) => { qb.where('expires_at', '<', new Date(now)); }));
    // Logs its own count; at most a handful of rows, no batching needed.
    await step('delegation_keys', async () => { await delegationService.purgeExpiredKeys(); return 0; });
  } finally {
    running = false;
  }
}

export const maintenance = {
  /** Start the hourly purges (idempotent). Called once by index.ts. */
  start(): void {
    if (timer) return;
    timer = setInterval(() => { void runOnce(); }, RUN_EVERY_MS);
    timer.unref?.();
    setTimeout(() => { void runOnce(); }, FIRST_RUN_DELAY_MS).unref?.();
  },

  stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  },

  runOnce,
};
