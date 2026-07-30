import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchesMailboxIdentity } from "./mailboxIdentity.js";

const PREWARMED = ["harmony norris", "breanna escobar"];

describe("matchesMailboxIdentity", () => {
  it("matches on from_name, case-insensitively", () => {
    assert.equal(
      matchesMailboxIdentity({ from_name: "Harmony Norris" }, PREWARMED),
      true,
    );
    assert.equal(
      matchesMailboxIdentity({ from_name: "BREANNA ESCOBAR" }, PREWARMED),
      true,
    );
  });

  it("matches on email address", () => {
    assert.equal(
      matchesMailboxIdentity({ from_email: "Harmony@Example.com" }, [
        "harmony@example.com",
      ]),
      true,
    );
  });

  it("falls back through email fields", () => {
    assert.equal(
      matchesMailboxIdentity({ email: "b@x.io" }, ["b@x.io"]),
      true,
    );
    assert.equal(
      matchesMailboxIdentity({ username: "c@x.io" }, ["c@x.io"]),
      true,
    );
  });

  it("does not match unrelated mailboxes", () => {
    assert.equal(
      matchesMailboxIdentity(
        { from_name: "Angelo Mills", from_email: "angelomills@parlaytechnow.info" },
        PREWARMED,
      ),
      false,
    );
  });

  it("does not partial-match a different person", () => {
    assert.equal(
      matchesMailboxIdentity({ from_name: "Harmony Norris-Smith" }, PREWARMED),
      false,
    );
  });

  it("is inert when nothing is configured", () => {
    assert.equal(matchesMailboxIdentity({ from_name: "Harmony Norris" }, []), false);
  });

  it("ignores blank entries", () => {
    assert.equal(matchesMailboxIdentity({ from_name: "" }, ["", "  "]), false);
  });
});
