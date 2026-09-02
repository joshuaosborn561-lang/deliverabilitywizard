import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import { buildIsolationAction } from "../lib/isolationActions.js";
import type { SpendGateway } from "../lib/spendGateway.js";
import { StateStore } from "../state/store.js";
import {
  IsolationBuyService,
  mailboxesStillNeeded,
  parseInboxkitMailboxCap,
} from "./isolationBuy.js";

function dryConfig() {
  return loadConfig({ DRY_RUN: "1" } as NodeJS.ProcessEnv);
}

function liveConfig() {
  return loadConfig({
    DRY_RUN: "0",
    ISOLATION_MAILBOXES_PER_BUY_DOMAIN: "3",
  } as NodeJS.ProcessEnv);
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

function approvedSpend(): SpendGateway {
  return {
    recordOwnerApproved: async () => ({
      approved: true,
      record: {
        id: "ok",
        requestKey: "k",
        kind: "inboxkit_mailbox_purchase",
        description: "ok",
        detail: {},
        requestedAt: new Date().toISOString(),
        status: "approved",
      },
    }),
    consume: async () => undefined,
  } as unknown as SpendGateway;
}

async function buyStore(): Promise<StateStore> {
  const state = new StateStore(
    `/tmp/dw-iso-buy-${process.pid}-${Date.now()}-${Math.random()}.json`,
  );
  await state.load();
  return state;
}

describe("parseInboxkitMailboxCap / mailboxesStillNeeded", () => {
  it("parses the production InboxKit cap error", () => {
    assert.deepEqual(
      parseInboxkitMailboxCap(
        "Cannot create mailboxes for domain boldercyperpartnerget.info. Maximum 5 mailboxes allowed per domain. Currently has 3 mailboxes.",
      ),
      { max: 5, current: 3 },
    );
  });

  it("computes only the shortfall toward target, capped by vendor max", () => {
    assert.equal(mailboxesStillNeeded(3, 3), 0);
    assert.equal(mailboxesStillNeeded(3, 5), 2);
    assert.equal(mailboxesStillNeeded(0, 3), 3);
    assert.equal(mailboxesStillNeeded(5, 10), 0);
  });
});

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

describe("IsolationBuyService — resume mailbox shortfall", () => {
  it("does not re-buy when the domain already has the target mailbox count", async () => {
    const state = await buyStore();
    const domain = "boldercyperpartnerget.info";
    const now = new Date().toISOString();
    for (const email of [
      "a@boldercyperpartnerget.info",
      "b@boldercyperpartnerget.info",
      "c@boldercyperpartnerget.info",
    ]) {
      state.upsertPoolMailbox({
        email,
        domain,
        platform: "GOOGLE",
        firstName: "A",
        lastName: "B",
        status: "warming",
        warmedAt: now,
      });
    }
    const action = buildIsolationAction({
      kind: "buy_domains",
      title: "resume",
      proof: "proof",
      detail: {
        domains: [domain],
        phase: "awaiting_mailboxes",
        quantity: 1,
      },
    });
    action.status = "executed";
    state.upsertIsolationAction(action);

    let buyCalls = 0;
    const inboxkit = {
      listDomains: async () => [
        {
          name: domain,
          nameserver_match_status: "matched",
          status: "active",
        },
      ],
      listAllMailboxes: async () =>
        ["a", "b", "c"].map((local) => ({
          email: `${local}@${domain}`,
          domain_name: domain,
        })),
      buyMailboxes: async () => {
        buyCalls += 1;
        throw new Error("should not buy");
      },
    };

    const svc = new IsolationBuyService(
      liveConfig(),
      inboxkit as never,
      null,
      state,
      approvedSpend(),
    );
    const finished = await svc.resume();
    assert.equal(buyCalls, 0);
    assert.equal(finished, 1);
    const updated = state.getIsolationAction(action.id)!;
    assert.equal(updated.detail.phase, "complete");
  });

  it("buys only the shortfall when some mailboxes already exist", async () => {
    const state = await buyStore();
    const domain = "partial.get.info";
    state.upsertPoolMailbox({
      email: `one@${domain}`,
      domain,
      platform: "GOOGLE",
      firstName: "One",
      lastName: "Box",
      status: "warming",
      warmedAt: new Date().toISOString(),
    });
    const action = buildIsolationAction({
      kind: "buy_domains",
      title: "resume shortfall",
      proof: "proof",
      detail: {
        domains: [domain],
        phase: "awaiting_mailboxes",
        quantity: 1,
      },
    });
    action.status = "executed";
    state.upsertIsolationAction(action);

    const buys: Array<{ mailboxes: unknown[] }> = [];
    const inboxkit = {
      listDomains: async () => [
        {
          name: domain,
          nameserver_match_status: "matched",
          status: "active",
        },
      ],
      listAllMailboxes: async () => [
        { email: `one@${domain}`, domain_name: domain },
      ],
      buyMailboxes: async (mailboxes: unknown[]) => {
        buys.push({ mailboxes });
        return {};
      },
    };

    const svc = new IsolationBuyService(
      liveConfig(),
      inboxkit as never,
      null,
      state,
      approvedSpend(),
    );
    const finished = await svc.resume();
    assert.equal(finished, 1);
    const totalBought = buys.reduce((n, row) => n + row.mailboxes.length, 0);
    assert.equal(totalBought, 2, "target 3 minus 1 existing");
  });
});
