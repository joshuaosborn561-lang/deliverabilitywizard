import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import { matchesMorningBook } from "./morningActivate.js";

describe("morning activate (D109)", () => {
  it("matches the live book and not a shell leftover", () => {
    const patterns = loadConfig({} as NodeJS.ProcessEnv).morningActivatePatterns;
    assert.equal(matchesMorningBook("Goliath Displacement M 201-500 CIO", patterns), true);
    assert.equal(matchesMorningBook("BCP Logistics Over-1k", patterns), true);
    assert.equal(matchesMorningBook("Peterson - C1 General Contractors", patterns), true);
    assert.equal(matchesMorningBook("Parlay2 Sports Offer - copy", patterns), true);
    assert.equal(matchesMorningBook("TechEvo New England Red Sox", patterns), true);
    assert.equal(matchesMorningBook("Nieto Sports or Airpods", patterns), false);
  });
});
