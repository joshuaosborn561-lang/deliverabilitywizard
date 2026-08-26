import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bounceReasonSnippet,
  classifyBounceText,
  summarizeBounceSamples,
} from "./bounceReason.js";

describe("bounce reason classification (D140)", () => {
  it("reads the real Microsoft tenant-cap NDR as tenant_rate_limit", () => {
    const body =
      "Remote server returned '550 5.7.233 - Your message can't be sent because your tenant has exceeded its daily limit for sending email to external recipients (tenant external recipient rate limit). For more information see https://aka.ms/EXONdrs.'";
    assert.equal(classifyBounceText(body), "tenant_rate_limit");
    assert.match(bounceReasonSnippet(body), /5\.7\.233/);
  });

  it("reads a user-unknown NDR as invalid_recipient", () => {
    assert.equal(
      classifyBounceText(
        "Remote server returned '550 5.1.1 The email account that you tried to reach does not exist.'",
      ),
      "invalid_recipient",
    );
  });

  it("reads a spam/policy block as content_block", () => {
    assert.equal(
      classifyBounceText(
        "Remote server returned '550 5.7.1 Message rejected due to content policy. This message resembles spam.'",
      ),
      "content_block",
    );
  });

  it("summarizes toward the dominant class", () => {
    const { dominant, summary } = summarizeBounceSamples([
      { leadEmail: "a", senderEmail: "x@t.com", bounceClass: "tenant_rate_limit", snippet: "" },
      { leadEmail: "b", senderEmail: "y@t.com", bounceClass: "tenant_rate_limit", snippet: "" },
      { leadEmail: "c", senderEmail: "z@t.com", bounceClass: "invalid_recipient", snippet: "" },
    ]);
    assert.equal(dominant, "tenant_rate_limit");
    assert.match(summary, /tenant_rate_limit×2/);
    assert.match(summary, /invalid_recipient×1/);
  });
});
