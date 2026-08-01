import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pickPersonName, pickUniquePersonNames } from "./personNames.js";

describe("personNames", () => {
  it("produces multicultural usernames", () => {
    const name = pickPersonName(42);
    assert.ok(name.first_name.length > 1);
    assert.ok(name.last_name.length > 1);
    assert.equal(
      name.username,
      `${name.first_name}${name.last_name}`.toLowerCase().replace(/[^a-z0-9]/g, ""),
    );
  });

  it("avoids last-name clumps inside a batch", () => {
    const batch = pickUniquePersonNames(5, 1000);
    const lasts = batch.map((n) => n.last_name.toLowerCase());
    assert.equal(new Set(lasts).size, lasts.length);
    assert.equal(new Set(batch.map((n) => n.username)).size, batch.length);
  });
});
