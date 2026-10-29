import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StateStore } from "../state/store.js";
import { GENERIC_ASSIGN_REASON_POWERGRYD } from "./genericPool.js";
import {
  FREED_POWERGRYD_GENERIC_ACCOUNT_IDS,
  ONBOARDING_FREED_POWERGRYD_REASON,
  cleanupFreedPowerGrydGenerics,
  isFreedPowerGrydAttachBlocked,
  isFreedPowerGrydOneClientSkip,
  isFreedPowerGrydPoolOwner,
} from "./powerGrydFreedCleanup.js";

describe("D283 Onboarding-freed PowerGRYD cleanup", () => {
  it("treats SL-null + powergryd_dedicated as freed", () => {
    assert.equal(
      isFreedPowerGrydPoolOwner({
        mailboxClientId: null,
        assignedClientId: 592842,
        assignedReason: GENERIC_ASSIGN_REASON_POWERGRYD,
      }),
      true,
    );
    assert.equal(
      isFreedPowerGrydPoolOwner({
        mailboxClientId: 592842,
        assignedClientId: 592842,
      }),
      false,
    );
    assert.equal(
      isFreedPowerGrydPoolOwner({
        mailboxClientId: null,
        assignedClientId: 521881,
      }),
      false,
    );
    assert.equal(
      isFreedPowerGrydPoolOwner({
        mailboxClientId: null,
        assignedClientId: 521881,
        assignedReason: GENERIC_ASSIGN_REASON_POWERGRYD,
      }),
      false,
      "leftover powergryd_dedicated on a TechEvo assign is not a free",
    );
    assert.deepEqual(FREED_POWERGRYD_GENERIC_ACCOUNT_IDS, [21592200, 21592202]);
  });

  it("one-client skip survives cleanup that clears owner/reason", () => {
    assert.equal(
      isFreedPowerGrydOneClientSkip({
        generic: true,
        mailboxClientId: null,
        assignedClientId: null,
        assignedReason: null,
        justCleared: true,
        hasPowerGrydMembership: false,
      }),
      true,
    );
    assert.equal(
      isFreedPowerGrydOneClientSkip({
        generic: true,
        mailboxClientId: null,
        assignedClientId: null,
        assignedReason: null,
        justCleared: false,
        hasPowerGrydMembership: true,
      }),
      true,
    );
    assert.equal(
      isFreedPowerGrydOneClientSkip({
        generic: true,
        mailboxClientId: null,
        assignedClientId: 521881,
        assignedReason: GENERIC_ASSIGN_REASON_POWERGRYD,
        justCleared: false,
        hasPowerGrydMembership: true,
      }),
      false,
      "TechEvo table owner is not a free even with a leftover PG link",
    );
    assert.equal(
      isFreedPowerGrydOneClientSkip({
        generic: true,
        mailboxClientId: 521881,
        assignedClientId: null,
        justCleared: true,
        hasPowerGrydMembership: true,
      }),
      false,
      "live named Smartlead client_id is never a free",
    );
    assert.equal(
      isFreedPowerGrydAttachBlocked({
        mailboxClientId: null,
        assignedClientId: null,
        releaseHistory: [{ reason: ONBOARDING_FREED_POWERGRYD_REASON }],
      }),
      true,
    );
  });

  it("clears pool owner and reason for the 85-style freed generic seats", async () => {
    const state = new StateStore(
      `/tmp/pg-freed-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    state.upsertPoolMailbox({
      email: "christinaevans@getoutreachdesk.info",
      domain: "getoutreachdesk.info",
      platform: "GOOGLE",
      smartleadAccountId: 21592200,
      firstName: "Christina",
      lastName: "Evans",
      status: "assigned",
      assignedClientId: 592842,
      assignedClientName: "PowerGRYD",
      warmedAt: "2026-01-01T00:00:00Z",
    });
    state.upsertGenericSeat({
      email: "christinaevans@getoutreachdesk.info",
      slAccountId: 21592200,
      provider: "GOOGLE",
      warmReadyAt: "2026-01-01T00:00:00Z",
      assignedClientId: 592842,
      assignedCampaignIds: [],
      assignedPod: "A",
      assignedAt: "2026-09-01T00:00:00Z",
      reason: GENERIC_ASSIGN_REASON_POWERGRYD,
      releasedAt: null,
      releaseHistory: [],
      staffableWeight: 1,
    });
    state.upsertPoolMailbox({
      email: "ada@getintroduced.info",
      domain: "getintroduced.info",
      platform: "GOOGLE",
      smartleadAccountId: 9,
      firstName: "Ada",
      lastName: "Poole",
      status: "assigned",
      assignedClientId: 521881,
      assignedClientName: "TechEvolution",
      warmedAt: "2026-01-01T00:00:00Z",
    });

    const result = cleanupFreedPowerGrydGenerics({
      accounts: [
        {
          id: 21592200,
          from_email: "christinaevans@getoutreachdesk.info",
          client_id: null,
        },
        {
          id: 9,
          from_email: "ada@getintroduced.info",
          client_id: null,
        },
        {
          id: 10,
          from_email: "named@powergryd.com",
          client_id: 592842,
        },
      ],
      state,
    });

    assert.equal(result.cleared.length, 1);
    assert.equal(result.cleared[0]!.accountId, 21592200);
    assert.equal(
      state.getPoolMailbox("christinaevans@getoutreachdesk.info")?.assignedClientId,
      null,
    );
    assert.equal(
      state.getGenericSeat("christinaevans@getoutreachdesk.info")?.reason,
      null,
    );
    assert.equal(
      state.getGenericSeat("christinaevans@getoutreachdesk.info")?.assignedClientId,
      null,
    );
    assert.equal(
      state.getPoolMailbox("ada@getintroduced.info")?.assignedClientId,
      521881,
    );
  });

  it("does not release a TechEvo assign that still carries leftover powergryd_dedicated", async () => {
    const state = new StateStore(
      `/tmp/pg-freed-te-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    state.upsertPoolMailbox({
      email: "ada@getintroduced.info",
      domain: "getintroduced.info",
      platform: "GOOGLE",
      smartleadAccountId: 9,
      firstName: "Ada",
      lastName: "Poole",
      status: "assigned",
      assignedClientId: 521881,
      assignedClientName: "TechEvolution",
      warmedAt: "2026-01-01T00:00:00Z",
    });
    state.upsertGenericSeat({
      email: "ada@getintroduced.info",
      slAccountId: 9,
      provider: "GOOGLE",
      warmReadyAt: "2026-01-01T00:00:00Z",
      assignedClientId: 521881,
      assignedCampaignIds: [88],
      assignedPod: "A",
      assignedAt: "2026-09-01T00:00:00Z",
      reason: GENERIC_ASSIGN_REASON_POWERGRYD,
      releasedAt: null,
      releaseHistory: [],
      staffableWeight: 1,
    });
    const result = cleanupFreedPowerGrydGenerics({
      accounts: [
        {
          id: 9,
          from_email: "ada@getintroduced.info",
          client_id: null,
        },
      ],
      state,
    });
    assert.deepEqual(result.cleared, []);
    assert.equal(state.getPoolMailbox("ada@getintroduced.info")?.assignedClientId, 521881);
    assert.equal(state.getGenericSeat("ada@getintroduced.info")?.assignedClientId, 521881);
    assert.equal(
      state.getGenericSeat("ada@getintroduced.info")?.reason,
      GENERIC_ASSIGN_REASON_POWERGRYD,
    );
  });
});
