import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { errorShapeKey, summarizeErrors } from "./errorDigest.js";

describe("errorDigest", () => {
  it("collapses the same fault across different test ids", () => {
    // The real case: a run logged "errors: 40" and 32 were purged test ids.
    const errors = [
      "sender report 502071: Spam test not found",
      "sender report 502070: Spam test not found",
      "sender report 501958: Spam test not found",
    ];
    const shapes = summarizeErrors(errors);
    assert.equal(shapes.length, 1);
    assert.equal(shapes[0]?.count, 3);
    // The sample stays real so the id is still recoverable from the log.
    assert.match(shapes[0]!.sample, /502071/);
  });

  it("collapses the same fault across different mailboxes", () => {
    const shapes = summarizeErrors([
      "a@x.com: 2 campaign removal(s) failed — left unheld so the next run retries",
      "b@y.com: 2 campaign removal(s) failed — left unheld so the next run retries",
    ]);
    assert.equal(shapes.length, 1);
    assert.equal(shapes[0]?.count, 2);
  });

  it("keeps genuinely different faults apart", () => {
    const shapes = summarizeErrors([
      "sender report 1111: Spam test not found",
      "sender report 2222: Spam test not found",
      "warmup a@x.com: HTTP 500",
      "remove b@y.com from campaign 3333: HTTP 429",
    ]);
    assert.equal(shapes.length, 3);
    // Most frequent first, so the dominant fault leads the log.
    assert.equal(shapes[0]?.count, 2);
    assert.match(shapes[0]!.sample, /Spam test not found/);
  });

  it("returns nothing for no errors", () => {
    assert.deepEqual(summarizeErrors([]), []);
  });

  it("normalises ids and addresses but not short numbers", () => {
    // 429/500 are meaningful and must not collapse into each other.
    assert.notEqual(
      errorShapeKey("warmup a@x.com: HTTP 429"),
      errorShapeKey("warmup a@x.com: HTTP 500"),
    );
    assert.equal(
      errorShapeKey("sender report 502071: gone"),
      errorShapeKey("sender report 998877: gone"),
    );
  });
});
