import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatInfraMessage,
  parseSendingInfra,
  summarizeSendingInfra,
} from "./sendingInfra.js";

describe("sending infra census", () => {
  it("reads Google US IPs as good and says drop the add-on", () => {
    const rows = parseSendingInfra({
      analytics: {
        result: [
          {
            ip: "142.250.1.1",
            from_email: "a@crosslaunchco.com",
            country: "United States",
            org: "Google LLC",
            rdns: "mail.google.com",
          },
        ],
      },
      blacklist: [{ ip: "142.250.1.1", total_blacklist: 0, details: "Not listed" }],
    });
    const summary = summarizeSendingInfra(rows);
    assert.equal(summary.verdict, "good");
    const text = formatInfraMessage(summary);
    assert.match(text, /reputable ranges in the right region/);
    assert.match(text, /would buy us nothing/);
    assert.doesNotMatch(text, /D\d+/);
  });

  it("flags off-region listed IPs as a bigger finding than an add-on", () => {
    const rows = parseSendingInfra({
      analytics: [
        {
          ip: "103.21.244.1",
          from_email: "b@client.info",
          country: "India",
          isp: "Cheap Host",
        },
      ],
      blacklist: [
        {
          ip: "103.21.244.1",
          total_blacklist: 2,
          blacklist_type_value: "Spamhaus",
          from_email: "b@client.info",
        },
      ],
    });
    const summary = summarizeSendingInfra(rows);
    assert.equal(summary.verdict, "bad");
    assert.match(formatInfraMessage(summary), /bigger than an add-on/);
  });
});
