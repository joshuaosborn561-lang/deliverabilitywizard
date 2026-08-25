import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { loadConfig } from "../config.js";
import { CampaignBounceAutostopService } from "./campaignBounceAutostop.js";

describe("CampaignBounceAutostopService (D80)", () => {
  it("pauses on the 100/20 and 500/7 bands and ignores a 10-send spike", async () => {
    const paused: number[] = [];
    const started: number[] = [];
    const settings: Array<{ id: number; threshold: unknown }> = [];
    const analytics: Record<number, { sent_count: number; bounce_count: number }> = {
      1: { sent_count: 10, bounce_count: 4 },
      2: { sent_count: 150, bounce_count: 31 },
      3: { sent_count: 150, bounce_count: 20 },
      4: { sent_count: 500, bounce_count: 36 },
      5: { sent_count: 500, bounce_count: 35 },
      6: { sent_count: 200, bounce_count: 50 },
    };
    const service = new CampaignBounceAutostopService(
      loadConfig({ DRY_RUN: "false" }),
      {
        listCampaigns: async () => [
          { id: 1, name: "Tiny sample", status: "ACTIVE" },
          { id: 2, name: "Mid volume hot", status: "ACTIVE" },
          { id: 3, name: "Mid volume ok", status: "ACTIVE" },
          { id: 4, name: "High volume hot", status: "ACTIVE" },
          { id: 5, name: "High volume ok", status: "ACTIVE" },
          { id: 6, name: "Already paused", status: "PAUSED" },
          { id: 9, name: "Pod control shell", status: "ACTIVE" },
        ],
        getCampaignAnalyticsByDate: async (id: number) => analytics[id] ?? {},
        getCampaignStatistics: async () => ({}),
        updateCampaignStatus: async (id: number, status: string) => {
          if (status === "PAUSED") paused.push(id);
          if (status === "START") started.push(id);
        },
        updateCampaignSettings: async (id: number, body: Record<string, unknown>) => {
          settings.push({ id, threshold: body.bounce_autopause_threshold });
        },
      } as never,
    );

    const result = await service.run({ dryRun: false });
    assert.deepEqual(
      result.paused.map((row) => row.campaignId).sort((a, b) => a - b),
      [2, 4],
    );
    assert.deepEqual(paused.sort((a, b) => a - b), [2, 4]);
    assert.deepEqual(started, []);
    assert.equal(result.paused.some((row) => row.campaignId === 1), false);
    assert.equal(
      settings.every((row) => row.threshold === "100"),
      true,
    );
    assert.equal(
      settings.some((row) => row.id === 9),
      false,
    );
    assert.ok(settings.some((row) => row.id === 6));
  });

  it("never STARTs a campaign and does not touch pendingResumes", async () => {
    const src = await readFile(
      new URL("./campaignBounceAutostop.ts", import.meta.url),
      "utf8",
    );
    assert.equal(/updateCampaignStatus\([^)]*START/.test(src), false);
    assert.equal(/hasPendingResume|markPendingResume|clearPendingResume/.test(src), false);
  });

  it("D84: converge skips COMPLETED/STOPPED and writes each campaign once, not every 10 minutes", async () => {
    const settings: Array<{ id: number }> = [];
    const settingsReads: number[] = [];
    const autopauseOff = new Map<string, string>();
    const state = {
      getAutopauseOffAt: (id: number) => autopauseOff.get(String(id)),
      markAutopauseOff: (id: number) => {
        autopauseOff.set(String(id), new Date().toISOString());
      },
      clearAutopauseOff: (id: number) => {
        autopauseOff.delete(String(id));
      },
      getLastAutopauseVerifyAt: () => new Date().toISOString(),
      setLastAutopauseVerifyAt: () => undefined,
    } as never;
    const smartlead = {
      listCampaigns: async () => [
        { id: 1, name: "Live", status: "ACTIVE" },
        { id: 2, name: "Old", status: "COMPLETED" },
        { id: 3, name: "Killed", status: "STOPPED" },
        { id: 4, name: "Paused", status: "PAUSED" },
      ],
      getCampaignAnalyticsByDate: async () => ({ sent_count: 10, bounce_count: 0 }),
      getCampaignStatistics: async () => ({}),
      getCampaignSettings: async (id: number) => {
        settingsReads.push(id);
        return { bounce_autopause_threshold: "100" };
      },
      updateCampaignStatus: async () => undefined,
      updateCampaignSettings: async (id: number) => {
        settings.push({ id });
      },
    } as never;

    const service = new CampaignBounceAutostopService(
      loadConfig({ DRY_RUN: "false" }),
      smartlead,
      state,
    );

    await service.run({ dryRun: false });
    assert.deepEqual(
      settings.map((row) => row.id).sort((a, b) => a - b),
      [1, 4],
      "only living campaigns get the off write; COMPLETED/STOPPED are never touched",
    );

    settings.length = 0;
    await service.run({ dryRun: false });
    assert.deepEqual(
      settings,
      [],
      "an already-converged campaign is not rewritten every pass (write-on-drift)",
    );
  });
});
