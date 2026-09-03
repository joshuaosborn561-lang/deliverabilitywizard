import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { InboxKitClient } from "../clients/inboxkit.js";
import { loadConfig } from "../config.js";
import { buildIsolationAction } from "../lib/isolationActions.js";
import { SpendGateway } from "../lib/spendGateway.js";
import { StateStore } from "../state/store.js";
import {
  INBOXKIT_MAX_MAILBOXES_PER_DOMAIN,
  IsolationBuyService,
  isolationMailboxSpendKey,
  planMailboxOrders,
} from "./isolationBuy.js";

function dryConfig() {
  return loadConfig({ DRY_RUN: "1" } as NodeJS.ProcessEnv);
}

function porkbunAllAvailable() {
  const checked: string[] = [];
  return {
    checked,
    client: {
      checkDomainThrottled: async (domain: string) => {
        checked.push(domain);
        return { available: true, price: "9.99", raw: {} };
      },
    },
  };
}

async function buyStore(): Promise<StateStore> {
  const state = new StateStore(
    `/tmp/dw-iso-buy-${process.pid}-${Date.now()}-${Math.random()}.json`,
  );
  await state.load();
  return state;
}

describe("IsolationBuyService — D161 client-named replace", () => {
  it("retiring a BCP domain buys boldercyperpartner* — never a crosslaunchco spin", async () => {
    const state = await buyStore();
    const porkbun = porkbunAllAvailable();
    const svc = new IsolationBuyService(
      dryConfig(),
      {} as never,
      porkbun.client as never,
      state,
      {} as never,
    );
    const action = buildIsolationAction({
      kind: "buy_domains",
      title: "Replacement for retired boldercyperpartnerpro.info",
      proof: "proof",
      detail: {
        domain: "boldercyperpartnerpro.info",
        retiredDomain: "boldercyperpartnerpro.info",
        // The stock path used to hard-code this generic parent (the incident).
        parentDomain: "crosslaunchco.com",
        quantity: 1,
      },
    });
    const result = await svc.run(action);
    assert.equal(result.domains.length, 1);
    const bought = result.domains[0]!;
    assert.match(bought, /boldercyperpartner/);
    assert.doesNotMatch(bought, /crosslaunchco/);
    assert.ok(
      porkbun.checked.every((d) => d.includes("boldercyperpartner")),
      `Porkbun was asked about generic spins: ${porkbun.checked.join(", ")}`,
    );
    assert.ok(
      !porkbun.checked.some((d) => d.includes("crosslaunchco")),
      "stock path must not even check a generic spin for a client retire",
    );
  });

  it("a generic-pool retire may still buy a crosslaunchco spin", async () => {
    const state = await buyStore();
    const porkbun = porkbunAllAvailable();
    const svc = new IsolationBuyService(
      dryConfig(),
      {} as never,
      porkbun.client as never,
      state,
      {} as never,
    );
    const action = buildIsolationAction({
      kind: "buy_domains",
      title: "Replacement for retired crosslaunchco.com",
      proof: "proof",
      detail: {
        domain: "crosslaunchco.com",
        retiredDomain: "crosslaunchco.com",
        parentDomain: "crosslaunchco.com",
        quantity: 1,
      },
    });
    const result = await svc.run(action);
    assert.equal(result.domains.length, 1);
    assert.match(result.domains[0]!, /crosslaunchco/);
  });
});

describe("planMailboxOrders — reconcile before buy", () => {
  it("already-provisioned MICROSOFT×3 buys nothing", () => {
    const plan = planMailboxOrders(
      ["MICROSOFT", "MICROSOFT", "MICROSOFT"],
      [
        { platform: "MICROSOFT" },
        { platform: "MICROSOFT" },
        { platform: "MICROSOFT" },
      ],
    );
    assert.deepEqual(plan.buy, []);
    assert.equal(plan.alreadyHave, 3);
  });

  it("partial fill only buys the remainder", () => {
    const plan = planMailboxOrders(
      ["MICROSOFT", "MICROSOFT", "MICROSOFT"],
      [{ platform: "MICROSOFT" }],
    );
    assert.deepEqual(plan.buy, [{ platform: "MICROSOFT", count: 2 }]);
    assert.equal(plan.alreadyHave, 1);
  });

  it("never orders more than max-5 minus current", () => {
    const need = Array.from({ length: 5 }, () => "MICROSOFT" as const);
    const plan = planMailboxOrders(need, [
      { platform: "MICROSOFT" },
      { platform: "MICROSOFT" },
      { platform: "MICROSOFT" },
    ]);
    assert.deepEqual(plan.buy, [{ platform: "MICROSOFT", count: 2 }]);
    assert.ok(3 + 2 <= INBOXKIT_MAX_MAILBOXES_PER_DOMAIN);
  });

  it("at the max-5 cap buys nothing even if the plan asked for more", () => {
    const need = Array.from({ length: 5 }, () => "MICROSOFT" as const);
    const plan = planMailboxOrders(
      need,
      Array.from({ length: 5 }, () => ({ platform: "MICROSOFT" as const })),
    );
    assert.deepEqual(plan.buy, []);
    assert.equal(plan.alreadyHave, 5);
  });

  it("unknown-platform rows still count so a full domain is not re-bought", () => {
    const plan = planMailboxOrders(
      ["MICROSOFT", "MICROSOFT", "MICROSOFT"],
      [{ platform: null }, { platform: null }, { platform: null }],
    );
    assert.deepEqual(plan.buy, []);
    assert.equal(plan.alreadyHave, 3);
  });
});

