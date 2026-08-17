import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import { StateStore } from "../state/store.js";
import { ClientRestService } from "./clientRest.js";
import { cohortForEmail, restingCohortForDate } from "../lib/restCohort.js";

describe("ClientRestService", () => {
  it("puts this week's cohort to rest at MESSAGE_PER_DAY 0 (dry run)", async () => {
    const resting = restingCohortForDate();
    const liveEmail = "live@client.com";
    const restEmail = "rest@client.com";
    // Force one email into the resting cohort by searching until match.
    let forcedRest = `rest-${resting.toLowerCase()}@client.com`;
    for (let i = 0; i < 200; i += 1) {
      const candidate = `box${i}@clientbrand.com`;
      if (cohortForEmail(candidate) === resting) {
        forcedRest = candidate;
        break;
      }
    }
    let forcedLive = liveEmail;
    for (let i = 0; i < 200; i += 1) {
      const candidate = `live${i}@clientbrand.com`;
      if (cohortForEmail(candidate) !== resting) {
        forcedLive = candidate;
        break;
      }
    }

    const updates: Array<{ id: number; fields: Record<string, unknown> }> = [];
    const state = new StateStore(`/tmp/client-rest-${process.pid}-${Date.now()}.json`);
    await state.load();

    const smartlead = {
      listAllEmailAccounts: async () => [
        {
          id: 1,
          from_email: forcedRest,
          client_id: 99,
          type: "GMAIL",
        },
        {
          id: 2,
          from_email: forcedLive,
          client_id: 99,
          type: "GMAIL",
        },
      ],
      listClients: async () => [{ id: 99, name: "Acme" }],
      updateEmailAccount: async (id: number, fields: Record<string, unknown>) => {
        updates.push({ id, fields });
      },
    };

    const smartDelivery = {
      listTests: async () => [],
      getSenderAccountReport: async () => [],
    };

    const slack = {
      notifyClientRest: async () => undefined,
    };

    const service = new ClientRestService(
      loadConfig({
        ENABLE_CLIENT_REST: "true",
        DRY_RUN: "false",
        EXTRA_GENERIC_DOMAINS: "crosslaunchco.com",
        MESSAGE_PER_DAY: "30",
        REST_RESTORE_SAME_ESP_THRESHOLD: "90",
      }),
      smartlead as never,
      smartDelivery as never,
      slack as never,
      state,
    );

    const result = await service.run({ dryRun: false });
    assert.equal(result.restingCohort, resting);
    assert.ok(result.putToRest.includes(forcedRest));
    assert.ok(!result.putToRest.includes(forcedLive));
    assert.ok(state.getRestingInbox(forcedRest));
    assert.equal(
      updates.some((u) => u.id === 1 && u.fields.max_email_per_day === 0),
      true,
    );
  });
});
