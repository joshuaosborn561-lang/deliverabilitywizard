/**
 * D176 — deploy heal for attach blocks. Live retire/cover asks and
 * retired history already mean "stay off"; persist them so restaff
 * still refuses after the Slack card resolves. Also seed the known
 * production hole (`boldercyperpartnertop.info`) so a human unlink
 * is not the only writer.
 */
import {
  isolationAskBlocksDomain,
  mergeAttachBlock,
  normalizeAttachDomain,
  type AttachBlockReason,
  type AttachBlockRecord,
  type IsolationAskForBlock,
} from "./attachBlock.js";

export interface KnownAttachBlockSeed {
  domain: string;
  emails: string[];
  accountIds: number[];
  reason: AttachBlockReason;
  source: string;
}

/**
 * 2026-09-08 — QA unlinked these three from BCP HC #3763800 + SEG
 * #3897350 after INFRA; live attachBlocks was missing the domain
 * entirely so fan-out put them back every 15–60 minutes.
 */
export const KNOWN_ATTACH_BLOCK_SEEDS: readonly KnownAttachBlockSeed[] = [
  {
    domain: "boldercyperpartnertop.info",
    emails: [
      "jeremy@boldercyperpartnertop.info",
      "hugo@boldercyperpartnertop.info",
      "kim@boldercyperpartnertop.info",
    ],
    accountIds: [21442842, 21442456, 21442382],
    reason: "burned",
    source: "heal:d176-2026-09-08",
  },
];

export interface AttachBlockHealStore {
  upsertAttachBlock(incoming: {
    domain: string;
    emails?: Iterable<string>;
    accountIds?: Iterable<number>;
    reason: AttachBlockReason;
    source?: string;
    blockedAt?: string;
  }): AttachBlockRecord;
  listAttachBlocks(): AttachBlockRecord[];
  listIsolationActions(): IsolationAskForBlock[];
  listDomainHistory(): Array<{ domain: string; status?: string }>;
}

function fingerprint(block: AttachBlockRecord): string {
  return JSON.stringify({
    domain: block.domain,
    emails: block.emails,
    accountIds: block.accountIds,
    reason: block.reason,
  });
}

export function persistLiveAskAttachBlocks(
  store: Pick<AttachBlockHealStore, "upsertAttachBlock" | "listIsolationActions">,
): string[] {
  const wrote: string[] = [];
  for (const action of store.listIsolationActions()) {
    const domain = normalizeAttachDomain(
      String(action.detail.domain ?? action.detail.retiredDomain ?? ""),
    );
    if (!domain) continue;
    if (!isolationAskBlocksDomain(domain, [action])) continue;
    store.upsertAttachBlock({
      domain,
      reason: action.kind === "retire_domain" ? "burned" : "sender_blocked",
      source: `ask:${action.kind}:${action.status}`,
    });
    wrote.push(domain);
  }
  return wrote;
}

export function persistRetiredHistoryAttachBlocks(
  store: Pick<AttachBlockHealStore, "upsertAttachBlock" | "listDomainHistory">,
): string[] {
  const wrote: string[] = [];
  for (const row of store.listDomainHistory()) {
    if (row.status !== "retired" && row.status !== "retire_pending") continue;
    const domain = normalizeAttachDomain(row.domain);
    if (!domain) continue;
    store.upsertAttachBlock({
      domain,
      reason: "burned",
      source: `history:${row.status}`,
    });
    wrote.push(domain);
  }
  return wrote;
}

export function persistKnownSeedAttachBlocks(
  store: Pick<AttachBlockHealStore, "upsertAttachBlock">,
  seeds: readonly KnownAttachBlockSeed[] = KNOWN_ATTACH_BLOCK_SEEDS,
): string[] {
  const wrote: string[] = [];
  for (const seed of seeds) {
    const domain = normalizeAttachDomain(seed.domain);
    if (!domain) continue;
    store.upsertAttachBlock({
      domain,
      emails: seed.emails,
      accountIds: seed.accountIds,
      reason: seed.reason,
      source: seed.source,
    });
    wrote.push(domain);
  }
  return wrote;
}

export function healAttachBlocks(store: AttachBlockHealStore): {
  domains: string[];
  wrote: number;
} {
  const before = new Map(
    store.listAttachBlocks().map((block) => [block.domain, fingerprint(block)]),
  );
  persistLiveAskAttachBlocks(store);
  persistRetiredHistoryAttachBlocks(store);
  persistKnownSeedAttachBlocks(store);
  const changed = store
    .listAttachBlocks()
    .filter((block) => before.get(block.domain) !== fingerprint(block))
    .map((block) => block.domain)
    .sort();
  return { domains: changed, wrote: changed.length };
}

/** Test helper — merge a seed the same way boot does. */
export function seedAttachBlockRecord(
  existing: AttachBlockRecord | undefined,
  seed: KnownAttachBlockSeed,
): AttachBlockRecord {
  return mergeAttachBlock(existing, seed);
}
