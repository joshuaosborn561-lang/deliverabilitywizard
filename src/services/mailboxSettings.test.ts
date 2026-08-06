import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { MailboxSettingsService } from "./mailboxSettings.js";

describe("MailboxSettingsService", () => {
  it("does not rewrite when Smartlead returns max_email_per_day as a string", async () => {
    let writes = 0;
    const smartlead = {
      listAllEmailAccounts: async () => [
        {
          id: 1,
          from_email: "a@pool.info",
          max_email_per_day: "50",
          warmup_details: { status: "ACTIVE" },
        },
        {
          id: 2,
          from_email: "b@pool.info",
          max_email_per_day: 50,
          warmup_details: { status: "ACTIVE" },
        },
      ],
      setDailySendLimit: async () => {
        writes += 1;
      },
      configureWarmup: async () => {
        writes += 1;
      },
    } as unknown as SmartleadClient;

    const service = new MailboxSettingsService(
      loadConfig({
        MESSAGE_PER_DAY: "30",
        WARMUP_TOTAL_PER_DAY: "20",
        ENFORCE_MAILBOX_SETTINGS: "true",
      }),
      smartlead,
      { send: async () => undefined } as unknown as SlackClient,
    );

    const result = await service.run({ dryRun: false });
    assert.equal(writes, 0);
    assert.equal(result.sendLimitSet, 0);
    assert.equal(result.warmupEnabled, 0);
  });
});
