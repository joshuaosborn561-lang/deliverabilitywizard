import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { getJson, parseRetryAfterMs, RateLimitError } from "./http.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Smartlead 429 retry-after", () => {
  it("parses Retry-After seconds and HTTP-date", () => {
    assert.equal(parseRetryAfterMs("2"), 2000);
    assert.equal(parseRetryAfterMs("0"), 0);
    const now = Date.parse("2026-10-15T18:00:00.000Z");
    assert.equal(parseRetryAfterMs("Thu, 15 Oct 2026 18:00:03 GMT", now), 3000);
    assert.equal(parseRetryAfterMs(null), undefined);
  });

  it("throws RateLimitError with retryAfterMs and no key in the message", async () => {
    globalThis.fetch = (async () =>
      new Response("slow down", {
        status: 429,
        headers: { "retry-after": "7" },
      })) as typeof fetch;
    await assert.rejects(
      () => getJson("https://server.smartlead.ai/api/v1/email-accounts?api_key=LIVESECRET"),
      (err: unknown) => {
        assert.ok(err instanceof RateLimitError);
        assert.equal(err.retryAfterMs, 7000);
        assert.doesNotMatch(err.message, /LIVESECRET/);
        assert.doesNotMatch(err.message, /api_key=/);
        assert.match(err.message, /429/);
        return true;
      },
    );
  });
});
