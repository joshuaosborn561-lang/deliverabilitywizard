/**
 * D303 (LOCKED, Josh 2026-10-25) — v2 port. Shadow-only: every change
 * here is an intended action through WriteGate; WRITE_ENABLED stays off.
 */

import { CANARY_COPY_TEST_PREFIX, AUTO_PLACEMENT_TEST_PREFIX, ESP_MIX_FLOOR_RATIO, INBOX_THRESHOLD, INSIGHT_CLIENT_ID } from "../canon/constants.js";
import { mailboxEspSlot, mailboxWeight } from "./staffable.js";
import { seedEsp, senderEsp } from "./espMatrix.js";
import type { SlimAccount, SpamTest, GenericSeat } from "../types.js";

/* ---------- 1. per-variant tests ---------- */

export interface VariantRef {
  id: number;
  label: string;
}

export function variantsFromSequenceRow(row: Record<string, unknown>): VariantRef[] {
  const lists = [row.sequence_variants, row.seq_variants, row.variants];
  const list = lists.find((l) => Array.isArray(l) && l.length) as Array<Record<string, unknown>> | undefined;
  if (!list) return [];
  const out: VariantRef[] = [];
  list.forEach((v, i) => {
    const id = Number(v.id);
    if (!Number.isFinite(id) || id <= 0) return;
    const label = String(v.variant_label ?? "").trim() || (i < 26 ? String.fromCharCode(65 + i) : String(i + 1));
    out.push({ id, label });
  });
  return out;
}

export function variantSuffix(label: string): string {
  return ` [variant ${label}]`;
}

export function variantLabelOf(name: string | undefined): string | undefined {
  const m = String(name ?? "").match(/\[variant ([^\]]+)\]/);
  return m ? m[1]!.trim() : undefined;
}

export function variantCanaryName(campaignId: number, label: string, campaignName?: string): string {
  const head = `${CANARY_COPY_TEST_PREFIX} #${campaignId}${variantSuffix(label)}`;
  const tail = campaignName?.trim() ? ` ${campaignName.trim()}` : "";
  return `${head}${tail}`.slice(0, Math.max(120, head.length));
}

export function variantAutoName(campaignName: string, label: string): string {
  return `${AUTO_PLACEMENT_TEST_PREFIX} ${campaignName}${variantSuffix(label)}`.slice(0, 120);
}

function living(t: SpamTest): boolean {
  return !/stop|complet|cancel|expir|fail|delet|finish|end/.test(String(t.status ?? "").toLowerCase());
}

/**
 * Variants (beyond the first, which the campaign-level tests cover) that
 * still lack a living placement test and/or canary-copy test.
 */
export function missingVariantTests(opts: {
  campaignId: number;
  campaignName: string;
  variants: VariantRef[];
  tests: SpamTest[];
}): Array<{ label: string; mappingId: number; kind: "placement" | "canary"; name: string }> {
  if (opts.variants.length < 2) return [];
  const out: Array<{ label: string; mappingId: number; kind: "placement" | "canary"; name: string }> = [];
  for (const v of opts.variants.slice(1)) {
    const want = v.label.toUpperCase();
    const mine = opts.tests.filter((t) => living(t) && variantLabelOf(t.name)?.toUpperCase() === want);
    const hasCanary = mine.some((t) => String(t.name ?? "").startsWith(`${CANARY_COPY_TEST_PREFIX} #${opts.campaignId}`));
    const hasAuto = mine.some((t) => String(t.name ?? "").startsWith(`${AUTO_PLACEMENT_TEST_PREFIX} ${opts.campaignName}`));
    if (!hasAuto) out.push({ label: v.label, mappingId: v.id, kind: "placement", name: variantAutoName(opts.campaignName, v.label) });
    if (!hasCanary) out.push({ label: v.label, mappingId: v.id, kind: "canary", name: variantCanaryName(opts.campaignId, v.label, opts.campaignName) });
  }
  return out;
}

/* ---------- 3. ESP rebalance (v2 1/3 floor) ---------- */

/**
 * 1-for-1 swaps that lift the minority ESP to the 1/3 floor. Warm only,
 * same client branded first, then free ledger generics (never Insight,
 * never another client's). POD size never drops.
 */
export function planEspFloorSwaps(opts: {
  clientId: number | null;
  pod: SlimAccount[];
  spares: SlimAccount[];
  generics: GenericSeat[];
  warm: (a: SlimAccount) => boolean;
}): Array<{ out: SlimAccount; in: SlimAccount; inIsGeneric: boolean }> {
  let g = 0;
  let m = 0;
  for (const a of opts.pod) {
    if (mailboxEspSlot(a) === "GOOGLE") g += mailboxWeight(a);
    else m += mailboxWeight(a);
  }
  const total = g + m;
  if (!total || g === 0 || m === 0) return [];
  const floor = total * ESP_MIX_FLOOR_RATIO;
  const lowGoogle = g + 1e-6 < floor;
  const lowMs = m + 1e-6 < floor;
  if (!lowGoogle && !lowMs) return [];
  const need = Math.ceil(floor - (lowGoogle ? g : m));
  const wantGoogle = lowGoogle;
  const freeGeneric = new Set(
    opts.generics.filter((s) => s.assignedClientId == null).map((s) => s.accountId),
  );
  const assigned = new Set(opts.generics.map((s) => s.accountId));
  const genericIds = new Set(opts.generics.map((s) => s.accountId));
  const outs = opts.pod
    .filter((a) => (mailboxEspSlot(a) === "GOOGLE") !== wantGoogle)
    .sort((a, b) => Number(genericIds.has(b.id)) - Number(genericIds.has(a.id)));
  const ins = opts.spares
    .filter((a) => (mailboxEspSlot(a) === "GOOGLE") === wantGoogle && opts.warm(a) && !a.campaignIds.length)
    .filter((a) =>
      freeGeneric.has(a.id)
        ? opts.clientId !== INSIGHT_CLIENT_ID
        : !assigned.has(a.id) && a.clientId != null && a.clientId === opts.clientId,
    )
    .sort((a, b) => Number(freeGeneric.has(a.id)) - Number(freeGeneric.has(b.id)));
  const swaps: Array<{ out: SlimAccount; in: SlimAccount; inIsGeneric: boolean }> = [];
  for (let i = 0; i < need && i < outs.length && i < ins.length; i += 1) {
    swaps.push({ out: outs[i]!, in: ins[i]!, inIsGeneric: freeGeneric.has(ins[i]!.id) });
  }
  return swaps;
}

/* ---------- 5. per-mailbox same-ESP reading ---------- */

/** Same-ESP inbox % per sender from a test's per-sender seed rows. */
export function sameEspInboxBySender(test: SpamTest | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (!test?.senders?.length) return out;
  const tally = new Map<string, { inbox: number; total: number }>();
  for (const row of test.senders) {
    const email = row.email.toLowerCase();
    if (seedEsp(row.provider) !== senderEsp(email)) continue;
    const t = tally.get(email) ?? { inbox: 0, total: 0 };
    t.total += 1;
    if (row.inbox) t.inbox += 1;
    tally.set(email, t);
  }
  for (const [email, t] of tally) if (t.total > 0) out.set(email, (t.inbox / t.total) * 100);
  return out;
}

export function mailboxCauseEmails(readings: Map<string, number>): string[] {
  return [...readings].filter(([, pct]) => pct < INBOX_THRESHOLD).map(([e]) => e);
}
