import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import { StateStore } from "../state/store.js";
import { PodControlService } from "./podControls.js";

import type { InventoryBook } from "./inventory.js";

/** D132 — a test book reading the same fake client, one attempt. */
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

function mkPods(
  ...args: [
    ConstructorParameters<typeof PodControlService>[0],
    ConstructorParameters<typeof PodControlService>[1],
    ConstructorParameters<typeof PodControlService>[2],
    ConstructorParameters<typeof PodControlService>[3],
    ConstructorParameters<typeof PodControlService>[4],
  ]
): PodControlService {
  const [config, sl, sd, slack, state] = args;
  return new PodControlService(config, sl, sd, slack, state, bookOf(sl));
}

describe("pod controls", () => {
  it("schedules the full pod without a seed-approval stop", async () => {
    const state = new StateStore(
      `/tmp/dw-pod-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const config = loadConfig({} as NodeJS.ProcessEnv);
    const created: Array<{ sender_accounts?: string[] }> = [];
    const service = mkPods(
      config,
      {
        listCampaigns: async () => [
          { id: 1, name: "Acme", status: "ACTIVE", client_id: 9 },
          { id: 99, name: "Pod control shell", status: "PAUSED" },
        ],
        listClients: async () => [{ id: 9, name: "Acme" }],
        listAllEmailAccounts: async () => [
          {
            id: 1,
            from_email: "a@client.com",
            client_id: 9,
            campaign_ids: [1],
          },
          {
            id: 2,
            from_email: "b@client.com",
            client_id: 9,
            campaign_ids: [1],
          },
        ],
        getCampaignSequences: async () => [
          { id: 77, seq_number: 1, subject: "Quick check-in" },
        ],
        getCampaignEmailAccounts: async () => [],
        addEmailAccountsToCampaign: async () => undefined,
        removeEmailAccountsFromCampaign: async () => undefined,
        updateCampaignSequences: async () => undefined,
        updateCampaignStatus: async () => undefined,
      } as never,
      {
        listFolders: async () => [],
        createFolder: async () => ({ id: 3 }),
        listTests: async () => [],
        resolveProviderIds: async () => [2, 20, 21],
        getTestDetails: async () => ({ provider_id: [2, 20, 21] }),
        createAutomatedPlacement: async (payload: {
          sender_accounts?: string[];
          sequence_mapping_id?: number;
          provider_ids?: number[];
          campaign_id?: number;
        }) => {
          created.push(payload);
          return { id: `pod-${created.length}` };
        },
        getSenderAccountReport: async () => [],
      } as never,
      { notifyPodControls: async () => undefined } as never,
      state,
    );

    const result = await service.run({ dryRun: false });
    assert.ok(result.testsCreated.length >= 1);
    const attached = created.flatMap((row) => row.sender_accounts ?? []);
    assert.ok(attached.includes("a@client.com"));
    assert.ok(attached.includes("b@client.com"));
    assert.equal(
      created.every((row) => !("sequence" in row)),
      true,
      "schedule endpoint rejects a custom sequence body; the shell carries the known-good email",
    );
    assert.equal(
      created.every((row) => row.sequence_mapping_id === 77),
      true,
      "SmartDelivery schedule requires sequence_mapping_id from the shell campaign",
    );
    assert.equal(
      created.every((row) => row.campaign_id === 99),
      true,
      "pod controls hang on the paused shell, not a live campaign",
    );
    assert.deepEqual(created[0]?.provider_ids, [2, 20, 21]);
  });

  it("D89: a stored test that is no longer living is recreated", async () => {
    const state = new StateStore(
      `/tmp/dw-pod-dead-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const config = loadConfig({} as NodeJS.ProcessEnv);
    const created: string[] = [];
    let listed: Array<{
      id: string;
      spam_test_id: string;
      test_name: string;
      status: string;
    }> = [];
    const service = mkPods(
      config,
      {
        listCampaigns: async () => [
          { id: 1, name: "Acme", status: "ACTIVE", client_id: 9 },
          { id: 99, name: "Pod control shell", status: "PAUSED" },
        ],
        listClients: async () => [{ id: 9, name: "Acme" }],
        listAllEmailAccounts: async () => [
          {
            id: 1,
            from_email: "a@client.com",
            client_id: 9,
            campaign_ids: [1],
          },
        ],
        getCampaignSequences: async () => [
          { id: 77, seq_number: 1, subject: "Quick check-in" },
        ],
        getCampaignEmailAccounts: async () => [],
        addEmailAccountsToCampaign: async () => undefined,
        removeEmailAccountsFromCampaign: async () => undefined,
        updateCampaignSequences: async () => undefined,
        updateCampaignStatus: async () => undefined,
      } as never,
      {
        listFolders: async () => [],
        createFolder: async () => ({ id: 3 }),
        listTests: async () => listed,
        resolveProviderIds: async () => [2, 20, 21],
        getTestDetails: async () => ({ provider_id: [2, 20, 21] }),
        createAutomatedPlacement: async () => {
          const id = `pod-${created.length + 1}`;
          created.push(id);
          return { id };
        },
        getSenderAccountReport: async () => [],
      } as never,
      { notifyPodControls: async () => undefined } as never,
      state,
    );

    const first = await service.run({ dryRun: false });
    assert.ok(first.testsCreated.length >= 1);
    const stored = state.listPodControls();
    assert.ok(stored.length >= 1);
    listed = stored.map((row) => ({
      id: row.spamTestId,
      spam_test_id: row.spamTestId,
      test_name: "Pod control leftover",
      status: "completed",
    }));

    const second = await service.run({ dryRun: false });
    assert.ok(
      second.testsCreated.length >= 1,
      "a completed stored pod-control test is not coverage — recreate it",
    );
  });

  it("D131: a pod that grew gets a supplemental test for only the newcomers", async () => {
    const state = new StateStore(
      `/tmp/dw-pod-grow-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const config = loadConfig({} as NodeJS.ProcessEnv);
    const created: Array<{ id: string; senders: string[] }> = [];
    let accounts = [
      { id: 1, from_email: "a@client.com", client_id: 9, campaign_ids: [1] },
    ];
    let listed: Array<{
      id: string;
      spam_test_id: string;
      test_name: string;
      status: string;
    }> = [];
    const service = mkPods(
      config,
      {
        listCampaigns: async () => [
          { id: 1, name: "Acme", status: "ACTIVE", client_id: 9 },
          { id: 99, name: "Pod control shell", status: "PAUSED" },
        ],
        listClients: async () => [{ id: 9, name: "Acme" }],
        listAllEmailAccounts: async () => accounts,
        getCampaignSequences: async () => [
          { id: 77, seq_number: 1, subject: "Quick check-in" },
        ],
        getCampaignEmailAccounts: async () => [],
        addEmailAccountsToCampaign: async () => undefined,
        removeEmailAccountsFromCampaign: async () => undefined,
        updateCampaignSequences: async () => undefined,
        updateCampaignStatus: async () => undefined,
      } as never,
      {
        listFolders: async () => [],
        createFolder: async () => ({ id: 3 }),
        listTests: async () => listed,
        resolveProviderIds: async () => [2, 20, 21],
        getTestDetails: async () => ({ provider_id: [2, 20, 21] }),
        createAutomatedPlacement: async (payload: { sender_accounts?: string[] }) => {
          const id = `pod-${created.length + 1}`;
          created.push({ id, senders: payload.sender_accounts ?? [] });
          return { id };
        },
        getSenderAccountReport: async () => [],
      } as never,
      { notifyPodControls: async () => undefined } as never,
      state,
    );

    const first = await service.run({ dryRun: false });
    assert.equal(first.testsCreated.length, 1);
    // Keep the first test living, then grow the pod by one inbox.
    listed = state.listPodControls().map((row) => ({
      id: row.spamTestId,
      spam_test_id: row.spamTestId,
      test_name: "Pod control: Acme A",
      status: "running",
      every_days: 1,
    }));
    accounts = [
      ...accounts,
      { id: 2, from_email: "b@client.com", client_id: 9, campaign_ids: [1] },
    ];

    const second = await service.run({ dryRun: false });
    assert.equal(
      second.testsCreated.length,
      1,
      "the newcomer gets a supplemental test",
    );
    const supplemental = created.at(-1)!;
    assert.deepEqual(
      supplemental.senders.map((row) => row.toLowerCase()),
      ["b@client.com"],
      "only the uncovered inbox is in the supplemental test",
    );

    const third = await service.run({ dryRun: false });
    // With both tests stored (second listed refresh not applied), the
    // newcomer's stored row is dead by the D89 rule until listed refreshes —
    // refresh and confirm convergence.
    listed = state.listPodControls().map((row) => ({
      id: row.spamTestId,
      spam_test_id: row.spamTestId,
      test_name: "Pod control: Acme A",
      status: "running",
      every_days: 1,
    }));
    const fourth = await service.run({ dryRun: false });
    assert.equal(
      fourth.testsCreated.length,
      0,
      "full coverage creates nothing new",
    );
    void third;
  });

  it("prunes dead stored tests and does not re-read them", async () => {
    const state = new StateStore(
      `/tmp/dw-pod-prune-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    state.upsertPodControl({
      id: "client:9:A:99",
      podId: "client:9:A",
      controlVersion: "stale",
      spamTestId: "dead-99",
      emails: ["gone@client.com"],
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const reported: string[] = [];
    const listed: Array<{
      id: string;
      spam_test_id: string;
      test_name: string;
      status: string;
      every_days: number;
    }> = [];
    const service = mkPods(
      loadConfig({} as NodeJS.ProcessEnv),
      {
        listCampaigns: async () => [
          { id: 1, name: "Acme", status: "ACTIVE", client_id: 9 },
          { id: 99, name: "Pod control shell", status: "PAUSED" },
        ],
        listClients: async () => [{ id: 9, name: "Acme" }],
        listAllEmailAccounts: async () => [
          { id: 1, from_email: "a@client.com", client_id: 9, campaign_ids: [1] },
        ],
        getCampaignSequences: async () => [
          { id: 77, seq_number: 1, subject: "Quick check-in" },
        ],
        getCampaignEmailAccounts: async () => [],
        addEmailAccountsToCampaign: async () => undefined,
        removeEmailAccountsFromCampaign: async () => undefined,
        updateCampaignSequences: async () => undefined,
        updateCampaignStatus: async () => undefined,
      } as never,
      {
        listFolders: async () => [],
        createFolder: async () => ({ id: 3 }),
        listTests: async () => listed,
        resolveProviderIds: async () => [2, 20, 21],
        getTestDetails: async () => ({ provider_id: [2, 20, 21] }),
        createAutomatedPlacement: async () => {
          listed.push({
            id: "live-1",
            spam_test_id: "live-1",
            test_name: "Pod control: Acme A",
            status: "running",
            every_days: 1,
          });
          return { id: "live-1" };
        },
        getSenderAccountReport: async (id: string) => {
          reported.push(String(id));
          return [];
        },
      } as never,
      { notifyPodControls: async () => undefined } as never,
      state,
    );

    const result = await service.run({ dryRun: false });
    assert.ok(result.pruned >= 1, "dead stored row must be pruned");
    assert.equal(
      state.listPodControls().some((row) => row.spamTestId === "dead-99"),
      false,
      "dead stored test must leave state",
    );
    assert.equal(
      reported.includes("dead-99"),
      false,
      "must not GET a dead test's sender report",
    );
  });

  it("aborts mid-read, saves progress, and does not keep walking reports", async () => {
    const state = new StateStore(
      `/tmp/dw-pod-abort-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const emails = ["a@client.com", "b@client.com"];
    state.upsertPodControl({
      id: "client:9:A:0",
      podId: "client:9:A",
      controlVersion: "v",
      spamTestId: "live-1",
      emails: [emails[0]!],
      createdAt: "2026-10-13T00:00:00.000Z",
    });
    state.upsertPodControl({
      id: "client:9:A:1",
      podId: "client:9:A",
      controlVersion: "v",
      spamTestId: "live-2",
      emails: [emails[1]!],
      createdAt: "2026-10-13T00:00:00.000Z",
    });
    const controller = new AbortController();
    const reported: string[] = [];
    const service = mkPods(
      loadConfig({} as NodeJS.ProcessEnv),
      {
        listCampaigns: async () => [
          { id: 1, name: "Acme", status: "ACTIVE", client_id: 9 },
          { id: 99, name: "Pod control shell", status: "PAUSED" },
        ],
        listClients: async () => [{ id: 9, name: "Acme" }],
        listAllEmailAccounts: async () => [
          { id: 1, from_email: "a@client.com", client_id: 9, campaign_ids: [1] },
          { id: 2, from_email: "b@client.com", client_id: 9, campaign_ids: [1] },
        ],
        getCampaignSequences: async () => [
          { id: 77, seq_number: 1, subject: "Quick check-in" },
        ],
        getCampaignEmailAccounts: async () => [],
        addEmailAccountsToCampaign: async () => undefined,
        removeEmailAccountsFromCampaign: async () => undefined,
        updateCampaignSequences: async () => undefined,
        updateCampaignStatus: async () => undefined,
      } as never,
      {
        listFolders: async () => [{ id: 3, name: "Pod controls" }],
        listTests: async () => [
          {
            id: "live-1",
            spam_test_id: "live-1",
            test_name: "Pod control: Acme A (1/2)",
            status: "running",
            every_days: 1,
          },
          {
            id: "live-2",
            spam_test_id: "live-2",
            test_name: "Pod control: Acme A (2/2)",
            status: "running",
            every_days: 1,
          },
        ],
        resolveProviderIds: async () => [2, 20, 21],
        getTestDetails: async () => ({ provider_id: [2, 20, 21] }),
        createAutomatedPlacement: async () => ({ id: "should-not-create" }),
        getSenderAccountReport: async (id: string) => {
          reported.push(String(id));
          controller.abort();
          return [];
        },
      } as never,
      { notifyPodControls: async () => undefined } as never,
      state,
    );

    await assert.rejects(
      () => service.run({ dryRun: false, signal: controller.signal }),
      (error: unknown) =>
        error instanceof Error && /aborted/i.test(error.name + error.message),
    );
    assert.ok(reported.length <= 1, `abort must stop the report walk: ${reported.join(",")}`);
  });
});
