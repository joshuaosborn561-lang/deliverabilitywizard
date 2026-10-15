import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  LIST_TESTS_PATH,
  SMARTDELIVERY_BASE,
  SmartDeliveryReader,
  providerSplitsFromReport,
  sendersFromAccountWise,
} from "./smartdelivery.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("SmartDelivery placement-test endpoints", () => {
  it("lists via POST /api/v1/spam-test/report, not GET /spam-tests", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: String(init?.method ?? "GET"),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const tests = await new SmartDeliveryReader("LIVEKEY").listTests();
    assert.equal(tests.length, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, "POST");
    assert.match(calls[0]?.url ?? "", /\/api\/v1\/spam-test\/report/);
    assert.doesNotMatch(calls[0]?.url ?? "", /\/spam-tests(\?|$)/);
    assert.equal(calls[0]?.body?.limit, 100);
    assert.equal(SMARTDELIVERY_BASE, "https://smartdelivery.smartlead.ai/api/v1/");
    assert.equal(LIST_TESTS_PATH, "spam-test/report");
  });

  it("error messages never include api_key or the raw URL", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      assert.match(String(url), /api_key=LIVEKEY/);
      return new Response("nope", { status: 404 });
    }) as typeof fetch;

    await assert.rejects(
      () => new SmartDeliveryReader("LIVEKEY").listTests(),
      (err: unknown) => {
        const text = String(err);
        assert.doesNotMatch(text, /LIVEKEY/);
        assert.doesNotMatch(text, /api_key=/);
        assert.doesNotMatch(text, /https?:\/\//);
        assert.match(text, /POST \/api\/v1\/spam-test\/report → 404/);
        return true;
      },
    );
  });

  it("parses sender-account-wise seed folders into inbox rows", () => {
    const senders = sendersFromAccountWise({
      data: [
        {
          email: "ada@client.info",
          details: [
            { mail_folder: "Inbox", provider: "gmail" },
            { mail_folder: "Spam", provider: "Outlook" },
          ],
        },
      ],
    });
    assert.equal(senders.length, 2);
    assert.equal(senders[0]?.email, "ada@client.info");
    assert.equal(senders[0]?.inbox, true);
    assert.equal(senders[1]?.inbox, false);
  });

  it("parses providerwise inbox_rate into same-ESP splits", () => {
    const splits = providerSplitsFromReport({
      result: [
        { provider_name: "gmail", inbox_rate: 0 },
        { provider_name: "outlook", inbox_count: 8, spam_count: 2, tab_count: 0 },
      ],
    });
    assert.equal(splits[0]?.inboxPercent, 0);
    assert.equal(splits[1]?.inboxPercent, 80);
  });
});
