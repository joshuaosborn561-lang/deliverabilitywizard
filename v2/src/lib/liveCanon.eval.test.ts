import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { normalizeCampaign } from "../clients/smartlead.js";
import {
  espMatchingViolation,
  plainTextSettingsViolation,
  sendWindowViolation,
} from "./campaignCanon.js";
import { isActiveStatus } from "./staffable.js";

const DUMP =
  "/home/ubuntu/.cursor/projects/workspace/agent-tools/3db87325-d637-4fda-b98f-f01fa6a1b633.txt";

function loadLiveCampaigns(): ReturnType<typeof normalizeCampaign>[] {
  if (!existsSync(DUMP)) return [];
  const raw = readFileSync(DUMP, "utf8");
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end < 0) return [];
  const rows = JSON.parse(raw.slice(start, end + 1)) as unknown[];
  return rows.map((row) => normalizeCampaign(row as Record<string, unknown>));
}

describe("D280 live Smartlead settings (read-only dump)", () => {
  it("does not blanket-flag every ACTIVE campaign for ESP matching, plain text, or send window", () => {
    const campaigns = loadLiveCampaigns();
    if (!campaigns.length) {
      assert.ok(true, "no live dump in this environment");
      return;
    }
    const active = campaigns.filter((c) => isActiveStatus(c.status));
    assert.ok(active.length >= 70, `expected a full board, got ${active.length} ACTIVE`);
    const esp = active.filter((c) => espMatchingViolation(c)).length;
    const plain = active.filter((c) => plainTextSettingsViolation(c)).length;
    const window = active.filter((c) => sendWindowViolation(c)).length;
    assert.equal(esp, 0, "live ACTIVE campaigns already have ESP matching on");
    assert.equal(plain, 0, "live ACTIVE campaigns already send plain text with tracking off");
    assert.notEqual(window, active.length, "send_window must be per-campaign, not every ACTIVE");
    assert.ok(window > 0, "some live campaigns really are off the standing window");
    const ugly = [3847940, 3921850, 3921852, 3921869, 4037540];
    for (const id of ugly) {
      const row = active.find((c) => c.id === id);
      assert.ok(row, `missing ugly campaign #${id}`);
      assert.equal(espMatchingViolation(row!), null);
      assert.equal(plainTextSettingsViolation(row!), null);
    }
  });
});
