import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isTransientTapError,
  withTransientRetry,
} from "./transientRetry.js";

describe("D266 — bounded tap retry", () => {
  it("retries HTTP 429 / fetch failed and then succeeds", async () => {
    let n = 0;
    const value = await withTransientRetry(
      async () => {
        n += 1;
        if (n < 3) throw new Error("HTTP 429");
        return "ok";
      },
      { attempts: 3, backoffMs: [0, 0, 0], sleepFn: async () => undefined },
    );
    assert.equal(value, "ok");
    assert.equal(n, 3);
  });

  it("does not retry a permanent error", async () => {
    let n = 0;
    await assert.rejects(
      () =>
        withTransientRetry(
          async () => {
            n += 1;
            throw new Error("Porkbun did not quote a price");
          },
          { attempts: 3, backoffMs: [0], sleepFn: async () => undefined },
        ),
      /Porkbun/,
    );
    assert.equal(n, 1);
  });

  it("classifies fetch failed and 429 as transient", () => {
    assert.equal(isTransientTapError(new Error("fetch failed")), true);
    assert.equal(isTransientTapError(new Error("HTTP 429")), true);
    assert.equal(isTransientTapError({ status: 429, message: "nope" }), true);
    assert.equal(isTransientTapError(new Error("domain not available")), false);
  });
});
