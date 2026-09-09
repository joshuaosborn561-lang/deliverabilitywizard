import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  closeMergeKeyMatches,
  customFieldKeys,
  customMergeTags,
  detectSentMergeHoles,
  extractCampaignLeads,
  extractLeadTotal,
  extractMergeTags,
  extractSentBodies,
  flattenCampaignLead,
  formatMergeTagFinding,
  judgeMergeTagFill,
  leadInventoryGrew,
  MIN_CUSTOM_COVERAGE,
  sampleLeadOffsets,
  visibleCopyText,
} from "./mergeTags.js";

const GATEWAY_COPY =
  "you're a Microsoft shop with {{gateway_provider}} on top... Defender P2, which {{gateway_provider}} covers";

describe("merge tag extract (D180)", () => {
  it("pulls unique {{tags}} including spaced names", () => {
    assert.deepEqual(
      extractMergeTags(
        "Hey {{first_name}}, {{ company_name }} plus {{gateway_provider}} and {{first_name}} again",
      ),
      ["first_name", "company_name", "gateway_provider"],
    );
  });

  it("treats only the skill allowlist as system; Signature is a builtin", () => {
    assert.deepEqual(
      customMergeTags(["first_name", "job_title", "gateway_provider", "Signature", "email"]),
      ["job_title", "gateway_provider"],
    );
  });
});

describe("merge tag fill judgment (D180)", () => {
  it("fails a custom key that is absent across a multi-offset sample", () => {
    const leads = [
      flattenCampaignLead({
        lead: { custom_fields: { job_title: "CIO", Local_Sports_Team: "Astros" } },
      }),
      flattenCampaignLead({
        lead: { custom_fields: { job_title: "IT Director", gateway: "Proofpoint" } },
      }),
    ];
    const fills = judgeMergeTagFill({
      tags: ["first_name", "gateway_provider"],
      leads,
      firstSeenIn: { gateway_provider: "step 1 A" },
    });
    assert.equal(fills.length, 1);
    assert.equal(fills[0]!.tag, "gateway_provider");
    assert.equal(fills[0]!.status, "absent");
    assert.equal(fills[0]!.present, 0);
    assert.ok(fills[0]!.closest.includes("gateway"));
    const detail = formatMergeTagFinding({ fills, holes: [] });
    assert.match(detail ?? "", /\{\{gateway_provider\}\} absent 0\/2/);
    assert.match(detail ?? "", /first in step 1 A/);
  });

  it("fails a real key that is filled on too few sampled leads", () => {
    const leads = [
      { custom_fields: { gift: "AirPods" } },
      { custom_fields: { job_title: "CIO" } },
      { custom_fields: { job_title: "IT" } },
      { custom_fields: {} },
      { custom_fields: { gift: "" } },
    ];
    const fills = judgeMergeTagFill({ tags: ["gift"], leads });
    assert.equal(fills[0]!.status, "thin");
    assert.equal(fills[0]!.present, 1);
    assert.ok(fills[0]!.share < MIN_CUSTOM_COVERAGE);
  });

  it("passes a custom key filled on enough sampled leads", () => {
    const leads = Array.from({ length: 10 }, (_, i) => ({
      custom_fields: { Local_Sports_Team: i === 9 ? "Cubs" : "Astros" },
    }));
    const fills = judgeMergeTagFill({ tags: ["Local_Sports_Team"], leads });
    assert.equal(fills[0]!.status, "ok");
    assert.equal(fills[0]!.present, 10);
  });

  it("ignores empty custom_fields values and reads nested Smartlead lead rows", () => {
    const payload = {
      total_leads: "2660",
      data: [
        {
          lead: {
            first_name: "Gabe",
            custom_fields: { job_title: "CIO", gateway_provider: "  " },
          },
        },
        { custom_fields: { job_title: "IT Director" } },
      ],
    };
    const leads = extractCampaignLeads(payload);
    assert.equal(extractLeadTotal(payload), 2660);
    assert.deepEqual([...customFieldKeys(leads[0]!)], ["job_title"]);
    const fills = judgeMergeTagFill({ tags: ["gateway_provider"], leads });
    assert.equal(fills[0]!.status, "absent");
  });

  it("samples several offsets, not just 0", () => {
    assert.deepEqual(sampleLeadOffsets(2660, 40, 4), [0, 873, 1746, 2620]);
    assert.deepEqual(sampleLeadOffsets(20, 40, 4), [0]);
  });

  it("treats a material lead-list grow as a resample trigger", () => {
    assert.equal(leadInventoryGrew(100, 120), false);
    assert.equal(leadInventoryGrew(200, 260), true);
    assert.equal(leadInventoryGrew(null, 80), true);
  });

  it("hints a close key when the tag name is slightly wrong", () => {
    assert.deepEqual(
      closeMergeKeyMatches("gatewayprovider", ["job_title", "gateway_provider", "vendor"]),
      ["gateway_provider"],
    );
  });
});

describe("sent-body merge holes (D180)", () => {
  it("flags leftover literal {{tag}} in a sent email_message", () => {
    const holes = detectSentMergeHoles({
      sentBodies: ["Hey Jacob, Microsoft shop with {{gateway_provider}} on top"],
      customTags: ["gateway_provider"],
    });
    assert.equal(holes[0]!.kind, "literal");
    assert.equal(holes[0]!.tag, "gateway_provider");
  });

  it("flags the Insight blank-hole render from statistics samples", () => {
    const sent =
      "<div>ran Horizon Health's MX and saw you're a Microsoft shop with  on top... wondering if you're on E3 or E5, since you might be double paying for Defender P2, which  covers</div>";
    const holes = detectSentMergeHoles({
      sentBodies: [sent],
      customTags: ["gateway_provider"],
      sequenceTexts: [GATEWAY_COPY],
    });
    assert.ok(
      holes.some((hole) => hole.kind === "blank" && hole.tag === "gateway_provider"),
      `expected a blank hole, got ${JSON.stringify(holes)}`,
    );
    assert.match(visibleCopyText(sent), /shop with  on top/);
  });

  it("reads email_message off a statistics dump", () => {
    const bodies = extractSentBodies({
      data: [
        { email_message: "shop with  on top" },
        { email_subject: "lunch" },
      ],
    });
    assert.deepEqual(bodies, ["shop with  on top"]);
  });
});
