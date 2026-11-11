/**
 * D331 proof — offline. Loads the pre-deletion Smartlead backup and computes,
 * for every campaign and every mailbox, the owner the wizard derives under
 * the OLD logic (today's client_id) and the NEW logic (client_id forced to
 * null everywhere, i.e. after the client spaces are deleted; owner from
 * sg-owner tags + the committed mailbox seed). Then runs the real downstream
 * functions (resolveAccountClient, isGenericMailbox, ownedNamedClientIdForSeat,
 * dedicatedGenericClientId, buildPods, client-scoped campaign lists, per-client
 * totals) on both and diffs them. No network.
 *
 *   npx tsx scripts/ownership-diff.ts [backupDir] [outJson]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  clientDisplayName,
  resolveAccountClient,
  type SmartleadClientRecord,
} from "../src/clients/smartlead.js";
import {
  emptyOwnershipOverrides,
  legacyClientRecords,
  resolveAccountOwner,
  resolveCampaignOwner,
  seedById,
} from "../src/lib/ownership.js";
import { isGenericMailbox } from "../src/lib/clientInbox.js";
import { ownedNamedClientIdForSeat } from "../src/lib/podOwnedInventory.js";
import { dedicatedGenericClientId } from "../src/lib/dedicatedGeneric.js";
import { buildPods, type PodAccountInput } from "../src/lib/pods.js";

const dir = process.argv[2] ?? "/workspace/key-deletion-audit/spaces-backup";
const out = process.argv[3] ?? "/workspace/key-deletion-audit/wizard-ownership-diff.json";

type Tag = { tag_id?: number; tag_name?: string };
type Campaign = { id: number; name: string; status: string; client_id: number | null; tags?: Tag[] };
type Account = {
  id: number;
  from_email: string;
  from_name?: string;
  signature?: string;
  type?: string;
  client_id: number | null;
  tags?: Tag[];
  campaign_ids?: number[];
};

const load = <T>(f: string): T => JSON.parse(readFileSync(join(dir, f), "utf8")) as T;
const campaigns = load<Campaign[]>("campaigns_list.json");
const accounts = load<Account[]>("email_accounts.json");
const oldClients = load<SmartleadClientRecord[]>("clients.json");

// campaign id -> [{id, from_email, client_id}]  (optional)
const membershipFile = join(dir, "campaign_email_accounts.json");
const accountCampaigns = new Map<number, number[]>();
let membershipLoaded = false;
if (existsSync(membershipFile)) {
  const raw = JSON.parse(readFileSync(membershipFile, "utf8")) as
    | Record<string, Array<{ id: number }>>
    | Array<{ campaign_id: number; accounts?: Array<{ id: number }>; email_accounts?: Array<{ id: number }> }>;
  const entries: Array<[number, Array<{ id: number }>]> = Array.isArray(raw)
    ? raw.map((r) => [r.campaign_id, r.accounts ?? r.email_accounts ?? []])
    : Object.entries(raw).map(([k, v]) => [Number(k), Array.isArray(v) ? v : []]);
  for (const [cid, list] of entries) {
    for (const a of list) {
      const arr = accountCampaigns.get(a.id) ?? [];
      arr.push(cid);
      accountCampaigns.set(a.id, arr);
    }
  }
  membershipLoaded = true;
}

const campaignById = new Map(campaigns.map((c) => [c.id, c]));

// ---------------- campaigns ----------------
const book = emptyOwnershipOverrides();
const oldCampaignOwner = new Map<number, number | null>();
const newCampaignOwner = new Map<number, number | null>();
const campaignRows: Array<Record<string, unknown>> = [];
for (const c of campaigns) {
  const oldOwner = typeof c.client_id === "number" ? c.client_id : null;
  const resolved = resolveCampaignOwner({ ...c, client_id: null }, { overrides: book });
  oldCampaignOwner.set(c.id, oldOwner);
  newCampaignOwner.set(c.id, resolved.clientId);
  campaignRows.push({
    id: c.id,
    name: c.name,
    status: c.status,
    old: oldOwner,
    new: resolved.clientId,
    slug: resolved.slug,
    reason: resolved.reason,
    same: oldOwner === resolved.clientId,
  });
}

// ---------------- mailboxes ----------------
const newClients = legacyClientRecords().map((r) => ({ ...r, logo: r.logo ?? undefined }));
const oldClientsById = new Map(oldClients.map((c) => [c.id, c]));
const newClientsById = new Map(newClients.map((c) => [c.id, c as SmartleadClientRecord]));
const seed = seedById();
const stubState = { getPoolMailbox: () => undefined, isMarkerClientId: () => false };
const stubConfig = { extraGenericMailboxes: [], extraGenericDomains: [], prewarmedDomains: [] };

// Campaign views for ownedNamedClientIdForSeat.
const oldCampaignView = new Map(
  campaigns.map((c) => [c.id, { id: c.id, name: c.name, client_id: oldCampaignOwner.get(c.id) ?? null }]),
);
const newCampaignView = new Map(
  campaigns.map((c) => [c.id, { id: c.id, name: c.name, client_id: newCampaignOwner.get(c.id) ?? null }]),
);

const mailboxRows: Array<Record<string, unknown>> = [];
const oldPodInputs: PodAccountInput[] = [];
const newPodInputs: PodAccountInput[] = [];
for (const a of accounts) {
  const cids = accountCampaigns.get(a.id) ?? [];
  const oldAcc = { ...a, campaign_ids: cids };
  const resolved = resolveAccountOwner(
    { ...a, client_id: null, campaign_ids: cids },
    { overrides: book, seed, campaignOwner: (cid) => newCampaignOwner.get(cid) },
  );
  const newAcc = { ...a, client_id: resolved.clientId, campaign_ids: cids };

  const oldResolve = resolveAccountClient(oldAcc as never, oldCampaignOwner, oldClientsById);
  const newResolve = resolveAccountClient(newAcc as never, newCampaignOwner, newClientsById);
  const email = a.from_email.toLowerCase();
  const oldGeneric = isGenericMailbox(oldAcc as never, email, stubConfig as never, stubState as never);
  const newGeneric = isGenericMailbox(newAcc as never, email, stubConfig as never, stubState as never);
  const oldSeat = ownedNamedClientIdForSeat({
    account: oldAcc as never,
    email,
    campaignIds: cids,
    campaignById: oldCampaignView,
  });
  const newSeat = ownedNamedClientIdForSeat({
    account: newAcc as never,
    email,
    campaignIds: cids,
    campaignById: newCampaignView,
  });
  const oldDedicated = dedicatedGenericClientId(oldAcc as never, email, stubState);
  const newDedicated = dedicatedGenericClientId(newAcc as never, email, stubState);

  const onActive = membershipLoaded
    ? cids.some((cid) => campaignById.get(cid)?.status === "ACTIVE")
    : true;
  const base = {
    accountId: a.id,
    email,
    fromName: a.from_name,
    type: a.type,
    tags: a.tags as never,
    onActiveCampaign: onActive,
    resting: false,
  };
  oldPodInputs.push({ ...base, clientId: oldResolve.clientId, clientName: oldResolve.clientName });
  newPodInputs.push({ ...base, clientId: newResolve.clientId, clientName: newResolve.clientName });

  const diffs: string[] = [];
  if ((a.client_id ?? null) !== resolved.clientId) diffs.push("owner");
  if (oldResolve.clientId !== newResolve.clientId) diffs.push("resolveAccountClient.clientId");
  if (oldResolve.clientName !== newResolve.clientName) diffs.push("resolveAccountClient.clientName");
  if (oldGeneric !== newGeneric) diffs.push("isGenericMailbox");
  if (oldSeat !== newSeat) diffs.push("ownedNamedClientIdForSeat");
  if (oldDedicated !== newDedicated) diffs.push("dedicatedGenericClientId");
  mailboxRows.push({
    id: a.id,
    from_email: email,
    old: a.client_id ?? null,
    new: resolved.clientId,
    slug: resolved.slug,
    reason: resolved.reason,
    oldName: oldResolve.clientName,
    newName: newResolve.clientName,
    oldGeneric,
    newGeneric,
    oldSeatOwner: oldSeat,
    newSeatOwner: newSeat,
    diffs,
    same: diffs.length === 0,
  });
}

// ---------------- downstream aggregates ----------------
const podState = { getPoolMailbox: () => undefined };
const podIso = { emails: new Set<string>(), domain: null } as never;
const now = new Date("2026-11-11T17:00:00Z");
const podSig = (inputs: PodAccountInput[]) =>
  Object.fromEntries(
    buildPods({ accounts: inputs, config: stubConfig as never, state: podState as never, isolation: podIso, now }).map(
      (p) => [p.id, { name: p.name, clientId: p.clientId, n: p.mailboxes.length, ids: p.mailboxes.map((m) => m.accountId).sort((x, y) => x - y) }],
    ),
  );
const oldPods = podSig(oldPodInputs);
const newPods = podSig(newPodInputs);
const podDiffs: string[] = [];
for (const id of new Set([...Object.keys(oldPods), ...Object.keys(newPods)])) {
  if (JSON.stringify(oldPods[id]) !== JSON.stringify(newPods[id])) podDiffs.push(id);
}

const totals = (owner: (id: number) => number | null, ids: number[]) => {
  const t: Record<string, number> = {};
  for (const id of ids) {
    const k = String(owner(id));
    t[k] = (t[k] ?? 0) + 1;
  }
  return t;
};
const oldCampaignTotals = totals((id) => oldCampaignOwner.get(id) ?? null, campaigns.map((c) => c.id));
const newCampaignTotals = totals((id) => newCampaignOwner.get(id) ?? null, campaigns.map((c) => c.id));
const oldMailboxTotals: Record<string, number> = {};
const newMailboxTotals: Record<string, number> = {};
for (const r of mailboxRows) {
  oldMailboxTotals[String(r.old)] = (oldMailboxTotals[String(r.old)] ?? 0) + 1;
  newMailboxTotals[String(r.new)] = (newMailboxTotals[String(r.new)] ?? 0) + 1;
}
const clientScopedLists: Record<string, { old: number; new: number; added: number[]; removed: number[] }> = {};
for (const client of oldClients) {
  const o = campaigns.filter((c) => c.client_id === client.id).map((c) => c.id);
  const n = campaigns.filter((c) => newCampaignOwner.get(c.id) === client.id).map((c) => c.id);
  clientScopedLists[client.id] = {
    old: o.length,
    new: n.length,
    added: n.filter((id) => !o.includes(id)),
    removed: o.filter((id) => !n.includes(id)),
  };
}
const displayNames = oldClients.map((c) => ({
  id: c.id,
  old: clientDisplayName(c),
  new: clientDisplayName(newClientsById.get(c.id)),
}));

const campaignDiffs = campaignRows.filter((r) => !r.same);
const mailboxDiffs = mailboxRows.filter((r) => !r.same);
const report = {
  generatedAt: new Date().toISOString(),
  inputs: { dir, campaigns: campaigns.length, accounts: accounts.length, membershipLoaded, membershipAccounts: accountCampaigns.size },
  campaigns: { identical: campaignRows.length - campaignDiffs.length, different: campaignDiffs.length, differences: campaignDiffs },
  mailboxes: { identical: mailboxRows.length - mailboxDiffs.length, different: mailboxDiffs.length, differences: mailboxDiffs },
  mailboxReasonCounts: mailboxRows.reduce<Record<string, number>>((acc, r) => {
    acc[String(r.reason)] = (acc[String(r.reason)] ?? 0) + 1;
    return acc;
  }, {}),
  pools: {
    oldGenericCount: mailboxRows.filter((r) => r.oldGeneric).length,
    newGenericCount: mailboxRows.filter((r) => r.newGeneric).length,
    oldUnassigned: mailboxRows.filter((r) => r.old === null).length,
    newUnassigned: mailboxRows.filter((r) => r.new === null).length,
    clientOwnedNowPool: mailboxRows.filter((r) => r.old !== null && r.new === null).map((r) => r.id),
  },
  buildPods: { identical: podDiffs.length === 0, differingPods: podDiffs, old: oldPods, new: newPods },
  totals: {
    campaignsByClient: { old: oldCampaignTotals, new: newCampaignTotals },
    mailboxesByClient: { old: oldMailboxTotals, new: newMailboxTotals },
  },
  clientScopedLists,
  displayNames: { identical: displayNames.every((d) => d.old === d.new), rows: displayNames },
  campaignRows,
  mailboxRows,
};
writeFileSync(out, JSON.stringify(report, null, 1));
console.log(
  JSON.stringify(
    {
      out,
      membershipLoaded,
      campaigns: { identical: report.campaigns.identical, different: report.campaigns.different },
      mailboxes: { identical: report.mailboxes.identical, different: report.mailboxes.different },
      mailboxReasonCounts: report.mailboxReasonCounts,
      pools: { ...report.pools, clientOwnedNowPool: report.pools.clientOwnedNowPool.length },
      buildPodsIdentical: report.buildPods.identical,
      differingPods: podDiffs,
      displayNamesIdentical: report.displayNames.identical,
      clientScopedListChanges: Object.fromEntries(
        Object.entries(clientScopedLists).filter(([, v]) => v.added.length || v.removed.length),
      ),
      campaignDifferences: campaignDiffs.map((r) => `${r.id} ${r.status} ${r.old}->${r.new} (${r.reason}/${r.slug}) ${r.name}`),
      mailboxDifferences: mailboxDiffs.map((r) => `${r.id} ${r.from_email} ${r.old}->${r.new} ${r.reason} [${(r.diffs as string[]).join(",")}]`),
    },
    null,
    1,
  ),
);
