import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAbortError, throwIfAborted } from "./abortWork.js";

describe("abortWork (D251)", () => {
  it("throws AbortError when the stage signal has fired", () => {
    const controller = new AbortController();
    controller.abort();
    assert.throws(() => throwIfAborted(controller.signal), (error: unknown) => {
      assert.equal(isAbortError(error), true);
      return true;
    });
  });

  it("is a no-op when the signal is live", () => {
    const controller = new AbortController();
    throwIfAborted(controller.signal);
    throwIfAborted(undefined);
  });
});
