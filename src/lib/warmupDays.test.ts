import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { DEFAULT_WARMUP_DAYS } from "./warmupDays.js";
import { loadConfig } from "../config.js";
import { GENERIC_LEDGER_WARMUP_DAYS } from "./genericLedger.js";
import { EVIDENCE_HOLD_WARMUP_DAYS } from "./evidenceHold.js";
import { MAILBOX_REST_DAYS } from "./mailboxRest.js";
import { countsAsWarmed } from "../services/warmupGate.js";

describe("D313 — warmup is 14 days", () => {
  it("default is 14 everywhere; the rest stays 28", () => {
    assert.equal(DEFAULT_WARMUP_DAYS, 14);
    assert.equal(GENERIC_LEDGER_WARMUP_DAYS, 14);
    assert.equal(EVIDENCE_HOLD_WARMUP_DAYS, 14);
    assert.equal(MAILBOX_REST_DAYS, 28);
  });

  it("a 14-day-old seat counts as warmed; 13 does not", () => {
    assert.equal(countsAsWarmed([], 14), true);
    assert.equal(countsAsWarmed([], 13), false);
  });

  it("config defaults to 14 and the env vars still override", () => {
    const base = process.env;
    const get = (extra: Record<string, string>) => {
      const saved = { ...process.env };
      Object.assign(process.env, extra);
      try {
        return loadConfig();
      } finally {
        process.env = saved;
      }
    };
    void base;
    const dflt = get({});
    assert.equal(dflt.poolWarmupDays, 14);
    assert.equal(dflt.campaignMinWarmupDays, 14);
    assert.equal(dflt.freshInboxWarmupDays, 14);
    const over = get({ POOL_WARMUP_DAYS: "10", MIN_CAMPAIGN_WARMUP_DAYS: "9", FRESH_INBOX_WARMUP_DAYS: "8" });
    assert.equal(over.poolWarmupDays, 10);
    assert.equal(over.campaignMinWarmupDays, 9);
    assert.equal(over.freshInboxWarmupDays, 8);
  });

  it("LOCKED canon and CANON carry no 21-day warmup", async () => {
    for (const p of ["../lib/lockedCanon.ts", "../../CANON.md", "../../docs/LOCKED-CANON.md"]) {
      const text = await readFile(new URL(p, import.meta.url), "utf8");
      assert.doesNotMatch(text, /\b21[- ]days?\b|\b21\+ days|reaches 21|≥21/i, `${p} still says 21`);
    }
  });
});
