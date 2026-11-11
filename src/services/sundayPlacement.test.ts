import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { SmartDeliveryClient } from "../clients/smartdelivery.js";
import type { MailboxHealthRow } from "../lib/mailboxHealthDaily.js";
import {
  loadSundayPlacementConfig,
  sundayPlacementGate,
  sundayPlacementScheduleError,
} from "../lib/sundayPlacement.js";
import { MailboxHealthStore } from "../state/mailboxHealthStore.js";
import { SundayPlacementService, sundaySenderPlan } from "./sundayPlacement.js";

const SUNDAY_9AM = new Date("2026-11-15T15:00:00Z"); // Sun 9:00am CST
const MONDAY_9AM = new Date("2026-11-16T15:00:00Z");
const SUNDAY_9PM = new Date("2026-11-16T03:00:00Z"); // Sun 9:00pm CST

/** Every SmartDeliveryClient method recorded, so any call at all shows up. */
function recordingSmartDelivery() {
  const calls: string[] = [];
  const fake: Record<string, unknown> = {};
  for (const name of Object.getOwnPropertyNames(SmartDeliveryClient.prototype)) {
    if (name === "constructor") continue;
    fake[name] = async (...args: unknown[]) => {
      calls.push(name);
      if (name === "resolveProviderIds") return [1, 2];
      if (name === "createManualPlacement") return { id: `t${calls.length}`, args };
      return undefined;
    };
  }
  return { fake, calls };
}

function row(email: string, over: Partial<MailboxHealthRow> = {}): MailboxHealthRow {
  return {
    date: "2026-11-14", email, domain: email.split("@")[1]!, emailAccountId: 1, esp: "GOOGLE",
    pod: "A", owner: "acme", ownerClientId: 1, sent: 30, replies: 1, bounces: 0, replyRate: 3.33,
    bounceRate: 0, warmupScore: 99, ...over,
  };
}

async function rig(env: NodeJS.ProcessEnv, now: Date, masterSwitch?: () => boolean) {
  const dir = await mkdtemp(path.join(tmpdir(), "d335-sun-"));
  const store = MailboxHealthStore.forStateFile(path.join(dir, "state.json"));
  await store.write({
    date: "2026-11-14",
    generatedAt: "x",
    rows: {
      "a@one.com": row("a@one.com"),
      "b@one.com": row("b@one.com", { sent: 80 }),
      "c@two.io": row("c@two.io", { owner: "beta" }),
    },
    trends: [{ date: "2026-11-14", email: "a@one.com", domain: "one.com", owner: "acme", pod: "A", flag: "warmup_low", detail: "" }],
  });
  const { fake, calls } = recordingSmartDelivery();
  const svc = new SundayPlacementService({
    smartDelivery: fake as never,
    store,
    config: loadSundayPlacementConfig(env),
    providerIds: [],
    masterSwitch,
    now: () => now,
  });
  return { svc, calls, fake };
}

