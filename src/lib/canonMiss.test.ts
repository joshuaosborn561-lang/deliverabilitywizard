import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canonMissText,
  collectCanonMisses,
  currentCanonMiss,
} from "./canonMiss.js";

const EDU = {
  campaignId: 3826690,
  campaignName: "Goliath Education",
};

describe("canon miss incidents (D162)", () => {
  it("pages ugly same-ESP when nothing is queued or evaluated", () => {
    const miss = currentCanonMiss({
      ...EDU,
      score: { inboxPercent: 0, source: "canary-copy" },
      threshold: 80,
    });
    assert.equal(miss?.kind, "ugly");
    assert.match(miss?.detail ?? "", /canary-copy same-ESP 0%/);
  });

  it("prefers the isolation verdict over the ugly reading", () => {
    const miss = currentCanonMiss({
      ...EDU,
      score: { inboxPercent: 0, source: "canary-copy" },
      suspect: { evaluatedAt: "2026-08-26T12:00:00.000Z" },
      latestRun: { verdict: "INCONCLUSIVE", reason: "need another reading" },
      threshold: 80,
    });
    assert.equal(miss?.kind, "INCONCLUSIVE");
  });

  it("pages COPY and INFRA while the campaign is still ugly", () => {
    assert.equal(
      currentCanonMiss({
        ...EDU,
        score: { inboxPercent: 0, source: "canary-copy" },
        latestRun: { verdict: "COPY", teardownStarted: true },
        threshold: 80,
      })?.kind,
      "COPY",
    );
    assert.equal(
      currentCanonMiss({
        ...EDU,
        score: { inboxPercent: 22, source: "live-placement" },
        latestRun: { verdict: "INFRA" },
        threshold: 80,
      })?.kind,
      "INFRA",
    );
  });

  it("pages a queued suspect before evaluate lands", () => {
    const miss = currentCanonMiss({
      ...EDU,
      score: { inboxPercent: 0, source: "canary-copy" },
      suspect: { reason: "Canary-copy same-ESP under 80% (Gmail 0%)." },
      threshold: 80,
    });
    assert.equal(miss?.kind, "queued");
  });

  it("clears when same-ESP is back at or above the bar", () => {
    assert.equal(
      currentCanonMiss({
        ...EDU,
        score: { inboxPercent: 90, source: "canary-copy" },
        latestRun: { verdict: "COPY", teardownStarted: true },
        threshold: 80,
      }),
      null,
    );
  });

  it("pages a content_block INCONCLUSIVE with no placement score yet", () => {
    const miss = currentCanonMiss({
      ...EDU,
      suspect: {
        evaluatedAt: "2026-08-28T00:00:00.000Z",
        reason: "dominant bounce class content_block",
      },
      latestRun: { verdict: "INCONCLUSIVE", reason: "need another reading" },
      threshold: 80,
    });
    assert.equal(miss?.kind, "INCONCLUSIVE");
  });

  it("collects one row per ugly campaign and skips healthy ones", () => {
    const rows = collectCanonMisses({
      scores: [
        {
          campaignId: 3826690,
          campaignName: "Goliath Education",
          inboxPercent: 0,
          source: "canary-copy",
        },
        {
          campaignId: 1,
          campaignName: "Fine",
          inboxPercent: 95,
          source: "live-placement",
        },
      ],
      suspects: [],
      latestRun: () => undefined,
      threshold: 80,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.campaignId, 3826690);
    assert.equal(rows[0]?.kind, "ugly");
  });

  it("Slack copy names the campaign, the miss, and the in-thread ask", () => {
    const text = canonMissText({
      campaignId: 3847794,
      campaignName: "TechEvo SFL Startup Owners AirPods",
      kind: "COPY",
      detail: "canary-copy same-ESP 0% (bar 80%)",
      inboxPercent: 0,
      source: "canary-copy",
    });
    assert.match(text, /CANON miss — isolation evaluated COPY/);
    assert.match(text, /TechEvo SFL Startup Owners AirPods #3847794/);
    assert.match(text, /Investigate in-thread/);
    assert.doesNotMatch(text, /retire this domain/i);
  });
});
