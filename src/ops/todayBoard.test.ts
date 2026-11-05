import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CampaignCheckRecord } from "../lib/campaignCheck.js";
import { buildTodayBoard, campaignSettingsHint, nextHourlySweep } from "./todayBoard.js";

function check(partial: Partial<CampaignCheckRecord> & Pick<CampaignCheckRecord, "campaignId" | "name">): CampaignCheckRecord {
  return {
    firstSeenAt: "2026-11-04T16:00:00.000Z",
    firstCheckAt: "2026-11-04T16:00:00.000Z",
    firstPassedAt: "2026-11-04T16:00:00.000Z",
    lastSweepAt: "2026-11-04T17:00:00.000Z",
    lastKind: "hourly",
    findings: [],
    status: "ACTIVE",
    ...partial,
  };
}

const rollover = {
  daysUntil: 3,
  nextRolloverYmd: "2026-11-07",
  onWeekCohort: "A" as const,
  offWeekCohort: "B" as const,
};

describe("today board", () => {
  it("counts passing and failing cells from the hourly sweep", () => {
    const board = buildTodayBoard({
      now: new Date("2026-11-04T17:10:00.000Z"),
      hourlySweepEnabled: true,
      cronHealth: "*/15 * * * *",
      restRollover: rollover,
      clients: [
        { id: 1, name: "Vector" },
        { id: 2, name: "Parlay" },
      ],
      campaigns: [
        { id: 10, name: "Vector | Pod A", status: "ACTIVE", client_id: 1 },
        { id: 11, name: "Parlay | Pod A", status: "ACTIVE", client_id: 2 },
      ],
      checks: [
        check({ campaignId: 10, name: "Vector | Pod A", findings: [] }),
        check({
          campaignId: 11,
          name: "Parlay | Pod A",
          findings: ["no_placement_test: no living spam test"],
        }),
      ],
      placements: [
        {
          id: "t-1",
          campaignId: 11,
          campaignName: "Parlay | Pod A",
          status: "UNKNOWN",
        },
      ],
    });
    assert.equal(board.clientsTotal, 2);
    assert.equal(board.clientsAllGreen, 1);
    assert.equal(board.checksFailing, 1);
    assert.equal(board.checksPassing, 21);
    assert.equal(board.rows[1]?.clientName, "Vector");
    assert.equal(board.rows[0]?.cells.placement.ok, false);
    // The running (UNKNOWN, unscored) test is pending, not a second red.
    assert.equal(board.rows[0]?.cells.placement.failures.length, 1);
    assert.equal(board.hourlySweep, "on");
    assert.equal(board.canonCheck, "every 15 min");
    assert.equal(board.alertsLabel, "Slack");
    assert.match(campaignSettingsHint(), /Mon–Thu 7a–7p ET/);
    assert.match(board.columns.find((column) => column.id === "isolation")?.hint ?? "", /queues isolation/);
    assert.equal(board.lastSweepAt, "2026-11-04T17:00:00.000Z");
  });

  it("puts sequence-shape findings in Sequence, not Campaign settings", () => {
    const board = buildTodayBoard({
      hourlySweepEnabled: true,
      cronHealth: "*/15 * * * *",
      restRollover: rollover,
      clients: [{ id: 1, name: "Vector" }],
      campaigns: [{ id: 10, name: "Vector", status: "ACTIVE", client_id: 1 }],
      checks: [
        check({
          campaignId: 10,
          name: "Vector",
          findings: [
            "unverified: sequence read failed",
            "step2_delay: step 2 delay 3d (want 2)",
          ],
        }),
      ],
    });
    assert.equal(board.rows[0]?.cells.settings.ok, true);
    assert.equal(board.rows[0]?.cells.sequence.ok, false);
    assert.equal(board.rows[0]?.cells.sequence.failures.length, 2);
  });

  it("treats a scored placement as known even if the raw status said UNKNOWN", () => {
    const board = buildTodayBoard({
      hourlySweepEnabled: true,
      cronHealth: "*/15 * * * *",
      restRollover: rollover,
      clients: [{ id: 1, name: "Vector" }],
      campaigns: [{ id: 10, name: "Vector", status: "ACTIVE", client_id: 1 }],
      checks: [check({ campaignId: 10, name: "Vector" })],
      placements: [
        {
          id: "t-2",
          campaignId: 10,
          campaignName: "Vector",
          status: "UNKNOWN",
          googleInboxPercent: 91,
        },
      ],
    });
    assert.equal(board.rows[0]?.cells.placement.ok, true);
  });

  it("shows an unscored placement test as pending (grey), not a failure", () => {
    const board = buildTodayBoard({
      now: new Date("2026-11-05T17:00:00.000Z"),
      hourlySweepEnabled: true,
      cronHealth: "*/15 * * * *",
      restRollover: rollover,
      clients: [{ id: 1, name: "Ciotola" }],
      campaigns: [{ id: 10, name: "Ciotola", status: "ACTIVE", client_id: 1 }],
      checks: [check({ campaignId: 10, name: "Ciotola" })],
      placements: [{ id: "569845", campaignId: 10, campaignName: "Ciotola", status: "UNKNOWN" }],
      placementsGeneratedAt: "2026-11-05T16:30:00.000Z",
      statusById: new Map([[10, "ACTIVE"]]),
    });
    const cell = board.rows[0]!.cells.placement;
    assert.equal(cell.ok, true);
    assert.equal(cell.pending, 1);
    assert.equal(board.checksFailing, 0);
  });

  it("ignores placement rows for non-ACTIVE campaigns and stale snapshots", () => {
    const base = {
      now: new Date("2026-11-05T17:00:00.000Z"),
      hourlySweepEnabled: true,
      cronHealth: "*/15 * * * *",
      restRollover: rollover,
      clients: [{ id: 1, name: "Ciotola" }],
      campaigns: [
        { id: 10, name: "Ciotola A", status: "ACTIVE", client_id: 1 },
        { id: 11, name: "Ciotola B", status: "PAUSED", client_id: 1 },
      ],
      checks: [check({ campaignId: 10, name: "Ciotola A" })],
      statusById: new Map([
        [10, "ACTIVE"],
        [11, "PAUSED"],
      ]),
    };
    const paused = buildTodayBoard({
      ...base,
      placements: [{ id: "p", campaignId: 11, campaignName: "Ciotola B", status: "UNKNOWN" }],
      placementsGeneratedAt: "2026-11-05T16:30:00.000Z",
    });
    assert.equal(paused.rows[0]!.cells.placement.pending, undefined);
    const stale = buildTodayBoard({
      ...base,
      placements: [{ id: "s", campaignId: 10, campaignName: "Ciotola A", status: "UNKNOWN" }],
      placementsGeneratedAt: "2026-11-04T22:00:00.000Z",
    });
    assert.equal(stale.rows[0]!.cells.placement.pending, undefined);
    assert.equal(stale.rows[0]!.cells.placement.ok, true);
  });

  it("shows generic_idle as info, not a failing Generics cell", () => {
    const board = buildTodayBoard({
      hourlySweepEnabled: true,
      cronHealth: "*/15 * * * *",
      restRollover: rollover,
      clients: [{ id: 418274, name: "Parlay" }],
      campaigns: [{ id: 10, name: "Parlay", status: "ACTIVE", client_id: 418274 }],
      checks: [check({ campaignId: 10, name: "Parlay", findings: ["generic_idle: a@x.com idle on client 418274"] })],
      genericFindings: ["generic_idle: b@x.com idle on client 418274"],
    });
    const cell = board.rows[0]!.cells.generics;
    assert.equal(cell.ok, true);
    assert.ok((cell.info ?? 0) >= 1);
    assert.equal(board.checksFailing, 0);
  });

  it("schedules the next sweep on the following hour", () => {
    const now = new Date("2026-11-04T17:10:00.000Z");
    const next = nextHourlySweep(now);
    assert.equal(next.getMinutes(), 0);
    assert.equal(next.getSeconds(), 0);
    assert.ok(next.getTime() > now.getTime());
    assert.ok(next.getTime() - now.getTime() <= 60 * 60 * 1000);
  });
});
