import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import { StateStore } from "../state/store.js";
import {
  HeldPlacementTestService,
  HELD_TEST_NAME_PREFIX,
  REST_TEST_NAME_PREFIX,
  isHeldRecoveryTestName,
  isRestRecoveryTestName,
} from "./heldPlacementTests.js";

describe("HeldPlacementTestService", () => {
  it("recognizes held-recovery test names", () => {
    assert.equal(
      isHeldRecoveryTestName(`${HELD_TEST_NAME_PREFIX} 3 mailbox(es)`),
      true,
    );
    assert.equal(isHeldRecoveryTestName("Auto: Campaign X"), false);
    assert.equal(
      isRestRecoveryTestName(`${REST_TEST_NAME_PREFIX} 2 mailbox(es)`),
      true,
    );
    assert.equal(isRestRecoveryTestName("Held recovery: 1 mailbox(es)"), false);
  });

  it("creates a separate test for held mailboxes without re-attaching", async () => {
    const state = new StateStore(
      `/tmp/held-tests-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    state.markHeldInbox({
      accountId: 7,
      email: "pulled@client.com",
      heldAt: new Date().toISOString(),
      holdUntil: "2099-01-01",
      tagName: "HOLD-UNTIL-2099-01-01",
      removedFromCampaigns: [42],
    });

    let addedToCampaign = false;
    const created: Array<Record<string, unknown>> = [];
    const smartlead = {
      listCampaigns: async () => [
        { id: 42, name: "Shell", status: "ACTIVE", client_id: 1 },
      ],
      getCampaignSequences: async () => [
        { seq_number: 1, id: 99, subject: "Hi", seq_mapping_id: 99 },
      ],
      addEmailAccountsToCampaign: async () => {
        addedToCampaign = true;
      },
    };
    const smartDelivery = {
      listTests: async () => [],
      createAutomatedPlacement: async (payload: Record<string, unknown>) => {
        created.push(payload);
        return { id: "held-test-1" };
      },
      stopAutomatedTest: async () => undefined,
    };
    const slack = { notifyQuotaBlocked: async () => undefined };

    const service = new HeldPlacementTestService(
      loadConfig({
        ENABLE_HELD_PLACEMENT_TESTS: "true",
        DRY_RUN: "false",
        TOTAL_TEST_QUOTA: "120",
        MAX_MAILBOXES_PER_TEST: "50",
        PLACEMENT_TEST_EVERY_DAYS: "1",
        SEQUENCE_NUMBER: "1",
      }),
      smartlead as never,
      smartDelivery as never,
      slack as never,
      state,
    );

    const result = await service.run({ dryRun: false });
    assert.equal(result.created.length, 1);
    assert.equal(addedToCampaign, false);
    assert.deepEqual(created[0]!.sender_accounts, ["pulled@client.com"]);
    assert.equal(created[0]!.campaign_id, 42);
    assert.match(String(created[0]!.test_name), new RegExp(HELD_TEST_NAME_PREFIX));
    assert.ok(state.getHeldPlacementTest("held-test-1"));
  });

  it("does not create rest tests for send-clock generics (D43)", async () => {
    const state = new StateStore(
      `/tmp/rest-tests-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    state.markRestingInbox({
      accountId: 8,
      email: "off@client.com",
      clientId: "id:1",
      cohort: "B",
      kind: "client",
      restingSince: new Date().toISOString(),
      removedFromCampaigns: [42],
      lastSameEspInbox: null,
    });
    state.markRestingInbox({
      accountId: 9,
      email: "sit@crosslaunchco.com",
      clientId: "generic",
      cohort: "send",
      kind: "generic",
      restingSince: new Date().toISOString(),
      removedFromCampaigns: [42],
      lastSameEspInbox: null,
    });

    const created: Array<Record<string, unknown>> = [];
    const smartlead = {
      listCampaigns: async () => [
        { id: 42, name: "Shell", status: "ACTIVE", client_id: 1 },
      ],
      getCampaignSequences: async () => [
        { seq_number: 1, id: 99, subject: "Hi", seq_mapping_id: 99 },
      ],
    };
    const smartDelivery = {
      listTests: async () => [],
      createAutomatedPlacement: async (payload: Record<string, unknown>) => {
        created.push(payload);
        return { id: "rest-test-1" };
      },
      stopAutomatedTest: async () => undefined,
    };
    const slack = { notifyQuotaBlocked: async () => undefined };
    const service = new HeldPlacementTestService(
      loadConfig({
        ENABLE_REST_PLACEMENT_TESTS: "true",
        DRY_RUN: "false",
        TOTAL_TEST_QUOTA: "120",
        MAX_MAILBOXES_PER_TEST: "50",
        PLACEMENT_TEST_EVERY_DAYS: "1",
        SEQUENCE_NUMBER: "1",
      }),
      smartlead as never,
      smartDelivery as never,
      slack as never,
      state,
    );

    const result = await service.runResting({ dryRun: false });
    assert.equal(result.heldMailboxes, 1);
    assert.equal(result.created.length, 1);
    assert.deepEqual(created[0]!.sender_accounts, ["off@client.com"]);
  });
});
