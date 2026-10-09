/**
 * D252 — pick a pool generic without pinning the event loop.
 *
 * `StateStore.findReassignablePoolMailbox` does `Object.values(pool).find(canTake)`
 * on every attempt. A short campaign that cannot fill walks the whole pool
 * synchronously (prod 2026-10-09: 15–36s slices on ~800+ pool rows). Walk a
 * cached list, skip emails already rejected for this predicate, and yield.
 */

import { yieldEventLoop } from "./stringifyYielding.js";

export const POOL_PICK_YIELD_EVERY = 16;

export interface ReassignablePoolMailbox {
  email: string;
  platform: "GOOGLE" | "MICROSOFT";
  status: string;
  copyCanary?: boolean;
}

export function isReassignablePoolMailbox(
  mailbox: ReassignablePoolMailbox,
  platform: "GOOGLE" | "MICROSOFT",
  opts: {
    isCopyCanary?: (email: string) => boolean;
    getRestingInbox?: (email: string) => unknown;
  } = {},
): boolean {
  if (mailbox.platform !== platform) return false;
  if (mailbox.status !== "available" && mailbox.status !== "assigned") return false;
  if (mailbox.copyCanary) return false;
  if (opts.isCopyCanary?.(mailbox.email)) return false;
  if (opts.getRestingInbox?.(mailbox.email)) return false;
  return true;
}

export async function findReassignablePoolMailboxYielding<
  T extends ReassignablePoolMailbox,
>(
  mailboxes: readonly T[],
  platforms: Array<"GOOGLE" | "MICROSOFT">,
  canTake: (email: string) => boolean,
  opts: {
    rejected?: Set<string>;
    yieldEvery?: number;
    signal?: AbortSignal;
    isCopyCanary?: (email: string) => boolean;
    getRestingInbox?: (email: string) => unknown;
  } = {},
): Promise<T | undefined> {
  const yieldEvery = Math.max(1, opts.yieldEvery ?? POOL_PICK_YIELD_EVERY);
  const rejected = opts.rejected;
  let n = 0;
  for (const platform of platforms) {
    for (const mailbox of mailboxes) {
      if (opts.signal?.aborted) return undefined;
      n += 1;
      if (n % yieldEvery === 0) await yieldEventLoop();
      const key = mailbox.email.trim().toLowerCase();
      if (rejected?.has(key)) continue;
      if (!isReassignablePoolMailbox(mailbox, platform, opts)) continue;
      if (canTake(mailbox.email)) return mailbox;
      rejected?.add(key);
    }
  }
  return undefined;
}