describe("IsolationBuyService.resume — InboxKit inventory reconcile", () => {
  const domain = "boldercyperpartnerget.info";
  const spendKey = isolationMailboxSpendKey(domain, "MICROSOFT", 3);

  function liveConfig(extra: Record<string, string> = {}) {
    return loadConfig({ DRY_RUN: "0", ...extra } as NodeJS.ProcessEnv);
  }

  function microsoftRows(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      username: `box${i + 1}`,
      email: `box${i + 1}@${domain}`,
      domain_name: domain,
      platform: "MICROSOFT",
      first_name: "Box",
      last_name: `N${i + 1}`,
    }));
  }

  function awaitingAction(platforms: string[]) {
    const action = buildIsolationAction({
      kind: "buy_domains",
      title: "Replacement for retired boldercyperpartnerpro.info",
      proof: "proof",
      detail: {
        domain: "boldercyperpartnerpro.info",
        retiredDomain: "boldercyperpartnerpro.info",
        domains: [domain],
        platforms,
        phase: "awaiting_mailboxes",
        quantity: 1,
      },
    });
    action.status = "executed";
    action.decidedBy = "Josh";
    action.executedAt = "2026-09-01T00:00:00.000Z";
    return action;
  }

  function trackingSpend() {
    const approved: string[] = [];
    const consumed: string[] = [];
    return {
      approved,
      consumed,
      gateway: {
        recordOwnerApproved: async (req: { key: string }) => {
          approved.push(req.key);
          return { approved: true, record: { id: req.key, status: "approved" } };
        },
        consume: async (_decision: unknown, req: { key: string }) => {
          consumed.push(req.key);
        },
      } as unknown as SpendGateway,
    };
  }

  function mockInboxkit(opts: {
    rows?: Array<Record<string, unknown>>;
    nameserverStatus?: string;
    buyMailboxes?: (
      batch: Array<{ platform: string; domain_name: string }>,
    ) => Promise<void>;
  }) {
    const buys: Array<{ platform: string; domain: string; count: number }> = [];
    return {
      buys,
      client: {
        listDomains: async () => [
          {
            name: domain,
            nameserver_match_status: opts.nameserverStatus ?? "matched",
          },
        ],
        listMailboxes: async () => opts.rows ?? [],
        buyMailboxes: async (
          batch: Array<{ platform: string; domain_name: string }>,
        ) => {
          if (opts.buyMailboxes) {
            await opts.buyMailboxes(batch);
            return;
          }
          buys.push({
            platform: batch[0]?.platform ?? "",
            domain: batch[0]?.domain_name ?? "",
            count: batch.length,
          });
        },
      } as unknown as InboxKitClient,
    };
  }

  it("already-provisioned domain completes without buy and consumes spend", async () => {
    const state = await buyStore();
    const action = awaitingAction(["MICROSOFT", "MICROSOFT", "MICROSOFT"]);
    state.upsertIsolationAction(action);
    state.upsertSpendApproval({
      id: spendKey,
      requestKey: spendKey,
      kind: "inboxkit_mailbox_purchase",
      description: `Mailboxes on replacement domain ${domain} (MICROSOFT).`,
      detail: { domain, platform: "MICROSOFT", count: 3, actionId: action.id },
      requestedAt: "2026-09-01T00:00:00.000Z",
      status: "approved",
      decidedBy: "Josh",
    });
    const inboxkit = mockInboxkit({
      rows: microsoftRows(3),
      buyMailboxes: async () => {
        throw new Error(
          `Cannot create mailboxes for domain ${domain}. Maximum 5 mailboxes allowed per domain. Currently has 3 mailboxes.`,
        );
      },
    });
    const spend = new SpendGateway(
      state,
      { send: async () => undefined } as never,
      true,
    );
    const svc = new IsolationBuyService(
      liveConfig(),
      inboxkit.client,
      null,
      state,
      spend,
    );

    const finished = await svc.resume();
    assert.equal(finished, 1);
    assert.equal(state.getIsolationAction(action.id)?.detail.phase, "complete");
    assert.equal(state.getSpendApproval(spendKey)?.status, "consumed");
    const pool = state
      .listPoolMailboxes()
      .filter((row) => row.domain === domain);
    assert.equal(pool.length, 3);
    assert.ok(pool.every((row) => row.platform === "MICROSOFT"));
    assert.equal(inboxkit.buys.length, 0);
  });

  it("partial fill only buys the remainder", async () => {
    const state = await buyStore();
    const action = awaitingAction(["MICROSOFT", "MICROSOFT", "MICROSOFT"]);
    state.upsertIsolationAction(action);
    const spend = trackingSpend();
    const inboxkit = mockInboxkit({ rows: microsoftRows(1) });
    const svc = new IsolationBuyService(
      liveConfig(),
      inboxkit.client,
      null,
      state,
      spend.gateway,
    );

    const finished = await svc.resume();
    assert.equal(finished, 1);
    assert.deepEqual(inboxkit.buys, [
      { platform: "MICROSOFT", domain, count: 2 },
    ]);
    assert.ok(spend.consumed.includes(spendKey));
    const pool = state
      .listPoolMailboxes()
      .filter((row) => row.domain === domain);
    assert.equal(pool.length, 3);
  });

  it("clips an over-order against InboxKit max-5", async () => {
    const state = await buyStore();
    const action = awaitingAction(
      Array.from({ length: 5 }, () => "MICROSOFT"),
    );
    state.upsertIsolationAction(action);
    const spend = trackingSpend();
    const inboxkit = mockInboxkit({ rows: microsoftRows(3) });
    const svc = new IsolationBuyService(
      liveConfig({ ISOLATION_MAILBOXES_PER_BUY_DOMAIN: "5" }),
      inboxkit.client,
      null,
      state,
      spend.gateway,
    );

    const finished = await svc.resume();
    assert.equal(finished, 1);
    assert.deepEqual(inboxkit.buys, [
      { platform: "MICROSOFT", domain, count: 2 },
    ]);
    assert.ok(
      inboxkit.buys.every((buy) => buy.count <= 2),
      "must not request 3+ on a domain that already has 3 (3+3>5)",
    );
    const pool = state
      .listPoolMailboxes()
      .filter((row) => row.domain === domain);
    assert.equal(pool.length, 5);
  });

  it("still waits on nameservers when the domain has no mailboxes yet", async () => {
    const state = await buyStore();
    const action = awaitingAction(["MICROSOFT", "MICROSOFT", "MICROSOFT"]);
    state.upsertIsolationAction(action);
    let bought = 0;
    const inboxkit = mockInboxkit({
      rows: [],
      nameserverStatus: "pending",
      buyMailboxes: async () => {
        bought += 1;
        throw new Error("should not buy while nameservers are pending");
      },
    });
    const spend = trackingSpend();
    const svc = new IsolationBuyService(
      liveConfig(),
      inboxkit.client,
      null,
      state,
      spend.gateway,
    );

    const finished = await svc.resume();
    assert.equal(finished, 0);
    assert.equal(bought, 0);
    assert.equal(
      state.getIsolationAction(action.id)?.detail.phase,
      "awaiting_mailboxes",
    );
  });

  it("heals a nameserver-pending domain that already has the mailboxes", async () => {
    const state = await buyStore();
    const action = awaitingAction(["MICROSOFT", "MICROSOFT", "MICROSOFT"]);
    state.upsertIsolationAction(action);
    const inboxkit = mockInboxkit({
      rows: microsoftRows(3),
      nameserverStatus: "pending",
      buyMailboxes: async () => {
        throw new Error("should not buy when inventory already fills the plan");
      },
    });
    const spend = trackingSpend();
    const svc = new IsolationBuyService(
      liveConfig(),
      inboxkit.client,
      null,
      state,
      spend.gateway,
    );

    const finished = await svc.resume();
    assert.equal(finished, 1);
    assert.equal(state.getIsolationAction(action.id)?.detail.phase, "complete");
    assert.equal(state.listPoolMailboxes().length, 3);
  });

  it("D174: a failed buy with no domain is retryable and resume purchases", async () => {
    const state = await buyStore();
    const action = buildIsolationAction({
      kind: "buy_domains",
      title: "Replacement for retired meetconnectapp.com",
      proof: "proof",
      detail: {
        domain: "meetconnectapp.com",
        retiredDomain: "meetconnectapp.com",
        ownerKind: "client",
        ownerClientId: 548611,
        ownerClientName: "Goliath Cybersecurity",
        phase: "awaiting_purchase",
        quantity: 1,
      },
    });
    action.status = "approved";
    action.decidedBy = "Josh";
    action.error = "1 out of 1 checks within 10 seconds used.";
    state.upsertIsolationAction(action);
    assert.ok(
      state.pendingIsolationActions().some((row) => row.id === action.id),
      "stuck buy surfaces in the pending queue",
    );

    const porkbun = porkbunAllAvailable();
    const svc = new IsolationBuyService(
      dryConfig(),
      {} as never,
      porkbun.client as never,
      state,
      {} as never,
    );
    const finished = await svc.resume();
    assert.equal(finished, 1);
    const next = state.getIsolationAction(action.id);
    assert.equal(next?.status, "executed");
    assert.ok(Array.isArray(next?.detail.domains) && next.detail.domains.length);
    assert.match(String(next?.detail.domains[0] ?? ""), /goliath/);
    assert.doesNotMatch(String(next?.detail.domains[0] ?? ""), /crosslaunchco/);
  });
});
