import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import { StateStore } from "../state/store.js";
import { IsolationExecuteService, replaceInSequence } from "./isolationExecute.js";
import { buildIsolationAction } from "../lib/isolationActions.js";
import type { InventoryBook } from "./inventory.js";

/** D132/D133 — a test book reading the same fake client, one attempt. */
function bookOf(sl: unknown): InventoryBook {
  const client = sl as {
    listCampaigns?: () => Promise<unknown[]>;
    listAllEmailAccounts?: (o?: unknown) => Promise<unknown[]>;
    listClients?: () => Promise<unknown[]>;
  };
  return {
    get: async () => ({
      campaigns:
        typeof client.listCampaigns === "function"
          ? await client.listCampaigns()
          : [],
      accounts:
        typeof client.listAllEmailAccounts === "function"
          ? await client.listAllEmailAccounts({ fetchCampaigns: true })
          : [],
      clients:
        typeof client.listClients === "function"
          ? await client.listClients().catch(() => [])
          : [],
      fetchedAt: Date.now(),
    }),
  } as unknown as InventoryBook;
}

function mkExec(
  ...args: [
    ConstructorParameters<typeof IsolationExecuteService>[0],
    ConstructorParameters<typeof IsolationExecuteService>[1],
    ConstructorParameters<typeof IsolationExecuteService>[2],
    ConstructorParameters<typeof IsolationExecuteService>[3],
    ConstructorParameters<typeof IsolationExecuteService>[4],
    ConstructorParameters<typeof IsolationExecuteService>[6]?,
  ]
): IsolationExecuteService {
  const [config, sl, slack, state, buy, canaryBuy] = args;
  return new IsolationExecuteService(
    config,
    sl,
    slack,
    state,
    buy,
    bookOf(sl),
    canaryBuy,
  );
}

