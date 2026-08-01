import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { SpendGateway } from "../lib/spendGateway.js";
import { StateStore } from "../state/store.js";
import { PoolProvisioner } from "./poolProvisioner.js";

describe("pre-warmed fleet registration", () => {
  it("registers every explicit-domain mailbox and persists its exemption", async () => {
    const state = new StateStore(
      `/tmp/prewarmed-fleet-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const smartlead = {
      listAllEmailAccounts: async () => [
        {
          id: 1,
          from_email: "escobar.br@crossscaleco.com",
          from_name: "Brianna Escobar",
          type: "OUTLOOK",
          campaign_ids: [3730560],
        },
        {
          id: 2,
          from_email: "odd-alias@crossscaleco.com",
          from_name: "Completely Different Alias",
          type: "OUTLOOK",
          campaign_ids: [],
        },
        {
          id: 3,
          from_email: "client@other.info",
          from_name: "Brianna Escobar",
          type: "OUTLOOK",
          campaign_ids: [],
        },
      ],
    } as unknown as SmartleadClient;
    const provisioner = new PoolProvisioner(
      loadConfig({
        EXTRA_GENERIC_MAILBOXES: "",
        EXTRA_GENERIC_DOMAINS: "crossscaleco.com,crosslaunchco.com",
      }),
      null,
      smartlead,
      { send: async () => undefined } as unknown as SlackClient,
      state,
      {} as SpendGateway,
    );

    const result = await provisioner.registerExtraGenerics();
    assert.equal(result.errors.length, 0);
    assert.equal(
      state.getPoolMailbox("escobar.br@crossscaleco.com")?.prewarmed,
      true,
    );
    assert.equal(
      state.getPoolMailbox("escobar.br@crossscaleco.com")?.status,
      "assigned",
    );
    assert.equal(
      state.getPoolMailbox("odd-alias@crossscaleco.com")?.status,
      "available",
    );
    assert.equal(state.getPoolMailbox("client@other.info"), undefined);
  });
});