describe("D335 Sunday-only placement path — OFF by default", () => {
  it("defaults off; only the exact string \"true\" enables", () => {
    assert.equal(loadSundayPlacementConfig({}).enabled, false);
    for (const v of ["1", "yes", "TRUE", "True", " true", "on", "false", ""]) {
      assert.equal(loadSundayPlacementConfig({ SUNDAY_PLACEMENT_TEST_ENABLED: v }).enabled, false, v);
    }
    assert.equal(loadSundayPlacementConfig({ SUNDAY_PLACEMENT_TEST_ENABLED: "true" }).enabled, true);
  });

  it("off: the cron is not registered", async () => {
    assert.match(sundayPlacementScheduleError(loadSundayPlacementConfig({}))!, /is not "true"/);
    const index = await readFile(new URL("../index.ts", import.meta.url), "utf8");
    // The only scheduleJob("sunday-placement-test" sits behind the schedule check.
    assert.equal(index.match(/scheduleJob\(\s*"sunday-placement-test"/g)?.length, 1);
    assert.match(
      index,
      /const sundayPlacementNotScheduled = sundayPlacementScheduleError\(sundayPlacementConfig\);\n  if \(!sundayPlacementNotScheduled\) \{\n    const sundayPlacement = new SundayPlacementService\(/,
    );
  });

  it("off: a run on a Sunday makes no SmartDelivery call and creates nothing", async () => {
    const r = await rig({}, SUNDAY_9AM);
    const res = await r.svc.run();
    assert.equal(res.ran, false);
    assert.deepEqual(res.created, []);
    assert.deepEqual(r.calls, []);
  });

  it("on: refuses every non-Sunday and Sunday night; still no calls", async () => {
    for (const now of [
      MONDAY_9AM,
      new Date("2026-11-17T15:00:00Z"),
      new Date("2026-11-18T15:00:00Z"),
      new Date("2026-11-19T15:00:00Z"),
      new Date("2026-11-20T15:00:00Z"),
      new Date("2026-11-21T15:00:00Z"),
    ]) {
      const r = await rig({ SUNDAY_PLACEMENT_TEST_ENABLED: "true" }, now);
      const res = await r.svc.run();
      assert.match(res.skipped.join(), /not Sunday in America\/Chicago/, now.toISOString());
      assert.deepEqual(r.calls, []);
    }
    const night = await rig({ SUNDAY_PLACEMENT_TEST_ENABLED: "true" }, SUNDAY_9PM);
    assert.match((await night.svc.run()).skipped.join(), /outside 06:00–19:59/);
    assert.deepEqual(night.calls, []);
  });

  it("on: the master kill switch (when wired) still blocks", async () => {
    const r = await rig({ SUNDAY_PLACEMENT_TEST_ENABLED: "true" }, SUNDAY_9AM, () => false);
    assert.match((await r.svc.run()).skipped.join(), /DELIVERABILITY_TESTING_ENABLED is off/);
    assert.deepEqual(r.calls, []);
  });

  it("on, Sunday daytime: one manual off-campaign test per owner, flagged first, capped", async () => {
    const r = await rig({ SUNDAY_PLACEMENT_TEST_ENABLED: "true", SUNDAY_PLACEMENT_MAX_TESTS: "1" }, SUNDAY_9AM);
    const res = await r.svc.run();
    assert.equal(res.ran, true);
    assert.deepEqual(r.calls, ["resolveProviderIds", "createManualPlacement"]);
    assert.equal(res.created.length, 1);
    assert.equal(res.created[0]!.owner, "acme");
  });

  it("schedule check: Sunday-only day field and 06–19 CT hour", () => {
    const on = (cron: string) =>
      sundayPlacementScheduleError({ ...loadSundayPlacementConfig({ SUNDAY_PLACEMENT_TEST_ENABLED: "true" }), cron });
    assert.equal(on("0 9 * * 0"), null);
    assert.match(on("0 9 * * 1")!, /Sunday only/);
    assert.match(on("0 9 * * *")!, /Sunday only/);
    assert.match(on("0 21 * * 0")!, /20:00–05:59/);
  });

  it("gate is pure and matches the service", () => {
    const cfg = loadSundayPlacementConfig({ SUNDAY_PLACEMENT_TEST_ENABLED: "true" });
    assert.equal(sundayPlacementGate(cfg, SUNDAY_9AM), null);
    assert.ok(sundayPlacementGate(cfg, MONDAY_9AM));
  });

  it("sender plan: flagged mailboxes and owners first", () => {
    const plan = sundaySenderPlan(
      [row("a@one.com"), row("b@one.com", { sent: 80 }), row("c@two.io", { owner: "beta", sent: 500 })],
      new Set(["a@one.com"]),
      5,
      20,
    );
    assert.deepEqual(plan, [
      { owner: "acme", senders: ["a@one.com", "b@one.com"] },
      { owner: "beta", senders: ["c@two.io"] },
    ]);
  });
});
