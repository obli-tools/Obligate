import { db } from '../db';
import { logger } from '../utils/logger';
import { appService } from './app.service';
import { mailService } from './mail.service';
import type { SsoSyncQueueStatus } from '@obligate/shared';

/**
 * Persisted delivery of the `credentials-changed` pushes (push queue).
 *
 * Rows are written by the database itself: the trigger of migrations 016/017
 * queues one row per linked app (every user_app_links row of the user, with
 * or without a local account id; app active) every time users.mfa_epoch
 * moves — password, TOTP, activation, admin MFA reset, whatever the code
 * path. The row keeps the app's local id known at that time. This worker
 * delivers them to
 *
 *   POST {app.base_url}/api/auth/sso-user-sync
 *   Authorization: Bearer <the app's inbound secret, else its API key>
 *   { obligateUserId, obligateUsername, remoteUserId,
 *     action: 'credentials-changed', mfaEpoch }
 *
 * `remoteUserId` = the app's CURRENT local id for the user, else the one known
 * when the change was queued, else null: a pointer cleared through
 * report-provision (an app key alone could, before) no longer suppresses the
 * push — the app resolves the account from obligateUserId and its own records.
 *
 * The push only tells the app that the credentials changed; what it does
 * depends on the app (behaviour of the Obli apps at the time of writing):
 *   - Obliance re-reads GET /api/oauth/users/:id/mfa-epoch (the source of
 *     truth, also checked at every sensitive use with a short cache): phone
 *     keys revoked, sessions ended. The ONLY app that re-checks on use.
 *   - Obliguard ends all the user's sessions (at every change).
 *   - Oblimap (version being prepared) ends the sessions; older: 200, no effect.
 *   - Obliview re-reads the roster (503 when unreadable → retried), no effect.
 *   - ObliDesk, Oblihub answer 400 (action unknown) → rejected.
 *   - Oblifield answers 200 without any effect.
 *
 * Outcome of one attempt:
 *   - 2xx with { success: true }            → done
 *   - 4xx other than 401/403/408/409/425/429,
 *     and 501                               → rejected (final: the app does
 *                                             not handle this action, e.g. an
 *                                             Obli app without step-up)
 *   - anything else (network, timeout, 5xx,
 *     401/403 while a key or inbound secret
 *     is being rotated, 3xx, 2xx without
 *     success:true, unreadable inbound
 *     secret)                               → retried with an exponential
 *                                             backoff (30 s, 1 min, 2 min …
 *                                             capped at 1 h) for 24 h after
 *                                             the first undelivered change,
 *                                             then `failed`: logged as an
 *                                             error, e-mailed to the platform
 *                                             admins when SMTP is configured,
 *                                             and shown on the Connected Apps
 *                                             page (Retry / Dismiss).
 *
 * Several changes before a delivery coalesce into the one pending row, which
 * carries the highest epoch; a change landing while a delivery is in flight
 * keeps the row pending (completion is conditioned on the epoch sent).
 */

const POLL_MS = 15_000;
const BATCH = 25;
const LOCK_SECONDS = 120;
const BASE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 60 * 60_000;
/** A change that could not be delivered for this long is given up and alerted. */
export const RETRY_WINDOW_MS = 24 * 60 * 60_000;
const SEND_TIMEOUT_MS = 8_000;
const RETENTION_DAYS = 30;
const CLEANUP_EVERY_MS = 60 * 60_000;
/** 4xx answers that may change without anyone touching the app's code. */
const RETRYABLE_4XX = new Set([401, 403, 408, 409, 425, 429]);

/** Delay before the next attempt after `attempts` failed ones (>= 1). */
export function backoffMs(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(n - 1, 20));
}

interface QueueRow {
  id: number;
  app_id: number;
  user_id: number;
  action: string;
  mfa_epoch: number | null;
  remote_user_id: number | null;
  attempts: number;
  first_enqueued_at: Date;
}

type Outcome =
  | { kind: 'delivered'; httpStatus: number; sentEpoch: number }
  | { kind: 'rejected'; httpStatus: number; error: string }
  | { kind: 'retry'; httpStatus: number | null; error: string }
  | { kind: 'dismissed'; error: string };

let timer: NodeJS.Timeout | null = null;
let running: Promise<void> | null = null;
let rerun = false;
let lastCleanup = 0;

