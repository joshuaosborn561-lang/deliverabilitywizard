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

  it("D134/D150: retiring a domain approves generic backfill and buys an ESP-matched replacement", async () => {
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
    const buyCalls: unknown[] = [];
    const sl = {
      listCampaigns: async () => [
        { id: 10, name: "Goliath X", status: "ACTIVE" },
        { id: 11, name: "Old thing", status: "PAUSED" },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 21,
          from_email: "a@burned.info",
          type: "OUTLOOK",
          campaign_ids: [10, 11],
        },
        {
          id: 22,
          from_email: "b@burned.info",
          type: "OUTLOOK",
          campaign_ids: [10],
        },
        { id: 23, from_email: "safe@clean.info", type: "GMAIL", campaign_ids: [10] },
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
      {
        run: async (buyAction: { detail: Record<string, unknown> }) => {
          buyCalls.push(buyAction.detail);
          return {
            domains: ["fresh.info"],
            mailboxesOrdered: 3,
            awaitingNameservers: false,
          };
        },
      } as never,
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
    assert.equal(buyCalls.length, 1, "D150: retire also buys the replacement");
    const detail = buyCalls[0] as {
      platforms?: string[];
      espMix?: { GOOGLE: number; MICROSOFT: number };
    };
    assert.deepEqual(detail.espMix, { GOOGLE: 0, MICROSOFT: 2 });
    assert.ok(
      detail.platforms?.every((p) => p === "MICROSOFT"),
      `replacement mailboxes match retired ESP mix: ${detail.platforms}`,
    );
  });

  it("D161: retiring a BCP domain buys a boldercyperpartner parent, not crosslaunchco", async () => {
    const state = new StateStore(
      `/tmp/dw-iso-retire-bcp-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const action = buildIsolationAction({
      kind: "retire_domain",
      title: "Retire boldercyperpartnerpro.info",
      proof: "proof",
      detail: { domain: "boldercyperpartnerpro.info" },
    });
    state.upsertIsolationAction(action);
    const buyCalls: Array<Record<string, unknown>> = [];
    const sl = {
      listCampaigns: async () => [
        { id: 10, name: "BCP Outbound", status: "ACTIVE", client_id: 542838 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 21,
          from_email: "a@boldercyperpartnerpro.info",
          type: "GMAIL",
          client_id: 542838,
          campaign_ids: [10],
        },
      ],
      removeEmailAccountsFromCampaign: async () => undefined,
    };
    const svc = mkExec(
      loadConfig({} as NodeJS.ProcessEnv),
      sl as never,
      { send: async () => undefined } as never,
      state,
      {
        run: async (buyAction: { detail: Record<string, unknown> }) => {
          buyCalls.push(buyAction.detail);
          return {
            domains: ["getboldercyperpartner.info"],
            mailboxesOrdered: 3,
            awaitingNameservers: false,
          };
        },
      } as never,
    );

    const outcome = await svc.decide(action.id, "approve", {
      name: "Josh",
      role: "owner",
    });
    assert.equal(outcome.ok, true);
    assert.equal(buyCalls.length, 1);
    const parent = String(buyCalls[0]?.parentDomain ?? "");
    assert.match(parent, /boldercyperpartner/);
    assert.doesNotMatch(parent, /crosslaunchco/);
    assert.equal(
      buyCalls[0]?.retiredDomain,
      "boldercyperpartnerpro.info",
    );
  });

  it("D174: a pending retire for a protected client cannot execute", async () => {
    const state = new StateStore(
      `/tmp/dw-iso-retire-prot-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const action = buildIsolationAction({
      kind: "retire_domain",
      title: "Retire meetconnectnow.com",
      proof: "proof",
      detail: { domain: "meetconnectnow.com" },
    });
    state.upsertIsolationAction(action);
    const removed: Array<[number, number[]]> = [];
    const sl = {
      listCampaigns: async () => [
        { id: 10, name: "Goliath X", status: "ACTIVE", client_id: 548611 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 21,
          from_email: "a@meetconnectnow.com",
          type: "GMAIL",
          client_id: 548611,
          campaign_ids: [10],
        },
      ],
      listClients: async () => [
        { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" },
      ],
      removeEmailAccountsFromCampaign: async (
        campaignId: number,
        accountIds: number[],
      ) => {
        removed.push([campaignId, accountIds]);
      },
    };
    const sent: string[] = [];
    const buyCalls: unknown[] = [];
    const svc = mkExec(
      loadConfig({} as NodeJS.ProcessEnv),
      sl as never,
      {
        send: async (text: string) => void sent.push(text),
        notifyIsolationAction: async () => undefined,
      } as never,
      state,
      {
        run: async (buyAction: { detail: Record<string, unknown> }) => {
          buyCalls.push(buyAction.detail);
          return {
            domains: ["getgoliathcybersecurity.info"],
            mailboxesOrdered: 3,
            awaitingNameservers: false,
          };
        },
      } as never,
    );

    const outcome = await svc.decide(action.id, "approve", {
      name: "Josh",
      role: "owner",
    });
    assert.equal(outcome.ok, true);
    assert.deepEqual(removed, [], "protected retire must not pull inboxes");
    assert.equal(state.getIsolationAction(action.id)?.status, "denied");
    assert.match(state.getIsolationAction(action.id)?.error ?? "", /D174/);
    assert.ok(
      buyCalls.length >= 1,
      "degrades to a cover replacement buy",
    );
    assert.ok(sent.some((text) => /Did not retire/i.test(text)));
  });

  it("D174: a buy that fails after the pull stays awaiting_purchase", async () => {
    const state = new StateStore(
      `/tmp/dw-iso-retire-retry-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const action = buildIsolationAction({
      kind: "retire_domain",
      title: "Retire boldercyperpartnerpro.info",
      proof: "proof",
      detail: { domain: "boldercyperpartnerpro.info" },
    });
    state.upsertIsolationAction(action);
    const sl = {
      listCampaigns: async () => [
        { id: 10, name: "BCP X", status: "ACTIVE", client_id: 542838 },
      ],
      listAllEmailAccounts: async () => [
        {
          id: 21,
          from_email: "a@boldercyperpartnerpro.info",
          type: "GMAIL",
          client_id: 542838,
          campaign_ids: [10],
        },
      ],
      listClients: async () => [
        { id: 542838, name: "BCP", logo: "Bolder Cyper Partner" },
      ],
      removeEmailAccountsFromCampaign: async () => undefined,
    };
    const svc = mkExec(
      loadConfig({} as NodeJS.ProcessEnv),
      sl as never,
      { send: async () => undefined } as never,
      state,
      {
        run: async () => {
          throw new Error("1 out of 1 checks within 10 seconds used.");
        },
      } as never,
    );

    const outcome = await svc.decide(action.id, "approve", {
      name: "Josh",
      role: "owner",
    });
    assert.equal(outcome.ok, true);
    const buy = state
      .listIsolationActions()
      .find((row) => row.kind === "buy_domains");
    assert.ok(buy, "retire still opens a replacement buy");
    assert.equal(buy?.status, "approved");
    assert.equal(buy?.detail.phase, "awaiting_purchase");
    assert.match(buy?.error ?? "", /10 seconds/);
    assert.ok(
      state.pendingIsolationActions().some((row) => row.id === buy?.id),
      "failed buy surfaces in the pending queue",
    );
  });
});

describe("D137 — the isolation-domain buy arms the rig", () => {
  it("an approved buy stamps the state domain the rig reads", async () => {
    const state = new StateStore(
      `/tmp/dw-iso-arm-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const action = buildIsolationAction({
      kind: "buy_isolation_domain",
      title: "Arm the word-hunt rig: buy its isolation domain",
      proof: "proof",
      detail: { quantity: 1, isolationRig: true },
    });
    state.upsertIsolationAction(action);
    const svc = mkExec(
      loadConfig({} as NodeJS.ProcessEnv),
      {} as never,
      { send: async () => undefined } as never,
      state,
      {
        run: async () => ({
          domains: ["hunthouse.info"],
          mailboxesOrdered: 3,
          awaitingNameservers: false,
        }),
      } as never,
    );

    const denied = await svc.decide(action.id, "approve", {
      name: "Cayden",
      role: "operator",
    });
    assert.equal(denied.ok, false, "spend stays owner-only");

    const outcome = await svc.decide(action.id, "approve", {
      name: "Josh",
      role: "owner",
    });
    assert.equal(outcome.ok, true);
    assert.equal(
      state.getIsolation().isolationDomain?.domain,
      "hunthouse.info",
      "the rig reads this domain on its next pass (D137)",
    );
    assert.equal(state.getIsolationAction(action.id)?.status, "executed");
  });
});
