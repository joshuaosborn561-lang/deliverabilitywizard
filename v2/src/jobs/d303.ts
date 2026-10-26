/**
 * D303 (LOCKED) — v2 shadow intents for rest-then-burn and per-variant
 * tests. Nothing here writes: every change is WriteGate.intend.
 */

import { INSIGHT_CLIENT_ID } from "../canon/constants.js";
import {
  decideRest,
  markReturned,
  restCoveringFor,
  restsDueBack,
  withCoveringGeneric,
} from "../lib/mailboxRest.js";
import { missingVariantTests } from "../lib/d303.js";
import { owesWarmup, podOf, onWeekPod } from "../lib/staffable.js";
import { burnedRetireReason } from "../lib/retireReason.js";
import { intendSpend } from "./spend.js";
import type { AppConfig } from "../config.js";
import type { WriteGate } from "../shadow.js";
import type { V2Store } from "../store.js";
import type { IntendedAction, InventoryBook, SequenceSample, SlimCampaign, SpamTest } from "../types.js";

async function push(
  intended: IntendedAction[],
  gate: WriteGate,
  opts: Parameters<WriteGate["intend"]>[0],
): Promise<void> {
  intended.push((await gate.intend(opts)).action);
}

/** Rest each mailbox-cause sender; burn on repeat. Returns emails handled. */
export async function restMailboxIntents(opts: {
  campaign: SlimCampaign;
  causes: Array<{ email: string; sameEspInbox: number }>;
  book: InventoryBook;
  store: V2Store;
  gate: WriteGate;
  config: AppConfig;
  intended: IntendedAction[];
  now: Date;
}): Promise<string[]> {
  const handled: string[] = [];
  const rests = new Map((await opts.store.listMailboxRests()).map((r) => [r.email, r]));
  const generics = await opts.store.listGenerics();
  const covering = new Set([...rests.values()].map((r) => r.coveringGeneric).filter(Boolean));
  for (const cause of opts.causes) {
    const account = opts.book.accounts.find((a) => a.email.toLowerCase() === cause.email);
    if (!account || opts.campaign.clientId == null) continue;
    const campaignIds = [...new Set([...account.campaignIds, opts.campaign.id])];
    const decision = decideRest({
      email: account.email,
      accountId: account.id,
      clientId: opts.campaign.clientId,
      pod: podOf(account) ?? onWeekPod(opts.now),
      sameEspInbox: cause.sameEspInbox,
      campaignIds,
      existing: rests.get(account.email.toLowerCase()),
      now: opts.now,
    });
    if (decision.action === "none") continue;
    handled.push(account.email.toLowerCase());
    for (const cid of campaignIds) {
      await push(opts.intended, opts.gate, {
        kind: "detach",
        campaignId: cid,
        accountId: account.id,
        email: account.email,
        payload: { reason: decision.action === "rest" ? "d303_rest" : "d303_burned", keepWarmup: true },
        run: async () => undefined,
      });
    }
    let record = decision.record;
    if (decision.action === "rest" && record.clientId !== INSIGHT_CLIENT_ID) {
      const free = generics.find(
        (g) =>
          g.assignedClientId == null &&
          !covering.has(g.email) &&
          (() => {
            const a = opts.book.accounts.find((x) => x.id === g.accountId);
            return a ? !owesWarmup(a, [], opts.now.getTime()) : false;
          })(),
      );
      if (free) {
        covering.add(free.email);
        record = withCoveringGeneric(record, free.email);
        for (const cid of campaignIds) {
          await push(opts.intended, opts.gate, {
            kind: "attach",
            campaignId: cid,
            accountId: free.accountId,
            email: free.email,
            payload: {
              reason: "d303_rest_cover",
              ledger: { clientId: record.clientId, pod: record.pod, coveringFor: [restCoveringFor(record)] },
            },
            run: async () => undefined,
          });
        }
      }
    }
    if (decision.action === "burn") {
      const domain = account.email.split("@")[1] ?? "";
      opts.intended.push(
        await intendSpend(
          {
            id: `d303-burn-${account.email.toLowerCase()}`,
            kind: "retire_domain",
            clientId: record.clientId,
            amountUsd: opts.config.spendCapDomainUsd,
            payload: {
              domain,
              email: account.email,
              reason: burnedRetireReason({ domain, isolationVerdict: "INFRA" }),
              burnReason: record.burnReason,
              needsApproval: true,
            },
          },
          opts.gate,
          opts.config,
        ),
      );
    }
    await opts.store.upsertMailboxRest(record);
  }
  return handled;
}

/** After 14 days: mailbox back on, covering generic out (warm-swap style). */
export async function returnDueRestIntents(opts: {
  book: InventoryBook;
  store: V2Store;
  gate: WriteGate;
  intended: IntendedAction[];
  now: Date;
}): Promise<number> {
  const due = restsDueBack(await opts.store.listMailboxRests(), opts.now);
  const generics = await opts.store.listGenerics();
  for (const record of due) {
    for (const cid of record.removedFromCampaigns) {
      await push(opts.intended, opts.gate, {
        kind: "attach",
        campaignId: cid,
        accountId: record.accountId ?? undefined,
        email: record.email,
        payload: { reason: "d303_rest_over" },
        run: async () => undefined,
      });
      const g = generics.find((x) => x.email === record.coveringGeneric);
      if (g) {
        await push(opts.intended, opts.gate, {
          kind: "detach",
          campaignId: cid,
          accountId: g.accountId,
          email: g.email,
          payload: { reason: "d303_rest_over_release_generic", ledgerRelease: true },
          run: async () => undefined,
        });
      }
    }
    await opts.store.upsertMailboxRest(markReturned(record, opts.now));
  }
  return due.length;
}

/** Per-variant placement + canary-copy test_create intents. */
export async function variantTestIntents(opts: {
  campaign: SlimCampaign;
  sequences: SequenceSample[];
  tests: SpamTest[];
  gate: WriteGate;
  intended: IntendedAction[];
}): Promise<number> {
  const rows = opts.sequences.filter((s) => s.campaignId === opts.campaign.id);
  const step = rows.find((s) => s.seqNumber === 1) ?? rows[0];
  const variants = step?.variants ?? [];
  const missing = missingVariantTests({
    campaignId: opts.campaign.id,
    campaignName: opts.campaign.name,
    variants,
    tests: opts.tests,
  });
  for (const m of missing) {
    await push(opts.intended, opts.gate, {
      kind: "test_create",
      campaignId: opts.campaign.id,
      payload: { name: m.name, variant: m.label, sequenceMappingId: m.mappingId, testKind: m.kind, reason: "d303_per_variant" },
      run: async () => undefined,
    });
  }
  return missing.length;
}
