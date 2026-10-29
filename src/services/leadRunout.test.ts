import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { loadConfig } from "../config.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { StateStore } from "../state/store.js";
import { LeadRunoutService } from "./leadRunout.js";

describe("LeadRunoutService", () => {
  it("flags a working campaign at three quarters and does not import", async () => {
    const state = new StateStore(
      `/tmp/lead-runout-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const sent: string[] = [];
    const slack = {
      notifyLeadRunout: async ({ text }: { text: string }) => {
        sent.push(text);
      },
    } as unknown as SlackClient;

    const smartlead = {
      listCampaigns: async () => [
        { id: 9, name: "Parlay A", status: "ACTIVE" },
      ],
      getCampaignStatistics: async () => ({
        total_leads: 800,
        contacted: 620,
        replied: 18,
        reply_rate: 2.9,
        positive_reply_count: 6,
      }),
      getCampaignAnalyticsByDate: async () => ({ sent_count: 600 }),
      getCampaign: async () => ({ id: 9 }),
    } as unknown as SmartleadClient;

    const service = new LeadRunoutService(
      loadConfig({ ENABLE_LEAD_RUNOUT: "true" }),
      smartlead,
      slack,
      state,
    );
    const first = await service.run();
    assert.equal(first.flagged[0]?.stage, "three_quarters");
    assert.match(sent[0] ?? "", /Parlay A/);
    assert.match(sent[0] ?? "", /have not imported/);

    const second = await service.run();
    assert.equal(second.flagged.length, 0);
    assert.equal(sent.length, 1);
  });

  it("D320: stops at its time budget, carries the rest, resumes there, reads retry once", async () => {
    const state = new StateStore(
      `/tmp/lead-runout-d320-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const seen: number[] = [];
    const retriesSeen = new Set<number | undefined>();
    const smartlead = {
      listCampaigns: async () =>
        Array.from({ length: 6 }, (_, i) => ({ id: i + 1, name: `C${i + 1}`, status: "ACTIVE" })),
      getCampaignStatistics: async (id: number, _q: unknown, opts?: { retries?: number }) => {
        seen.push(id);
        retriesSeen.add(opts?.retries);
        await new Promise((r) => setTimeout(r, 40));
        return { total_leads: 100, contacted: 1, replied: 0 };
      },
      getCampaignAnalyticsByDate: async () => ({ sent_count: 0 }),
      getCampaign: async () => ({}),
    } as unknown as SmartleadClient;
    const service = new LeadRunoutService(
      loadConfig({ ENABLE_LEAD_RUNOUT: "true" }),
      smartlead,
      { notifyLeadRunout: async () => undefined } as unknown as SlackClient,
      state,
      250,
    );
    const first = await service.run();
    assert.ok((first.carriedOver ?? 0) > 0 && (first.carriedOver ?? 0) < 6, "budget did not carry over");
    assert.deepEqual([...retriesSeen], [1]);
    seen.length = 0;
    await service.run();
    assert.ok(seen[0]! > 1, "second pass restarted at the top instead of resuming");
  });

  it("source file never imports leads", () => {
    const source = readFileSync(new URL("./leadRunout.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /addLeads|importLeads|uploadLeads|createLead/i);
  });
});
