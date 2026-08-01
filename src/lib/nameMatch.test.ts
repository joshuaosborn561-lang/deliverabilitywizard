import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MATCH_THRESHOLD,
  normalizeName,
  rankCandidates,
  scoreNameMatch,
} from "./nameMatch.js";

describe("normalizeName", () => {
  it("folds case, separators and accents", () => {
    assert.equal(normalizeName("Breanna  Escobar."), "breanna escobar");
    assert.equal(normalizeName("bre.escobar"), "bre escobar");
    assert.equal(normalizeName("Bré-Escobar"), "bre escobar");
    assert.equal(normalizeName("  "), "");
  });
});

describe("scoreNameMatch", () => {
  const want = "breanna escobar";

  it("matches an exact address", () => {
    const r = scoreNameMatch("bre.escobar@x.com", {
      email: "bre.escobar@x.com",
    });
    assert.equal(r.score, 100);
  });

  it("matches the from_name exactly regardless of spacing and case", () => {
    assert.equal(scoreNameMatch(want, { fromName: "Breanna Escobar" }).score, 90);
    assert.equal(scoreNameMatch(want, { fromName: "breanna  escobar " }).score, 90);
  });

  it("matches when only the address carries the name", () => {
    const r = scoreNameMatch(want, { email: "breanna.escobar@x.com" });
    assert.equal(r.score, 80);
  });

  it("matches a shortened given name", () => {
    // The case that was failing in production.
    const r = scoreNameMatch(want, { fromName: "Bre Escobar" });
    assert.ok(r.score >= MATCH_THRESHOLD, `expected auto-match, got ${r.score}`);
    assert.match(r.reason, /nickname/);
  });

  it("matches surname plus first initial", () => {
    const r = scoreNameMatch(want, { email: "b.escobar@x.com" });
    assert.ok(r.score >= MATCH_THRESHOLD, `expected auto-match, got ${r.score}`);
  });

  it("suggests but does not auto-accept a surname-only hit", () => {
    const r = scoreNameMatch(want, { fromName: "Marcus Escobar" });
    assert.ok(r.score > 0, "should still surface as a candidate");
    assert.ok(r.score < MATCH_THRESHOLD, "must not auto-accept a different person");
  });

  it("does not match an unrelated person", () => {
    assert.equal(scoreNameMatch(want, { fromName: "Harmony Norris" }).score, 0);
    assert.equal(scoreNameMatch(want, { email: "someone@else.com" }).score, 0);
  });
});

describe("rankCandidates", () => {
  it("orders best first and drops non-matches", () => {
    const ranked = rankCandidates("breanna escobar", [
      { fromName: "Harmony Norris", email: "harm.norris@x.com" },
      { fromName: "Marcus Escobar", email: "marcus@x.com" },
      { fromName: "Bre Escobar", email: "bre.escobar@x.com" },
    ]);
    assert.equal(ranked.length, 2, "unrelated person excluded");
    assert.equal(ranked[0]!.candidate.fromName, "Bre Escobar");
  });
});