async function deliver(row: QueueRow): Promise<Outcome> {
  const app = await db('connected_apps').where({ id: row.app_id })
    .first('id', 'name', 'base_url', 'api_key', 'inbound_secret', 'is_active') as {
      id: number; name: string; base_url: string; api_key: string; inbound_secret: string | null; is_active: boolean;
    } | undefined;
  if (!app || !app.is_active) return { kind: 'dismissed', error: 'app deleted or inactive' };

  // The app's CURRENT local id for the user (it may have been re-provisioned
  // since the change was queued), else the one known then. Never a reason to
  // drop the push: a key holder could clear the pointer (report-provision) to
  // suppress it; the app resolves the account from obligateUserId.
  const link = await db('user_app_links').where({ user_id: row.user_id, app_id: row.app_id })
    .first('remote_user_id') as { remote_user_id: number | null } | undefined;
  const remoteUserId = link?.remote_user_id ?? row.remote_user_id ?? null;

  const user = await db('users').where({ id: row.user_id })
    .first('username', 'mfa_epoch') as { username: string; mfa_epoch: number } | undefined;
  if (!user) return { kind: 'dismissed', error: 'user deleted' };
  const epoch = Math.max(row.mfa_epoch ?? 0, user.mfa_epoch ?? 0);

  // Inbound secret when one is set, else the API key (migration 014). Null =
  // the inbound secret cannot be unsealed: never fall back to the key.
  const bearer = appService.outboundBearer(app);
  if (!bearer) return { kind: 'retry', httpStatus: null, error: 'inbound secret unreadable (ENCRYPTION_KEY changed?) — generate a new one' };

  try {
    const res = await fetch(`${app.base_url}/api/auth/sso-user-sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${bearer}` },
      body: JSON.stringify({
        obligateUserId: row.user_id,
        obligateUsername: user.username,
        remoteUserId,
        action: row.action,
        mfaEpoch: epoch,
      }),
      // A redirect is an app misconfiguration (base URL): retried then
      // alerted, never followed with the Bearer attached.
      redirect: 'manual',
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    let body: { success?: unknown } | null = null;
    try { body = await res.json() as { success?: unknown }; } catch { body = null; }
    if (res.ok && body?.success === true) return { kind: 'delivered', httpStatus: res.status, sentEpoch: epoch };
    if (res.ok) return { kind: 'retry', httpStatus: res.status, error: 'unexpected response body (no success:true)' };
    if ((res.status >= 400 && res.status < 500 && !RETRYABLE_4XX.has(res.status)) || res.status === 501) {
      return { kind: 'rejected', httpStatus: res.status, error: `HTTP ${res.status} (the app does not handle this action)` };
    }
    return { kind: 'retry', httpStatus: res.status, error: `HTTP ${res.status}` };
  } catch (err) {
    const msg = err instanceof Error ? (err.name === 'TimeoutError' ? 'timeout' : err.message) : String(err);
    return { kind: 'retry', httpStatus: null, error: `unreachable: ${msg}`.slice(0, 500) };
  }
}

/** Claims up to BATCH due rows (locked for LOCK_SECONDS, attempts + 1). */
async function claimDue(): Promise<QueueRow[]> {
  const res = await db.raw(`
    UPDATE sso_sync_queue q
       SET locked_until = now() + (?::int * interval '1 second'),
           attempts = q.attempts + 1,
           last_attempt_at = now()
     WHERE q.id IN (
       SELECT id FROM sso_sync_queue
        WHERE status = 'pending'
          AND next_attempt_at <= now()
          AND (locked_until IS NULL OR locked_until < now())
        ORDER BY next_attempt_at
        LIMIT ?::int
        FOR UPDATE SKIP LOCKED)
    RETURNING q.id, q.app_id, q.user_id, q.action, q.mfa_epoch, q.remote_user_id, q.attempts, q.first_enqueued_at
  `, [LOCK_SECONDS, BATCH]) as { rows: QueueRow[] };
  return res.rows;
}

