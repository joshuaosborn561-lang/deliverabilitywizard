import pg from "pg";
import type { CanonQaQueueItem, CanonQaSink } from "./canonQa.js";

/**
 * Inserts into claude.bot_wake_queue (shared-brain Supabase) with the
 * insert+select-only role wake_queue_writer. Configured by
 * WAKE_QUEUE_DATABASE_URL; unset means "no sink" and QA only logs.
 * The connection string is read by name and never logged.
 */
export function createWakeQueueSink(
  env: NodeJS.ProcessEnv = process.env,
): CanonQaSink | null {
  const url = env.WAKE_QUEUE_DATABASE_URL;
  if (!url) return null;
  let pool: pg.Pool | null = null;
  return {
    async enqueue(item: CanonQaQueueItem): Promise<boolean> {
      pool ??= new pg.Pool({
        connectionString: url,
        ssl: { rejectUnauthorized: false },
        max: 1,
        idleTimeoutMillis: 10_000,
        connectionTimeoutMillis: 10_000,
      });
      const res = await pool.query(
        `insert into claude.bot_wake_queue (bot, kind, dedupe_key, headline, payload, source)
         values ('deliverability', $1, $2, $3, $4::jsonb, 'deliverabilitywizard')
         on conflict (bot, dedupe_key) do nothing returning id`,
        [item.kind, item.dedupeKey, item.headline.slice(0, 500), JSON.stringify(item.payload)],
      );
      return (res.rowCount ?? 0) > 0;
    },
  };
}
