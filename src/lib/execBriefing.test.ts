import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  briefingFromHealthBundle,
  briefingFromMonitorBundle,
  briefingNeedsPost,
  formatExecBriefing,
} from "./execBriefing.js";

describe("execBriefing", () => {
  it("formats Done / Needs attention / Quiet sections", () => {
    const text = formatExecBriefing({
      title: "monitor",
      done: ["Remediation: held 2"],
      attention: ["ACTIVE campaigns without a living placement test (1): #1 X"],
      quiet: ["Warmup gate: no pulls"],
    });
    assert.match(text, /^\*Ops briefing — monitor\*/m);
    assert.match(text, /\*Done\*/);
    assert.match(text, /\*Needs attention\*/);
    assert.match(text, /\*Quiet \(ran, nothing to fix\)\*/);
    assert.match(text, /placement test/);
  });

  it("says None when attention is empty", () => {
    const text = formatExecBriefing({ title: "health", done: ["ok"] });
    assert.match(text, /Needs attention\*\n• None/);
  });

  it("surfaces untested and understaffed campaigns from monitor audit", () => {
    const briefing = briefingFromMonitorBundle({
      monitor: { testsChecked: 3, blacklistAlerts: 0, lowDeliverabilityAlerts: 0, errors: [] },
      campaignAudit: {
        untested: [{ id: 3781908, name: "Goliath L1", shortBy: 0 }],
        understaffed: [{ id: 1, name: "Thin", shortBy: 12 }],
        totalShortfall: 12,
      },
      warmupGate: { removed: 0, errors: [] },
    });
    assert.ok(
      briefing.attention?.some((a) => /without a living placement test/i.test(a)),
    );
    assert.ok(briefing.attention?.some((a) => /Understaffed/i.test(a)));
  });

  it("flags mailbox gap drift as attention on health", () => {
    const briefing = briefingFromHealthBundle({
      health: { topUp: { assigned: [] }, resumed: [], stillShort: [], errors: [] },
      mailboxGap: { minGapSet: 4, sendLimitSet: 0, errors: [] },
    });
    assert.ok(briefing.attention?.some((a) => /min-gap drift/i.test(a)));
    assert.equal(briefingNeedsPost(briefing), true);
  });

  it("does not post a quiet health pass with no done/attention", () => {
    const briefing = briefingFromHealthBundle({
      health: { topUp: { assigned: [] }, resumed: [], stillShort: [], errors: [] },
      mailboxGap: { minGapSet: 0, sendLimitSet: 0, errors: [] },
    });
    assert.equal(briefingNeedsPost(briefing), false);
    assert.equal(briefingNeedsPost(briefing, { force: true }), true);
  });
});
