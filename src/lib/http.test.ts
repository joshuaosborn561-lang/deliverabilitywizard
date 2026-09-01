import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ApiError, apiRequest } from "./http.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("apiRequest timeouts", () => {
  it("rewrites AbortError into a clear TimeoutError after the budget", async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        if (!signal) {
          reject(new Error("missing abort signal"));
          return;
        }
        if (signal.aborted) {
          reject(new DOMException("This operation was aborted", "AbortError"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            reject(new DOMException("This operation was aborted", "AbortError"));
          },
          { once: true },
        );
      });
    }) as typeof fetch;

    await assert.rejects(
      () =>
        apiRequest("https://example.test/", "key", "slow", {
          timeoutMs: 40,
          retries: 0,
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, "TimeoutError");
        assert.match(error.message, /request timed out after 40ms/i);
        return true;
      },
    );
  });
});

describe("apiRequest error messages include HTTP status", () => {
  it("keeps HTTP 500 on Smartlead's vendor-SQL email-accounts body", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error:
            "permission denied for table smart_senders_scheduled_deletions",
        }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    await assert.rejects(
      () =>
        apiRequest("https://server.smartlead.ai/api/v1/", "key", "email-accounts", {
          retries: 0,
        }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 500);
        assert.match(error.message, /^HTTP 500:/);
        assert.match(
          error.message,
          /permission denied for table smart_senders_scheduled_deletions/,
        );
        return true;
      },
    );
  });
});