async function alertAdmins(failed: Array<QueueRow & { error: string }>): Promise<void> {
  if (failed.length === 0) return;
  const apps = await db('connected_apps').whereIn('id', [...new Set(failed.map((f) => f.app_id))])
    .select('id', 'name') as Array<{ id: number; name: string }>;
  const appName = new Map(apps.map((a) => [a.id, a.name]));
  const users = await db('users').whereIn('id', [...new Set(failed.map((f) => f.user_id))])
    .select('id', 'username') as Array<{ id: number; username: string }>;
  const userName = new Map(users.map((u) => [u.id, u.username]));

  for (const f of failed) {
    logger.error({
      queueId: f.id, appId: f.app_id, appName: appName.get(f.app_id), userId: f.user_id, action: f.action,
      mfaEpoch: f.mfa_epoch, attempts: f.attempts, error: f.error,
    }, 'SSO sync: credentials-changed not delivered for 24 h — given up (see Connected Apps in Obligate)');
  }

  try {
    const admins = await db('users').where({ role: 'admin', is_active: true }).whereNotNull('email')
      .pluck('email') as string[];
    const lines = failed.map((f) =>
      `- ${userName.get(f.user_id) ?? `user #${f.user_id}`} -> ${appName.get(f.app_id) ?? `app #${f.app_id}`}`
      + ` (${f.action}, epoch ${f.mfa_epoch ?? '?'}, ${f.attempts} attempts, last error: ${f.error})`);
    const sent = await mailService.send(
      admins,
      'Obligate: SSO credential changes could not be delivered',
      'Obligate could not notify one or more connected apps of a credential change for 24 hours.\n'
      + 'Only Obliance re-checks these users\' credentials at each sensitive use; in the other apps\n'
      + 'the sessions opened before the change stay open until they expire (Obliguard and Oblimap\n'
      + 'would have ended them on delivery):\n\n'
      + `${lines.join('\n')}\n\n`
      + 'Check that each app is reachable from Obligate at its base URL and that its API key\n'
      + '(or inbound secret) is current, then use "Retry" on the Connected Apps page.\n',
    );
    if (!sent) logger.warn('SSO sync: delivery failures not e-mailed (SMTP not configured or no admin e-mail)');
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, 'SSO sync: alert e-mail failed');
  }
  await db('sso_sync_queue').whereIn('id', failed.map((f) => f.id)).update({ alerted_at: new Date() });
}

