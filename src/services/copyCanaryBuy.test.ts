import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { InboxKitClient } from "../clients/inboxkit.js";
import type { PorkbunClient } from "../clients/porkbun.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { GENERIC_POOL_PLAN } from "../data/genericPoolPlan.js";
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

  it("does not buy a second pair when domains are already on an executed action (D60)", async () => {
    const state = new StateStore(
      `/tmp/canary-buy-once-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const prior = buildIsolationAction({
      kind: "buy_canary_fleet",
      title: "Buy the unwarmed canary fleet",
      proof: "proof",
      detail: {
        domains: ["getcrosslaunchco.info", "crosslaunchcoget.info"],
        phase: "awaiting_mailboxes",
      },
    });
    state.upsertIsolationAction({ ...prior, status: "executed" });
    let created = 0;
    const service = new CopyCanaryBuyService(
      loadConfig({ DRY_RUN: "true" }),
      {
        connectNameservers: async () => [],
        listDomains: async () => [],
        buyMailboxes: async () => {
          throw new Error("should not buy mailboxes");
        },
        listAllMailboxes: async () => [],
      } as unknown as InboxKitClient,
      {
        checkDomainThrottled: async () => ({ available: true, price: "9.99" }),
        createDomain: async () => {
          created += 1;
        },
      } as unknown as PorkbunClient,
      {
        listAllEmailAccounts: async () => [],
        configureWarmup: async () => undefined,
      } as unknown as SmartleadClient,
      state,
      {
        recordOwnerApproved: async () => ({ id: "no" }),
        consume: async () => undefined,
      } as unknown as SpendGateway,
    );
    const again = buildIsolationAction({
      kind: "buy_canary_fleet",
      title: "Buy the unwarmed canary fleet",
      proof: "again",
      detail: {},
    });
    again.status = "approved";
    const result = await service.run(again);
    assert.equal(created, 0);
    assert.deepEqual(result.domains, [
      "getcrosslaunchco.info",
      "crosslaunchcoget.info",
    ]);
  });
});

describe("manual fleet adoption (D86)", () => {
  const planDomain = GENERIC_POOL_PLAN.domains[0]!.domain;
  const manualRows = [
    { username: "ava", domain_name: "getcleartechco.info", platform: "GOOGLE", first_name: "Ava", last_name: "Reed", uid: "m1" },
    { username: "eli", domain_name: "getcleartechco.info", platform: "GOOGLE", first_name: "Eli", last_name: "Park", uid: "m2" },
    { username: "mia", domain_name: "getcleartechco.info", platform: "GOOGLE", first_name: "Mia", last_name: "Cole", uid: "m3" },
    { username: "leo", domain_name: "cleartechcoget.info", platform: "MICROSOFT", first_name: "Leo", last_name: "Hale", uid: "m4" },
    { username: "ivy", domain_name: "cleartechcoget.info", platform: "MICROSOFT", first_name: "Ivy", last_name: "Moss", uid: "m5" },
    { username: "kai", domain_name: "cleartechcoget.info", platform: "MICROSOFT", first_name: "Kai", last_name: "Ford", uid: "m6" },
  ];
  const manualEmails = manualRows.map(
    (row) => `${row.username}@${row.domain_name}`,
  );

  function makeService(opts: {
    state: StateStore;
    inboxkitRows?: unknown[];
    smartleadAccounts?: unknown[];
    warmupCalls?: Array<{ id: number; enabled: boolean }>;
    exported?: string[][];
  }) {
    return new CopyCanaryBuyService(
      loadConfig({ DRY_RUN: "false" }),
      {
        listAllMailboxes: async () => opts.inboxkitRows ?? [],
        exportMailboxesToSequencer: async (_seq: string, uids: string[]) => {
          opts.exported?.push(uids);
        },
      } as unknown as InboxKitClient,
      null,
      {
        listAllEmailAccounts: async () => opts.smartleadAccounts ?? [],
        configureWarmup: async (
          id: number,
          settings: { warmup_enabled: boolean },
        ) => {
          opts.warmupCalls?.push({ id, enabled: settings.warmup_enabled });
        },
      } as unknown as SmartleadClient,
      opts.state,
      {} as unknown as SpendGateway,
    );
  }

  it("adopts a hand-bought fleet: registers, maps, turns warmup off, never staffs", async () => {
    const state = new StateStore(
      `/tmp/canary-adopt-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    // A stale planned fleet from an earlier dry run — never actually bought.
    state.setCopyCanaryFleet({
      status: "awaiting_mailboxes",
      domains: ["planned-a.info", "planned-b.info"],
      emails: ["ghost@planned-a.info"],
      updatedAt: "2026-08-20T00:00:00.000Z",
    });
    state.upsertPoolMailbox({
      email: "ghost@planned-a.info",
      domain: "planned-a.info",
      platform: "GOOGLE",
      firstName: "Ghost",
      lastName: "Row",
      status: "available",
      copyCanary: true,
    });
    // A known generic pool mailbox in the same workspace must not be adopted.
    state.upsertPoolMailbox({
      email: `pool@${planDomain}`,
      domain: planDomain,
      platform: "GOOGLE",
      firstName: "Pool",
      lastName: "User",
      status: "available",
    });
    const warmupCalls: Array<{ id: number; enabled: boolean }> = [];
    const service = makeService({
      state,
      inboxkitRows: [
        ...manualRows,
        { username: "pool", domain_name: planDomain, platform: "GOOGLE", uid: "p1" },
      ],
      smartleadAccounts: manualEmails.map((email, index) => ({
        id: 9000 + index,
        from_email: email,
      })),
      warmupCalls,
    });

    const result = await service.adoptManualPurchase();
    assert.ok(result);
    assert.deepEqual([...result!.adopted].sort(), [...manualEmails].sort());
    assert.equal(result!.ready, true);
    const fleet = state.getCopyCanaryFleet();
    assert.deepEqual([...(fleet?.emails ?? [])].sort(), [...manualEmails].sort());
    assert.equal(fleet?.status, "ready");
    assert.equal(fleet?.googleDomain, "getcleartechco.info");
    assert.equal(fleet?.microsoftDomain, "cleartechcoget.info");
    // The stale planned row is gone; the real rows are canary-flagged and
    // mapped, and canary rows never surface as staffing supply.
    assert.equal(state.getPoolMailbox("ghost@planned-a.info"), undefined);
    for (const email of manualEmails) {
      const row = state.getPoolMailbox(email);
      assert.equal(row?.copyCanary, true);
      assert.ok(row?.smartleadAccountId);
    }
    assert.equal(state.findAvailablePoolMailbox("GOOGLE")?.copyCanary, undefined);
    // Warmup written off for the adopted accounts, never on.
    assert.ok(warmupCalls.length >= manualEmails.length);
    assert.ok(warmupCalls.every((call) => call.enabled === false));
    // The generic pool mailbox stayed a generic.
    assert.equal(state.getPoolMailbox(`pool@${planDomain}`)?.copyCanary, undefined);
  });

  it("returns null when the fleet is ready and connected", async () => {
    const state = new StateStore(
      `/tmp/canary-adopt-ready-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    state.setCopyCanaryFleet({
      status: "ready",
      domains: ["getcleartechco.info"],
      emails: manualEmails,
      updatedAt: new Date().toISOString(),
    });
    const service = makeService({ state, inboxkitRows: manualRows });
    assert.equal(await service.adoptManualPurchase(), null);
  });

  it("a stale stuck app purchase does not block adoption; a fresh one defers", async () => {
    const state = new StateStore(
      `/tmp/canary-adopt-stuck-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const stuck = buildIsolationAction({
      kind: "buy_canary_fleet",
      title: "Buy the unwarmed canary fleet",
      proof: "proof",
      detail: { phase: "awaiting_mailboxes", domains: ["old-a.info", "old-b.info"] },
    });
    state.upsertIsolationAction({
      ...stuck,
      status: "executed",
      executedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const service = makeService({
      state,
      inboxkitRows: manualRows,
      smartleadAccounts: manualEmails.map((email, index) => ({
        id: 9100 + index,
        from_email: email,
      })),
      warmupCalls: [],
    });
    const result = await service.adoptManualPurchase();
    assert.ok(result);
    assert.equal(
      result!.adopted.length,
      manualEmails.length,
      "a purchase stuck for days must not block adopting what Josh actually bought",
    );

    const state2 = new StateStore(
      `/tmp/canary-adopt-fresh-${process.pid}-${Date.now()}.json`,
    );
    await state2.load();
    state2.upsertIsolationAction({
      ...buildIsolationAction({
        kind: "buy_canary_fleet",
        title: "Buy the unwarmed canary fleet",
        proof: "proof",
        detail: { phase: "awaiting_mailboxes", domains: ["new-a.info"] },
      }),
      status: "executed",
      executedAt: new Date().toISOString(),
    });
    const service2 = makeService({ state: state2, inboxkitRows: manualRows });
    const deferred = await service2.adoptManualPurchase();
    assert.ok(deferred);
    assert.equal(deferred!.adopted.length, 0);
    assert.match(deferred!.reason ?? "", /in flight/);
  });

  it("a client inbox bought through the same workspace is never adopted", async () => {
    const state = new StateStore(
      `/tmp/canary-adopt-client-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const clientRow = {
      username: "sam",
      domain_name: "parlaytech1.info",
      platform: "GOOGLE",
      uid: "c1",
    };
    const service = makeService({
      state,
      inboxkitRows: [...manualRows, clientRow],
      smartleadAccounts: [
        // Client-tied in Smartlead — client supply, not a canary.
        { id: 500, from_email: "sam@parlaytech1.info", client_id: 777 },
        ...manualEmails.map((email, index) => ({
          id: 9200 + index,
          from_email: email,
        })),
      ],
      warmupCalls: [],
    });
    const result = await service.adoptManualPurchase();
    assert.ok(result);
    assert.deepEqual([...result!.adopted].sort(), [...manualEmails].sort());
    assert.equal(state.getPoolMailbox("sam@parlaytech1.info"), undefined);
  });

  it("adopts nothing when the candidate set is too big to be a fleet buy", async () => {
    const state = new StateStore(
      `/tmp/canary-adopt-many-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const rows = Array.from({ length: COPY_CANARY_FLEET_SIZE * 2 + 1 }, (_, i) => ({
      username: `box${i}`,
      domain_name: `mystery${i}.info`,
      platform: "GOOGLE",
      uid: `x${i}`,
    }));
    const service = makeService({ state, inboxkitRows: rows });
    const result = await service.adoptManualPurchase();
    assert.ok(result);
    assert.equal(result!.adopted.length, 0);
    assert.match(result!.reason ?? "", /too many/);
    assert.equal(state.getCopyCanaryFleet(), null);
  });
});
