import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { loadConfig } from "../config.js";
import { StateStore } from "../state/store.js";
import { CampaignBounceAutostopService } from "./campaignBounceAutostop.js";

function store(): StateStore {
  return new StateStore(
    `/tmp/dw-bounce-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`,
  );
}

describe("CampaignBounceAutostopService (D90)", () => {
  it("pauses over 10% after 1k leads, not on the old 20/7 bands", async () => {
    const paused: number[] = [];
    const started: number[] = [];
    const settings: Array<{ id: number; threshold: unknown }> = [];
    const service = new CampaignBounceAutostopService(
      loadConfig({ DRY_RUN: "false" }),
      {
        listCampaigns: async () => [
          { id: 1, name: "Under 1k hot", status: "ACTIVE" },
          { id: 2, name: "Over 1k at 10%", status: "ACTIVE" },
          { id: 3, name: "Over 1k over 10%", status: "ACTIVE" },
          { id: 4, name: "Old 20/7 mid-volume", status: "ACTIVE" },
          { id: 6, name: "Already paused", status: "PAUSED" },
          { id: 9, name: "Pod control shell", status: "ACTIVE" },
        ],
        getCampaignAnalyticsByDate: async (id: number) => {
          if (id === 1) return { sent_count: 400, bounce_count: 80 };
          if (id === 2) return { sent_count: 1000, bounce_count: 100 };
          if (id === 3) return { sent_count: 1000, bounce_count: 101 };
          if (id === 4) return { sent_count: 150, bounce_count: 40 };
          return { sent_count: 500, bounce_count: 200 };
        },
        getCampaignStatistics: async () => ({}),
        updateCampaignStatus: async (id: number, status: string) => {
          if (status === "PAUSED") paused.push(id);
          if (status === "START") started.push(id);
        },
        getCampaignSettings: async () => ({ bounce_autopause_threshold: "7" }),
        updateCampaignSettings: async (id: number, body: Record<string, unknown>) => {
          settings.push({ id, threshold: body.bounce_autopause_threshold });
        },
      } as never,
      store(),
    );

    const result = await service.run({ dryRun: false });
    assert.deepEqual(result.paused.map((row) => row.campaignId), [3]);
    assert.equal(result.paused[0]?.reason, "rate");
    assert.deepEqual(paused, [3]);
    assert.deepEqual(started, []);
    assert.equal(
      settings.every((row) => row.threshold === "100"),
      true,
    );
    assert.equal(settings.some((row) => row.id === 9), false);
    assert.ok(settings.some((row) => row.id === 6));
  });

  it("pauses when more than 10 bounces land in the last 10 minutes", async () => {
    const paused: number[] = [];
    const state = store();
    state.setBounceSnapshot(8, {
      bounced: 3,
      sent: 40,
      at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });
    const service = new CampaignBounceAutostopService(
      loadConfig({ DRY_RUN: "false" }),
      {
        listCampaigns: async () => [
          { id: 8, name: "Burst", status: "ACTIVE" },
        ],
        getCampaignAnalyticsByDate: async () => ({
          sent_count: 55,
          bounce_count: 15,
        }),
        getCampaignStatistics: async () => ({}),
        updateCampaignStatus: async (id: number, status: string) => {
          if (status === "PAUSED") paused.push(id);
        },
        getCampaignSettings: async () => ({ bounce_autopause_threshold: "100" }),
        updateCampaignSettings: async () => undefined,
      } as never,
      state,
    );

    const result = await service.run({ dryRun: false });
    assert.deepEqual(paused, [8]);
    assert.equal(result.paused[0]?.reason, "burst");
    assert.equal(result.paused[0]?.burstBounces, 12);
  });

  it("does not burst-pause on the first snapshot or on exactly 10 new bounces", async () => {
    const paused: number[] = [];
    const state = store();
    const service = new CampaignBounceAutostopService(
      loadConfig({ DRY_RUN: "false" }),
      {
        listCampaigns: async () => [
          { id: 8, name: "Warming", status: "ACTIVE" },
        ],
        getCampaignAnalyticsByDate: async () => ({
          sent_count: 40,
          bounce_count: 12,
        }),
        getCampaignStatistics: async () => ({}),
        updateCampaignStatus: async (id: number, status: string) => {
          if (status === "PAUSED") paused.push(id);
        },
        getCampaignSettings: async () => ({ bounce_autopause_threshold: "100" }),
        updateCampaignSettings: async () => undefined,
      } as never,
      state,
    );

    await service.run({ dryRun: false });
    assert.deepEqual(paused, []);
    assert.ok(state.getBounceSnapshot(8));

    state.setBounceSnapshot(8, {
      bounced: 2,
      sent: 30,
      at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });
    await service.run({ dryRun: false });
    assert.deepEqual(paused, [], "exactly 10 new bounces must not pause");
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
    const autopauseOff = new Map<string, string>();
    let forceAllAt: string | null = null;
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
      getAutopauseForceAllAt: () => forceAllAt,
      setAutopauseForceAllAt: (iso: string) => {
        forceAllAt = iso;
      },
      getBounceSnapshot: () => undefined,
      setBounceSnapshot: () => undefined,
      save: async () => undefined,
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
      getCampaignSettings: async () => {
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

  it("D124: forces a GET-echo write once even when cache and GET already say 100", async () => {
    const writes: Array<{ id: number; body: Record<string, unknown> }> = [];
    const autopauseOff = new Map<string, string>([
      ["1", "already"],
      ["4", "already"],
    ]);
    let forceAllAt: string | null = null;
    const state = {
      getAutopauseOffAt: (id: number) => autopauseOff.get(String(id)),
      markAutopauseOff: (id: number) => {
        autopauseOff.set(String(id), new Date().toISOString());
      },
      getLastAutopauseVerifyAt: () => new Date().toISOString(),
      setLastAutopauseVerifyAt: () => undefined,
      getAutopauseForceAllAt: () => forceAllAt,
      setAutopauseForceAllAt: (iso: string) => {
        forceAllAt = iso;
      },
      getBounceSnapshot: () => undefined,
      setBounceSnapshot: () => undefined,
      save: async () => undefined,
    } as never;
    const service = new CampaignBounceAutostopService(
      loadConfig({ DRY_RUN: "false" }),
      {
        listCampaigns: async () => [
          { id: 1, name: "Live", status: "ACTIVE" },
          { id: 2, name: "Old", status: "COMPLETED" },
          { id: 4, name: "Paused", status: "PAUSED" },
          { id: 9, name: "Pod control shell", status: "ACTIVE" },
        ],
        getCampaignAnalyticsByDate: async () => ({
          sent_count: 10,
          bounce_count: 0,
        }),
        getCampaignStatistics: async () => ({}),
        getCampaignSettings: async () => ({
          bounce_autopause_threshold: "100",
          send_as_plain_text: true,
        }),
        updateCampaignStatus: async () => undefined,
        updateCampaignSettings: async (
          id: number,
          body: Record<string, unknown>,
        ) => {
          writes.push({ id, body });
        },
      } as never,
      state,
    );

    const first = await service.run({ dryRun: false });
    assert.equal(first.smartleadDisabled, 2);
    assert.deepEqual(
      writes.map((row) => row.id).sort((a, b) => a - b),
      [1, 4],
    );
    assert.ok(
      writes.every((row) => row.body.bounce_autopause_threshold === "100"),
    );
    assert.ok(writes.every((row) => row.body.send_as_plain_text === true));
    assert.ok(forceAllAt);

    writes.length = 0;
    const second = await service.run({ dryRun: false });
    assert.deepEqual(writes, []);
    assert.equal(second.smartleadDisabled, 0);
  });
});
