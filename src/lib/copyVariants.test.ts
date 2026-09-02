import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  generateCopyVariants,
  isSingleVariable,
  rankVariants,
  sentenceElement,
} from "./copyVariants.js";

const BODY = [
  "Hi there,",
  "We have a free consult this week for teams that already spend on ads.",
  "Book here: https://book.salesglidergrowth.co/x",
  "Call 415-555-0100",
  "— Acme Growth",
].join("\n");

describe("copy variants", () => {
  it("changes exactly one thing and keeps Eric's free → complimentary swap first", () => {
    const variants = generateCopyVariants({
      subject: "Free consult this week",
      body: BODY,
      controlSubject: "Quick check-in",
      companyName: "Acme Growth",
      flaggedTerms: ["free"],
    });
    const free = variants.find((row) => row.element.toLowerCase() === "free");
    assert.ok(free);
    assert.match(free.body, /complimentary/i);
    assert.doesNotMatch(free.body, /\bfree\b/i);
    assert.equal(free.subject, "Free consult this week");
    assert.equal(
      isSingleVariable(
        { subject: "Free consult this week", body: BODY },
        free,
      ),
      true,
    );
    assert.ok(variants.some((row) => row.kind === "link"));
    assert.ok(variants.some((row) => row.element === "phone"));
    assert.ok(variants.some((row) => row.kind === "subject_pattern"));
  });

  it("discards a two-field change", () => {
    assert.equal(
      isSingleVariable(
        { subject: "A", body: "B" },
        { subject: "C", body: "D" },
      ),
      false,
    );
  });

  it("keeps the full offer sentence as the variant element (D168)", () => {
    const sentence =
      "I've got a jet ski sitting unused this Saturday morning and thought you might want to take it out on the lake.";
    assert.ok(sentence.length > 80);
    const variants = generateCopyVariants({
      subject: "Hi",
      body: `Hi there,\n\n${sentence}\n\nWorth a chat?`,
      controlSubject: "Quick check-in",
    });
    const phrase = variants.find((row) =>
      row.element.toLowerCase().includes("jet ski"),
    );
    assert.ok(phrase, "jet ski sentence must be a variant element");
    assert.match(phrase.element, /on the lake/i);
    assert.ok(phrase.element.length > 80);
    assert.equal(sentenceElement(sentence), sentence);
  });

  it("ranks flagged terms first then caps", () => {
    const variants = generateCopyVariants({
      subject: "Hello",
      body: BODY,
      controlSubject: "Quick check-in",
      flaggedTerms: ["free"],
    });
    const top = rankVariants(variants, ["free"], 1);
    assert.equal(top.length, 1);
    assert.equal(top[0]?.element.toLowerCase(), "free");
  });
});
