/**
 * D299 — a health-loop stage that freeze-exits repeatedly must not be
 * the leftover every cycle.
 *
 * Production 2026-10-23: campaign-health killed the process ~20 times.
 * `saveHot` during the freeze flush timed out, so lastOk never advanced,
 * and D215 resume started every boot at campaign-health. The prefix was
 * skipped and the tail never ran.
 *
 * Strikes live in a tiny file next to state.json. The write is synchronous
 * and happens before the slow sidecar flush. A successful `recordStageOk`
 * clears that stage. Thresholds are not widened.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const FREEZE_STRIKE_LIMIT = 3;
export const FREEZE_QUARANTINE_MS = 60 * 60 * 1000;

export interface FreezeStrikeRow {
  count: number;
  lastAt: string;
  quarantineUntil: string | null;
}

export interface FreezeStrikeBook {
  version: 1;
  stages: Record<string, FreezeStrikeRow>;
}

export function freezeStrikesPath(stateFilePath: string): string {
  return path.join(path.dirname(stateFilePath), "freeze-strikes.json");
}

function emptyBook(): FreezeStrikeBook {
  return { version: 1, stages: {} };
}

export function readFreezeStrikes(stateFilePath: string): FreezeStrikeBook {
  try {
    const parsed = JSON.parse(
      readFileSync(freezeStrikesPath(stateFilePath), "utf8"),
    ) as FreezeStrikeBook;
    if (
      !parsed ||
      parsed.version !== 1 ||
      !parsed.stages ||
      typeof parsed.stages !== "object" ||
      Array.isArray(parsed.stages)
    ) {
      return emptyBook();
    }
    return { version: 1, stages: { ...parsed.stages } };
  } catch {
    return emptyBook();
  }
}

function writeBook(stateFilePath: string, book: FreezeStrikeBook): void {
  const target = freezeStrikesPath(stateFilePath);
  mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(book));
  renameSync(tmp, target);
}

/**
 * Count one freeze exit for `stage`. The third strike (and every strike
 * after that) quarantines the stage for FREEZE_QUARANTINE_MS from now,
 * so a later freeze renews the window instead of waiting out another
 * three kills.
 */
export function noteFreezeStrike(
  stateFilePath: string,
  stage: string,
  now = Date.now(),
): FreezeStrikeBook {
  const book = readFreezeStrikes(stateFilePath);
  const prev = book.stages[stage];
  const count = (prev?.count ?? 0) + 1;
  book.stages[stage] = {
    count,
    lastAt: new Date(now).toISOString(),
    quarantineUntil:
      count >= FREEZE_STRIKE_LIMIT
        ? new Date(now + FREEZE_QUARANTINE_MS).toISOString()
        : (prev?.quarantineUntil ?? null),
  };
  writeBook(stateFilePath, book);
  return book;
}

/** Drop the stage's strikes. No file is created when it had none. */
export function clearFreezeStrike(stateFilePath: string, stage: string): void {
  const book = readFreezeStrikes(stateFilePath);
  if (!book.stages[stage]) return;
  delete book.stages[stage];
  writeBook(stateFilePath, book);
}

export function quarantinedStageNames(
  stateFilePath: string,
  now = Date.now(),
): string[] {
  const book = readFreezeStrikes(stateFilePath);
  const names: string[] = [];
  for (const [name, row] of Object.entries(book.stages)) {
    const until = Date.parse(row?.quarantineUntil ?? "");
    if (Number.isFinite(until) && until > now) names.push(name);
  }
  return names;
}
