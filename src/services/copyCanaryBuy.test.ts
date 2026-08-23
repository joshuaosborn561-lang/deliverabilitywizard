import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { InboxKitClient } from "../clients/inboxkit.js";
import type { PorkbunClient } from "../clients/porkbun.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { COPY_CANARY_FLEET_SIZE } from "../lib/copyCanaryFleet.js";
import { buildIsolationAction } from "../lib/isolationActions.js";
import type { SpendGateway } from "../lib/spendGateway.js";
import { StateStore } from "../state/store.js";
import { CopyCanaryBuyService } from "./copyCanaryBuy.js";

describe("CopyCanaryBuyService", () => {
  it("buys two domains, three Google then three Outlook, and never enables warmup", async () => {
    const state = new StateStore(
      `/tmp/canary-buy-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const mailboxBatches: Array<{
      platform: string;
      domain: string;
      count: number;
    }> = [];
    const warmup: boolean[] = [];
    const bought: string[] = [];
    const porkbun = {
      checkDomainThrottled: async (domain: string) => ({
        available: true,
        price: "9.99",
        domain,
      }),
      createDomain: async (domain: string) => {
        bought.push(domain);
      },
      updateNameservers: async () => undefined,
    } as unknown as PorkbunClient;
    const inboxkit = {
      connectNameservers: async (domains: string[]) =>
        domains.map((domain) => ({
          domain,
          nameservers: ["ns1.inboxkit.com", "ns2.inboxkit.com"],
        })),
      listDomains: async () =>
        bought.map((name) => ({
          name,
          nameserver_match_status: "matched",
        })),
      buyMailboxes: async (
        batch: Array<{ platform: string; domain_name: string }>,
      ) => {
        mailboxBatches.push({
          platform: batch[0]?.platform ?? "",
          domain: batch[0]?.domain_name ?? "",
          count: batch.length,
        });
      },
      listAllMailboxes: async () => [],
      exportMailboxesToSequencer: async () => undefined,
    } as unknown as InboxKitClient;
    const smartlead = {
      listAllEmailAccounts: async () => [],
      configureWarmup: async (
        _id: number,
        settings: { warmup_enabled: boolean },
      ) => {
        warmup.push(settings.warmup_enabled);
      },
    } as unknown as SmartleadClient;
    const spend = {
      recordOwnerApproved: async () => ({ id: "ok" }),
      consume: async () => undefined,
    } as unknown as SpendGateway;

    const service = new CopyCanaryBuyService(
      loadConfig({ DRY_RUN: "false" }),
      inboxkit,
      porkbun,
      smartlead,
      state,
      spend,
    );
    const action = buildIsolationAction({
      kind: "buy_canary_fleet",
      title: "Buy the unwarmed canary fleet",
      proof: "proof",
      detail: { parentDomain: "crosslaunchco.com" },
    });
    action.status = "approved";
    action.decidedBy = "Josh";
    state.upsertIsolationAction(action);

    const result = await service.run(action);
    assert.equal(result.domains.length, 2);
    assert.equal(mailboxBatches.length, 2);
    assert.equal(mailboxBatches[0]?.platform, "GOOGLE");
    assert.equal(mailboxBatches[0]?.count, 3);
    assert.equal(mailboxBatches[1]?.platform, "MICROSOFT");
    assert.equal(mailboxBatches[1]?.count, 3);
    assert.equal(result.emails.length, COPY_CANARY_FLEET_SIZE);
    assert.equal(state.getCopyCanaryFleet()?.emails.length, 6);
    assert.ok(warmup.every((enabled) => enabled === false));
    for (const email of result.emails) {
      assert.equal(state.getPoolMailbox(email)?.copyCanary, true);
      assert.equal(state.isCopyCanary(email), true);
    }
    assert.equal(
      state.findAvailablePoolMailbox("GOOGLE")?.copyCanary,
      undefined,
    );
  });

  it("dry-run still records a Google + Outlook fleet and does not spend", async () => {
    const state = new StateStore(
      `/tmp/canary-buy-dry-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    let spent = 0;
    const service = new CopyCanaryBuyService(
      loadConfig({ DRY_RUN: "true" }),
      {
        connectNameservers: async () => [],
        listDomains: async () => [],
        buyMailboxes: async () => {
          throw new Error("should not buy in dry-run");
        },
        listAllMailboxes: async () => [],
      } as unknown as InboxKitClient,
      {
        checkDomainThrottled: async () => ({ available: true, price: "9.99" }),
        createDomain: async () => {
          throw new Error("should not register in dry-run");
        },
      } as unknown as PorkbunClient,
      {
        listAllEmailAccounts: async () => [],
        configureWarmup: async () => undefined,
      } as unknown as SmartleadClient,
      state,
      {
        recordOwnerApproved: async () => {
          spent += 1;
          return { id: "no" };
        },
        consume: async () => {
          spent += 1;
        },
      } as unknown as SpendGateway,
    );
    const action = buildIsolationAction({
      kind: "buy_canary_fleet",
      title: "Buy the unwarmed canary fleet",
      proof: "proof",
      detail: {},
    });
    action.status = "approved";
    const result = await service.run(action);
    assert.equal(result.domains.length, 2);
    assert.equal(result.emails.length, 6);
    assert.equal(spent, 0);
    assert.equal(state.getCopyCanaryFleet()?.googleDomain, result.domains[0]);
    assert.equal(
      state.getCopyCanaryFleet()?.microsoftDomain,
      result.domains[1],
    );
  });
});