describe("IsolationExecuteService", () => {
  it("replaces only the recovered word in the sequence", () => {
    const next = replaceInSequence(
      {
        id: 1,
        subject: "Free consult",
        email_body: "We have a free consult this week.",
        sequence_variants: [
          { subject: "Free consult", email_body: "A free chat." },
        ],
      },
      "free",
      "complimentary",
    );
    assert.equal(next.subject, "complimentary consult");
    assert.match(next.email_body ?? "", /complimentary consult/);
    assert.doesNotMatch(next.email_body ?? "", /free/i);
  });

  it("Cayden cannot approve a buy or retire", async () => {
    const state = new StateStore(
      `/tmp/dw-iso-exec-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const buy = buildIsolationAction({
      kind: "buy_domains",
      title: "Buy a replacement",
      proof: "proof",
      detail: { domain: "crosslaunchco.com", quantity: 1 },
    });
    const canary = buildIsolationAction({
      kind: "buy_canary_fleet",
      title: "Buy the unwarmed canary fleet",
      proof: "proof",
      detail: { quantity: 2 },
    });
    const retire = buildIsolationAction({
      kind: "retire_domain",
      title: "Retire it",
      proof: "proof",
      detail: { domain: "crosslaunchco.com" },
    });
    state.upsertIsolationAction(buy);
    state.upsertIsolationAction(canary);
    state.upsertIsolationAction(retire);
    const svc = mkExec(
      loadConfig({} as NodeJS.ProcessEnv),
      {} as never,
      { send: async () => undefined } as never,
      state,
      { run: async () => ({ domains: [], mailboxesOrdered: 0, awaitingNameservers: false }) } as never,
    );
    const buyDenied = await svc.decide(buy.id, "approve", {
      name: "Cayden",
      role: "operator",
    });
    const canaryDenied = await svc.decide(canary.id, "approve", {
      name: "Cayden",
      role: "operator",
    });
    const retireDenied = await svc.decide(retire.id, "approve", {
      name: "Cayden",
      role: "operator",
    });
    assert.equal(buyDenied.ok, false);
    assert.equal(canaryDenied.ok, false);
    assert.equal(retireDenied.ok, false);
    assert.equal(state.getIsolationAction(buy.id)?.status, "pending");
    assert.equal(state.getIsolationAction(canary.id)?.status, "pending");
  });

  it("a second Josh tap on an already-bought canary fleet is not an error", async () => {
    const state = new StateStore(
      `/tmp/dw-iso-exec-again-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const action = buildIsolationAction({
      kind: "buy_canary_fleet",
      title: "Buy the unwarmed canary fleet",
      proof: "proof",
      detail: {
        quantity: 2,
        domains: ["getcrosslaunchco.info", "crosslaunchcoget.info"],
      },
    });
    state.upsertIsolationAction({
      ...action,
      status: "executed",
      decidedBy: "Josh",
    });
    const svc = mkExec(
      loadConfig({} as NodeJS.ProcessEnv),
      {} as never,
      { send: async () => undefined } as never,
      state,
      { run: async () => ({ domains: [], mailboxesOrdered: 0, awaitingNameservers: false }) } as never,
    );
    const result = await svc.decide(action.id, "approve", {
      name: "Josh",
      role: "owner",
    });
    assert.equal(result.ok, true);
    assert.match(result.message, /Already done/);
    assert.match(result.message, /getcrosslaunchco\.info/);
  });

  it("an approved signature ask appends the tag and writes nothing else (D85)", async () => {
    const state = new StateStore(
      `/tmp/dw-iso-exec-sig-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const action = buildIsolationAction({
      kind: "add_signature_tag",
      title: "%signature% missing on Acme",
      proof: "step 1 A is missing %signature%",
      detail: { campaignId: 42, campaignName: "Acme" },
    });
    state.upsertIsolationAction(action);
    const body = "<div>Sean, that offer's still open</div>";
    let written: unknown = null;
    const svc = mkExec(
      loadConfig({} as NodeJS.ProcessEnv),
      {
        getCampaignSequences: async () => [
          {
            id: 1,
            seq_number: 1,
            sequence_variants: [
              { id: 11, variant_label: "A", subject: "hey", email_body: body },
            ],
          },
        ],
        updateCampaignSequences: async (_id: number, sequences: unknown) => {
          written = sequences;
        },
      } as never,
      { send: async () => undefined } as never,
      state,
      { run: async () => ({ domains: [], mailboxesOrdered: 0, awaitingNameservers: false }) } as never,
    );
    // Operator tier: Cayden may approve a copy-safe signature append.
    const result = await svc.decide(action.id, "approve", {
      name: "Cayden",
      role: "operator",
    });
    assert.equal(result.ok, true);
    assert.equal(state.getIsolationAction(action.id)?.status, "executed");
    const sequences = written as Array<{
      sequence_variants: Array<{ email_body: string; subject: string }>;
    }>;
    assert.ok(sequences);
    assert.equal(
      sequences[0]!.sequence_variants[0]!.email_body,
      `${body}<br><br>%signature%`,
    );
    assert.equal(sequences[0]!.sequence_variants[0]!.subject, "hey");
  });

  it("a bulk signature approve fixes every listed campaign in one tap (D87)", async () => {
    const state = new StateStore(
      `/tmp/dw-iso-exec-sig-bulk-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const action = buildIsolationAction({
      kind: "add_signature_tag",
      title: "%signature% missing on 2 campaigns",
      proof: "bulk",
      detail: {
        campaignIds: [42, 43],
        campaigns: [
          { id: 42, name: "SalesGlider" },
          { id: 43, name: "Positive" },
        ],
      },
    });
    state.upsertIsolationAction(action);
    const written = new Map<number, unknown>();
    const svc = mkExec(
      loadConfig({} as NodeJS.ProcessEnv),
      {
        getCampaignSequences: async (id: number) => [
          {
            id: 1,
            seq_number: 1,
            email_body: `<div>campaign ${id} body</div>`,
          },
        ],
        updateCampaignSequences: async (id: number, sequences: unknown) => {
          written.set(id, sequences);
        },
      } as never,
      { send: async () => undefined } as never,
      state,
      { run: async () => ({ domains: [], mailboxesOrdered: 0, awaitingNameservers: false }) } as never,
    );
    const result = await svc.decide(action.id, "approve", {
      name: "Josh",
      role: "owner",
    });
    assert.equal(result.ok, true);
    assert.equal(state.getIsolationAction(action.id)?.status, "executed");
    assert.deepEqual([...written.keys()].sort(), [42, 43]);
    for (const id of [42, 43]) {
      const sequences = written.get(id) as Array<{ email_body: string }>;
      assert.equal(
        sequences[0]!.email_body,
        `<div>campaign ${id} body</div><br><br>%signature%`,
      );
    }
  });

  it("a signature ask on already-tagged copy writes nothing", async () => {
    const state = new StateStore(
      `/tmp/dw-iso-exec-sig-noop-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const action = buildIsolationAction({
      kind: "add_signature_tag",
      title: "%signature% missing on Acme",
      proof: "stale finding",
      detail: { campaignId: 43, campaignName: "Acme" },
    });
    state.upsertIsolationAction(action);
    let wrote = false;
    const svc = mkExec(
      loadConfig({} as NodeJS.ProcessEnv),
      {
        getCampaignSequences: async () => [
          {
            id: 1,
            seq_number: 1,
            email_body: "<div>open?</div><div>%signature%</div>",
          },
        ],
        updateCampaignSequences: async () => {
          wrote = true;
        },
      } as never,
      { send: async () => undefined } as never,
      state,
      { run: async () => ({ domains: [], mailboxesOrdered: 0, awaitingNameservers: false }) } as never,
    );
    const result = await svc.decide(action.id, "approve", {
      name: "Josh",
      role: "owner",
    });
    assert.equal(result.ok, true);
    assert.equal(wrote, false);
    assert.equal(state.getIsolationAction(action.id)?.status, "executed");
  });

  it("Josh or Cayden can deny a word swap without editing copy", async () => {
    const state = new StateStore(
      `/tmp/dw-iso-exec-deny-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const action = buildIsolationAction({
      kind: "swap_copy",
      title: "Switch the word",
      proof: "proof",
      detail: { campaignId: 9, element: "free", swap: "complimentary" },
    });
    state.upsertIsolationAction(action);
    let wrote = false;
    const svc = mkExec(
      loadConfig({} as NodeJS.ProcessEnv),
      {
        getCampaignSequences: async () => {
          wrote = true;
          return [];
        },
        updateCampaignSequences: async () => {
          wrote = true;
        },
      } as never,
      { send: async () => undefined } as never,
      state,
      { run: async () => ({ domains: [], mailboxesOrdered: 0, awaitingNameservers: false }) } as never,
    );
    const result = await svc.decide(action.id, "deny", {
      name: "Cayden",
      role: "operator",
    });
    assert.equal(result.ok, true);
    assert.equal(state.getIsolationAction(action.id)?.status, "denied");
    assert.equal(wrote, false);
  });
});

describe("D133/D134 — the taps act fleet-wide", () => {
  it("D133: one approved word swap edits every ACTIVE campaign carrying it, nothing else", async () => {
    const state = new StateStore(
      `/tmp/dw-iso-fleet-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const action = buildIsolationAction({
      kind: "swap_copy",
      title: "It was “free” on Goliath A",
      proof: "proof",
      detail: {
        campaignId: 1,
        campaignName: "Goliath A",
        element: "free",
        swap: "complimentary",
      },
    });
    state.upsertIsolationAction(action);
    const writes = new Map<number, unknown[]>();
    const sl = {
      listCampaigns: async () => [
        { id: 1, name: "Goliath A", status: "ACTIVE" },
        { id: 2, name: "Goliath B", status: "ACTIVE" },
        { id: 3, name: "Paused carrier", status: "PAUSED" },
        { id: 4, name: "Canary shell: #1 Goliath A", status: "ACTIVE" },
        { id: 5, name: "TechEvo C", status: "ACTIVE" },
      ],
      getCampaignSequences: async (id: number) => [
        {
          id: 100 + id,
          subject: id === 2 ? "A clean subject" : "Free consult",
          email_body:
            id === 2 ? "Nothing to see." : "We have a free consult this week.",
        },
      ],
      updateCampaignSequences: async (id: number, sequences: unknown[]) => {
        writes.set(id, sequences);
      },
    };
    const sent: string[] = [];
    const svc = mkExec(
      loadConfig({} as NodeJS.ProcessEnv),
      sl as never,
      { send: async (text: string) => void sent.push(text) } as never,
      state,
      {} as never,
    );

    const outcome = await svc.decide(action.id, "approve", {
      name: "Cayden",
      role: "operator",
    });
    assert.equal(outcome.ok, true);
    assert.deepEqual([...writes.keys()].sort(), [1, 5], "only ACTIVE carriers");
    const first = writes.get(1) as Array<{ subject?: string; email_body?: string }>;
    assert.match(first[0]?.subject ?? "", /complimentary consult/i);
    assert.doesNotMatch(first[0]?.email_body ?? "", /free/i);
    assert.ok(
      sent.some((text) => /2 ACTIVE campaign/.test(text)),
      `announce names both edits: ${sent.join(" | ")}`,
    );
    assert.equal(
      state.getIsolationAction(action.id)?.status,
      "executed",
      "the tap finished",
    );
  });

  it("D134: retiring a domain approves generic backfill for the campaigns it cut", async () => {
    const state = new StateStore(
      `/tmp/dw-iso-retire-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const action = buildIsolationAction({
      kind: "retire_domain",
      title: "Retire burned.info",
      proof: "proof",
      detail: { domain: "burned.info" },
    });
    state.upsertIsolationAction(action);
    const removed: Array<[number, number[]]> = [];
    const sl = {
      listCampaigns: async () => [
        { id: 10, name: "Goliath X", status: "ACTIVE" },
        { id: 11, name: "Old thing", status: "PAUSED" },
      ],
      listAllEmailAccounts: async () => [
        { id: 21, from_email: "a@burned.info", campaign_ids: [10, 11] },
        { id: 22, from_email: "b@burned.info", campaign_ids: [10] },
        { id: 23, from_email: "safe@clean.info", campaign_ids: [10] },
      ],
      removeEmailAccountsFromCampaign: async (
        campaignId: number,
        accountIds: number[],
      ) => {
        removed.push([campaignId, accountIds]);
      },
    };
    const svc = mkExec(
      loadConfig({} as NodeJS.ProcessEnv),
      sl as never,
      { send: async () => undefined } as never,
      state,
      {} as never,
    );

    const outcome = await svc.decide(action.id, "approve", {
      name: "Josh",
      role: "owner",
    });
    assert.equal(outcome.ok, true);
    assert.deepEqual(
      removed.map(([campaignId]) => campaignId),
      [10, 10],
      "only ACTIVE memberships are pulled",
    );
    const approval = state.getGenericBackfillApproval(10);
    assert.equal(approval?.approvedBy, "retire:burned.info");
    assert.equal(
      state.getGenericBackfillApproval(11),
      undefined,
      "a paused campaign gets no approval",
    );
  });
});
