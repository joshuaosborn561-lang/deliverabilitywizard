import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import type { InboxKitClient } from "../clients/inboxkit.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { StateStore } from "../state/store.js";
import { ClientOwnershipService } from "./clientOwnershipAudit.js";

describe("ClientOwnershipService", () => {
  it("clears leftover client_id on an idle generic and ties a client domain", async () => {
    const state = new StateStore(
      `/tmp/ownership-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    state.upsertPoolMailbox({
      email: "jameshayes@hubmeetconnect.com",
      domain: "hubmeetconnect.com",
      firstName: "James",
      lastName: "Hayes",
      platform: "GOOGLE",
      status: "available",
      smartleadAccountId: 11,
    });

    const updates: Array<{ id: number; fields: Record<string, unknown> }> = [];
    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "BCP G Suite", status: "ACTIVE", client_id: 542838 },
      ],
      listAllEmailAccounts: async () => [],
      listClients: async () => [
        { id: 542838, name: "Mike Trpkosh (Bolder Cyber Partners)" },
      ],
      updateEmailAccount: async (id: number, fields: Record<string, unknown>) => {
        updates.push({ id, fields });
      },
    } as unknown as SmartleadClient;

    const service = new ClientOwnershipService(
      loadConfig({}),
      smartlead,
      null,
      { send: async () => undefined } as unknown as SlackClient,
      state,
    );

    const result = await service.reconcileSmartlead({
      dryRun: false,
      accounts: [
        {
          id: 11,
          from_email: "jameshayes@hubmeetconnect.com",
          from_name: "James Hayes",
          client_id: 542838,
          campaign_ids: [],
        },
        {
          id: 22,
          from_email: "leroy@boldercyperpartnerbiz.info",
          from_name: "Leroy Senger",
          client_id: null,
          campaign_ids: [],
        },
        {
          id: 33,
          from_email: "live@crosslaunchco.com",
          from_name: "Harmony Norris",
          client_id: 1,
          campaign_ids: [1],
        },
      ],
      campaigns: [
        { id: 1, name: "BCP G Suite", status: "ACTIVE", client_id: 542838 },
      ],
      clients: [{ id: 542838, name: "Mike Trpkosh (Bolder Cyber Partners)" }],
    });

    assert.equal(result.applied.length, 2, result.applied.map((row) => row.reason).join("; "));
    const cleared = result.applied.find((row) => row.action === "clear_generic");
    const tied = result.applied.find((row) => row.action === "set_client");
    assert.equal(cleared?.email, "jameshayes@hubmeetconnect.com");
    assert.equal(tied?.toClientId, 542838);
    assert.equal(
      updates.find((row) => row.id === 11)?.fields.client_id,
      null,
    );
    assert.equal(
      updates.find((row) => row.id === 22)?.fields.client_id,
      542838,
    );
    assert.equal(
      updates.some((row) => row.id === 33),
      false,
      "generic still sending keeps its client_id",
    );
  });

  it("flags a client domain parked in the generic InboxKit workspace", async () => {
    const state = new StateStore(
      `/tmp/ownership-ws-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const inboxkit = {
      listWorkspaces: async () => [
        { uid: "generic-ws", name: "DW Generic Pool" },
      ],
      listDomains: async () => [{ name: "tryboldercyperpartner.info" }],
    } as unknown as InboxKitClient;
    const smartlead = {
      listCampaigns: async () => [],
      listAllEmailAccounts: async () => [],
      listClients: async () => [
        { id: 542838, name: "Mike Trpkosh (Bolder Cyber Partners)" },
      ],
      updateEmailAccount: async () => undefined,
    } as unknown as SmartleadClient;

    const service = new ClientOwnershipService(
      loadConfig({}),
      smartlead,
      inboxkit,
      { send: async () => undefined } as unknown as SlackClient,
      state,
    );
    const result = await service.auditInboxKit({ dryRun: true });
    assert.ok(
      result.workspaceFindings.some(
        (row) =>
          row.domain === "tryboldercyperpartner.info" &&
          /generic pool/i.test(row.issue),
      ),
      result.workspaceFindings.map((row) => row.issue).join("; "),
    );
    assert.ok(
      result.missingInSmartlead.some(
        (row) => row.domain === "tryboldercyperpartner.info",
      ),
    );
  });
});
