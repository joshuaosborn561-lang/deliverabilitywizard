/**
 * D334 — mailbox health history, one JSON file per snapshot date under
 * `<state dir>/mailbox-health/YYYY-MM-DD.json`, rows keyed by mailbox
 * email. Kept out of `/data/state.json` on purpose: ~120 days × the
 * whole fleet would re-bloat the full dump D257 cut down.
 *
 * Writing a date replaces that date's file atomically (tmp + rename), so
 * a re-run for the same date overwrites. Files older than the retention
 * window are deleted on every write.
 */
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  addDays,
  isYmd,
  type MailboxHealthHistory,
  type MailboxHealthRow,
  type MailboxHealthTrend,
} from "../lib/mailboxHealthDaily.js";

export interface MailboxHealthDay {
  date: string;
  generatedAt: string;
  /** Keyed by lowercase mailbox email. */
  rows: Record<string, MailboxHealthRow>;
  trends: MailboxHealthTrend[];
  /** True when name-wise health metrics returned nothing for the day. */
  metricsMissing?: boolean;
}

export class MailboxHealthStore {
  private seq = 0;

  constructor(private readonly dir: string) {}

  static forStateFile(stateFilePath: string): MailboxHealthStore {
    return new MailboxHealthStore(path.join(path.dirname(stateFilePath), "mailbox-health"));
  }

  private fileFor(date: string): string {
    if (!isYmd(date)) throw new Error(`invalid date ${date}`);
    return path.join(this.dir, `${date}.json`);
  }

  async write(day: MailboxHealthDay): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const target = this.fileFor(day.date);
    const tmp = `${target}.${process.pid}.${++this.seq}.tmp`;
    await writeFile(tmp, JSON.stringify(day));
    await rename(tmp, target);
  }

  async read(date: string): Promise<MailboxHealthDay | null> {
    if (!isYmd(date)) return null;
    try {
      const parsed = JSON.parse(await readFile(this.fileFor(date), "utf8")) as MailboxHealthDay;
      return parsed && typeof parsed === "object" && parsed.rows ? parsed : null;
    } catch {
      return null;
    }
  }

  /** Stored snapshot dates, oldest first. */
  async dates(): Promise<string[]> {
    try {
      return (await readdir(this.dir))
        .map((f) => f.replace(/\.json$/, ""))
        .filter((f) => isYmd(f))
        .sort();
    } catch {
      return [];
    }
  }

  async latest(): Promise<MailboxHealthDay | null> {
    const all = await this.dates();
    return all.length ? this.read(all[all.length - 1]!) : null;
  }

  /** `days` calendar days ending at `endDate` (inclusive), as a history map. */
  async history(endDate: string, days: number): Promise<MailboxHealthHistory> {
    const out: MailboxHealthHistory = new Map();
    for (let i = 0; i < days; i += 1) {
      const date = addDays(endDate, -i);
      const day = await this.read(date);
      if (day) out.set(date, new Map(Object.entries(day.rows)));
    }
    return out;
  }

  /** Delete snapshot files older than `retentionDays` before `today`. */
  async prune(today: string, retentionDays: number): Promise<string[]> {
    const cutoff = addDays(today, -retentionDays);
    const dropped: string[] = [];
    for (const date of await this.dates()) {
      if (date >= cutoff) continue;
      try {
        await unlink(this.fileFor(date));
        dropped.push(date);
      } catch {
        /* already gone */
      }
    }
    return dropped;
  }
}