async function sweepOnce(): Promise<number> {
  const rows = await claimDue();
  const newlyFailed: Array<QueueRow & { error: string }> = [];
  for (const row of rows) {
    let r: Outcome;
    try {
      r = await deliver(row);
    } catch (err) {
      r = { kind: 'retry', httpStatus: null, error: `internal error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500) };
    }
    if (r.kind === 'delivered') {
      // Done only if no newer change landed on this row during the delivery.
      await db.raw(`
        UPDATE sso_sync_queue
           SET status = CASE WHEN mfa_epoch IS NULL OR mfa_epoch <= ? THEN 'done' ELSE 'pending' END,
               done_at = CASE WHEN mfa_epoch IS NULL OR mfa_epoch <= ? THEN now() ELSE NULL END,
               next_attempt_at = now(),
               locked_until = NULL,
               last_status = ?,
               last_error = NULL
         WHERE id = ?
      `, [r.sentEpoch, r.sentEpoch, r.httpStatus, row.id]);
      logger.info({ appId: row.app_id, userId: row.user_id, mfaEpoch: r.sentEpoch }, `SSO sync: ${row.action} delivered`);
      continue;
    }
    if (r.kind === 'dismissed' || r.kind === 'rejected') {
      await db('sso_sync_queue').where({ id: row.id }).update({
        status: r.kind, locked_until: null, done_at: new Date(),
        last_status: r.kind === 'rejected' ? r.httpStatus : null, last_error: r.error,
      });
      const log = r.kind === 'rejected' ? logger.warn.bind(logger) : logger.info.bind(logger);
      log({ appId: row.app_id, userId: row.user_id, reason: r.error }, `SSO sync: ${row.action} ${r.kind} (not retried)`);
      continue;
    }
    const expired = Date.now() - new Date(row.first_enqueued_at).getTime() >= RETRY_WINDOW_MS;
    await db('sso_sync_queue').where({ id: row.id }).update({
      status: expired ? 'failed' : 'pending',
      next_attempt_at: new Date(Date.now() + backoffMs(row.attempts)),
      locked_until: null,
      last_status: r.httpStatus,
      last_error: r.error,
    });
    logger.warn({ appId: row.app_id, userId: row.user_id, attempt: row.attempts, error: r.error },
      `SSO sync: ${row.action} not delivered${expired ? ' — giving up after 24 h' : ', will retry'}`);
    if (expired) newlyFailed.push({ ...row, error: r.error });
  }
  await alertAdmins(newlyFailed);
  return rows.length;
}

async function cleanup(): Promise<void> {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_EVERY_MS) return;
  lastCleanup = now;
  await db('sso_sync_queue')
    .whereIn('status', ['done', 'rejected', 'dismissed'])
    .andWhere('done_at', '<', new Date(now - RETENTION_DAYS * 24 * 60 * 60_000))
    .del();
}

async function runLoop(): Promise<void> {
  do {
    rerun = false;
    try {
      // Drain what is due (a batch per pass, bounded passes per kick).
      for (let i = 0; i < 20; i++) {
        const n = await sweepOnce();
        if (n < BATCH) break;
      }
      await cleanup();
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : err }, 'SSO sync queue sweep failed');
    }
  } while (rerun);
}

export const ssoSyncQueue = {
  /** Start the periodic drain (idempotent). Called once by index.ts. */
  start(): void {
    if (timer) return;
    timer = setInterval(() => { void this.kick(); }, POLL_MS);
    timer.unref?.();
    void this.kick();
  },

  stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  },

  /**
   * Deliver what is due now. Called after the routes that change credentials
   * (the rows are already queued by the database trigger); safe to call often.
   */
  kick(): Promise<void> {
    if (running) { rerun = true; return running; }
    running = runLoop().finally(() => { running = null; });
    return running;
  },

  /** Admin view: pending / rejected counts + deliveries given up. */
  async listForAdmin(): Promise<SsoSyncQueueStatus> {
    const counts = await db('sso_sync_queue')
      .whereIn('status', ['pending', 'rejected'])
      .groupBy('status')
      .select('status', db.raw('COUNT(*)::int as n')) as Array<{ status: string; n: number }>;
    const count = (s: string) => Number(counts.find((c) => c.status === s)?.n ?? 0);
    const rows = await db('sso_sync_queue as q')
      .leftJoin('connected_apps as a', 'a.id', 'q.app_id')
      .leftJoin('users as u', 'u.id', 'q.user_id')
      .where('q.status', 'failed')
      .orderBy('q.first_enqueued_at', 'desc')
      .limit(200)
      .select('q.id', 'q.app_id', 'a.name as app_name', 'q.user_id', 'u.username', 'q.action',
        'q.mfa_epoch', 'q.attempts', 'q.first_enqueued_at', 'q.last_attempt_at', 'q.last_status',
        'q.last_error') as Array<{
          id: number; app_id: number; app_name: string | null; user_id: number; username: string | null;
          action: string; mfa_epoch: number | null; attempts: number; first_enqueued_at: Date;
          last_attempt_at: Date | null; last_status: number | null; last_error: string | null;
        }>;
    return {
      pending: count('pending'),
      rejected: count('rejected'),
      failed: rows.map((r) => ({
        id: r.id,
        appId: r.app_id,
        appName: r.app_name,
        userId: r.user_id,
        username: r.username,
        action: r.action,
        mfaEpoch: r.mfa_epoch,
        attempts: r.attempts,
        firstEnqueuedAt: new Date(r.first_enqueued_at).toISOString(),
        lastAttemptAt: r.last_attempt_at ? new Date(r.last_attempt_at).toISOString() : null,
        lastStatus: r.last_status,
        lastError: r.last_error,
      })),
    };
  },

  /**
   * Put a failed delivery back in the queue for a new 24 h window. When a
   * newer change is already pending for the same app and user, that row
   * supersedes it (it carries a higher epoch) and this one is dismissed.
   */
  async retry(id: number): Promise<'requeued' | 'superseded' | 'not_found'> {
    const out = await db.transaction(async (trx) => {
      const row = await trx('sso_sync_queue').where({ id, status: 'failed' })
        .forUpdate().first('id', 'app_id', 'user_id', 'action') as {
          id: number; app_id: number; user_id: number; action: string;
        } | undefined;
      if (!row) return 'not_found' as const;
      const pending = await trx('sso_sync_queue')
        .where({ app_id: row.app_id, user_id: row.user_id, action: row.action, status: 'pending' })
        .first('id');
      if (pending) {
        await trx('sso_sync_queue').where({ id }).update({ status: 'dismissed', done_at: new Date() });
        return 'superseded' as const;
      }
      await trx('sso_sync_queue').where({ id }).update({
        status: 'pending', attempts: 0, first_enqueued_at: new Date(), next_attempt_at: new Date(),
        locked_until: null, alerted_at: null, done_at: null, last_error: null, last_status: null,
      });
      return 'requeued' as const;
    });
    if (out === 'requeued') void this.kick();
    return out;
  },

  /** Acknowledge a failed delivery without retrying it. */
  async dismiss(id: number): Promise<boolean> {
    const n = await db('sso_sync_queue').where({ id, status: 'failed' })
      .update({ status: 'dismissed', done_at: new Date() });
    return n > 0;
  },

  /** Test hook: one pass, synchronously awaited. */
  _sweepOnce: sweepOnce,
};
