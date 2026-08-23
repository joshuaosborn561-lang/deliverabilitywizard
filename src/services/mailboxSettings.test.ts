import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { StateStore } from "../state/store.js";
import { MailboxSettingsService } from "./mailboxSettings.js";

describe("MailboxSettingsService", () => {
  it("does not rewrite when message_per_day / gap / signature already match", async () => {
    let writes = 0;
    const smartlead = {
      listAllEmailAccounts: async () => [
        {
          id: 1,
          from_email: "a@pool.info",
          from_name: "Ada Pool",
          message_per_day: "30",
          minTimeToWaitInMins: 10,
          signature: "Ada Pool\nSalesGlider",
          client_id: 345263,
          warmup_details: { status: "ACTIVE" },
        },
        {
          id: 2,
          from_email: "b@bcp.info",
          from_name: "Bert Torp",
          message_per_day: 30,
          minTimeToWaitInMins: 10,
          signature: "Bert Torp\nBolder Cyber Partners",
          client_id: 542838,
          warmup_details: { status: "ACTIVE" },
        },
      ],
      listClients: async () => [
        { id: 345263, name: "SalesGlider", logo: "SalesGlider" },
        { id: 542838, name: "Mike Trpkosh", logo: "Bolder Cyber Partners" },
      ],
      updateEmailAccount: async () => {
        writes += 1;
      },
      configureWarmup: async () => {
        writes += 1;
      },
    } as unknown as SmartleadClient;

    const service = new MailboxSettingsService(
      loadConfig({
        MESSAGE_PER_DAY: "30",
        MAILBOX_MIN_TIME_GAP_MINS: "10",
        WARMUP_TOTAL_PER_DAY: "20",
        ENFORCE_MAILBOX_SETTINGS: "true",
      }),
      smartlead,
      { send: async () => undefined } as unknown as SlackClient,
    );

    const result = await service.run({ dryRun: false, mode: "full" });
    assert.equal(writes, 0);
    assert.equal(result.sendLimitSet, 0);
    assert.equal(result.minGapSet, 0);
    assert.equal(result.signatureSet, 0);
    assert.equal(result.warmupEnabled, 0);
  });

  it("gap enforce writes only volume + min gap, not signatures", async () => {
    const updates: Array<{ id: number; fields: Record<string, unknown> }> = [];
    const smartlead = {
      listAllEmailAccounts: async () => [
        {
          id: 9,
          from_email: "nate@bcp.info",
          from_name: "Nathaniel Cartwright",
          message_per_day: 50,
          minTimeToWaitInMins: null,
          signature: "wrong",
          client_id: 542838,
          warmup_details: { status: "ACTIVE" },
        },
      ],
      listClients: async () => [
        { id: 542838, name: "Mike Trpkosh", logo: "Bolder Cyber Partners" },
      ],
      updateEmailAccount: async (id: number, fields: Record<string, unknown>) => {
        updates.push({ id, fields });
      },
      configureWarmup: async () => {
        throw new Error("warmup should not run in gap mode");
      },
    } as unknown as SmartleadClient;

    const slackMessages: string[] = [];
    const service = new MailboxSettingsService(
      loadConfig({
        MESSAGE_PER_DAY: "30",
        MAILBOX_MIN_TIME_GAP_MINS: "10",
        ENFORCE_MAILBOX_SETTINGS: "true",
      }),
      smartlead,
      {
        send: async (msg: string) => {
          slackMessages.push(msg);
        },
      } as unknown as SlackClient,
    );

    const result = await service.runGapEnforce({ dryRun: false });
    assert.equal(result.mode, "gap");
    assert.equal(result.minGapSet, 1);
    assert.equal(result.sendLimitSet, 1);
    assert.equal(result.signatureSet, 0);
    assert.equal(result.warmupEnabled, 0);
    assert.deepEqual(updates[0]?.fields, {
      max_email_per_day: 30,
      time_to_wait_in_mins: 10,
    });
    assert.match(slackMessages.join("\n"), /Sending pace/);
    assert.match(slackMessages.join("\n"), /10 minutes/);
  });

  it("writes 30/day, 10m gap, and plain two-line signatures when drifted", async () => {
    const updates: Array<{ id: number; fields: Record<string, unknown> }> = [];
    const smartlead = {
      listAllEmailAccounts: async () => [
        {
          id: 9,
          from_email: "nate@bcp.info",
          from_name: "Nathaniel Cartwright",
          message_per_day: 50,
          minTimeToWaitInMins: null,
          signature: "Nathaniel Cartwright Bolder Cyber Partners",
          client_id: 542838,
          warmup_details: { status: "ACTIVE" },
        },
        {
          id: 10,
          from_email: "katya@msrs.info",
          from_name: "Katya Sanchez",
          message_per_day: 50,
          minTimeToWaitInMins: 0,
          signature: "<div>Katya Sanchez</div><div>Mid-South Roof Systems</div>",
          client_id: 446286,
          warmup_details: { status: "ACTIVE" },
        },
      ],
      listClients: async () => [
        { id: 542838, name: "Mike Trpkosh", logo: "Bolder Cyber Partners" },
        { id: 446286, name: "Randy Gaines", logo: "MSRS" },
      ],
      updateEmailAccount: async (id: number, fields: Record<string, unknown>) => {
        updates.push({ id, fields });
      },
      configureWarmup: async () => undefined,
    } as unknown as SmartleadClient;

    const service = new MailboxSettingsService(
      loadConfig({
        MESSAGE_PER_DAY: "30",
        MAILBOX_MIN_TIME_GAP_MINS: "10",
        ENFORCE_MAILBOX_SETTINGS: "true",
      }),
      smartlead,
      { send: async () => undefined } as unknown as SlackClient,
    );

    const result = await service.run({ dryRun: false, mode: "full" });
    assert.equal(result.sendLimitSet, 2);
    assert.equal(result.minGapSet, 2);
    assert.equal(result.signatureSet, 2);
    assert.deepEqual(updates[0]?.fields, {
      max_email_per_day: 30,
      time_to_wait_in_mins: 10,
      signature: "Nathaniel Cartwright\nBolder Cyber Partners",
    });
    assert.deepEqual(updates[1]?.fields, {
      max_email_per_day: 30,
      time_to_wait_in_mins: 10,
      signature: "Katya Sanchez\nMid-South Roof Systems",
    });
  });

  it("never enables warmup on the dedicated canary fleet", async () => {
    const state = new StateStore(
      `/tmp/mailbox-canary-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    state.setCopyCanaryFleet({
      status: "ready",
      domains: ["canary-g.info"],
      emails: ["g1@canary-g.info"],
      googleDomain: "canary-g.info",
      updatedAt: new Date().toISOString(),
    });
    let warmupWrites = 0;
    const smartlead = {
      listAllEmailAccounts: async () => [
        {
          id: 3,
          from_email: "g1@canary-g.info",
          from_name: "Gale Canary",
          message_per_day: 30,
          minTimeToWaitInMins: 10,
          signature: "Gale Canary\nCanary",
          warmup_details: null,
        },
      ],
      listClients: async () => [],
      updateEmailAccount: async () => undefined,
      configureWarmup: async () => {
        warmupWrites += 1;
      },
    } as unknown as SmartleadClient;

    const service = new MailboxSettingsService(
      loadConfig({
        MESSAGE_PER_DAY: "30",
        MAILBOX_MIN_TIME_GAP_MINS: "10",
        ENFORCE_MAILBOX_SETTINGS: "true",
      }),
      smartlead,
      { send: async () => undefined } as unknown as SlackClient,
      state,
    );
    const result = await service.run({ dryRun: false, mode: "full" });
    assert.equal(warmupWrites, 0);
    assert.equal(result.warmupEnabled, 0);
  });
});
