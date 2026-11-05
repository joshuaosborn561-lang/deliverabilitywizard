import assert from "node:assert/strict";
import test from "node:test";
import {
  CanonQaService,
  canonQaQueueItem,
  evaluateCanonQa,
  type CanonQaQueueItem,
  type CanonQaSnapshot,
} from "./canonQa.js";

const input = (over: Partial<Parameters<typeof evaluateCanonQa>[0]> = {}) => ({
  at: "2026-10-31T22:00:00.000Z",
  findings: { missing_canary: 85, esp_mix: 18 },
  overdueStages: [] as string[],
  canaryFleetDown: false,
  ...over,
});

test("first look seeds a baseline and reports nothing", () => {
  const r = evaluateCanonQa(input(), null);
  assert.equal(r.seeded, true);
  assert.deepEqual(r.newlyBroken, []);
  assert.equal(canonQaQueueItem(r, "abc"), null);
});

test("unchanged or shrinking findings are silent", () => {
  const prev = evaluateCanonQa(input(), null).snapshot;
  const same = evaluateCanonQa(input({ at: "2026-10-31T22:15:00.000Z" }), prev);
  assert.deepEqual(same.newlyBroken, []);
  assert.equal(canonQaQueueItem(same, "abc"), null);
  const less = evaluateCanonQa(input({ findings: { missing_canary: 80, esp_mix: 18 } }), prev);
  assert.deepEqual(less.newlyBroken, []);
  assert.deepEqual(less.cleared, ["finding missing_canary 85 -> 80"]);
});

test("a rise, a new kind, a new overdue stage and fleet down are newly broken", () => {
  const prev = evaluateCanonQa(input(), null).snapshot;
  const r = evaluateCanonQa(
    input({
      findings: { missing_canary: 86, esp_mix: 18, merge_tag_blank: 1 },
      overdueStages: ["isolation-branch"],
      canaryFleetDown: true,
    }),
    prev,
  );
  assert.deepEqual(r.newlyBroken, [
    "finding merge_tag_blank 0 -> 1",
    "finding missing_canary 85 -> 86",
    "stage isolation-branch overdue",
    "canary fleet down",
  ]);
  const item = canonQaQueueItem(r, "deadbeef");
  assert.ok(item);
  assert.equal(item.kind, "canon_qa");
  assert.equal(item.dedupeKey, "canon-qa:2026-10-31T22:00:00.000Z");
  assert.deepEqual((item.payload as { newly_broken: string[] }).newly_broken.length, 4);
});

test("an already-overdue stage does not re-page", () => {
  const prev = evaluateCanonQa(input({ overdueStages: ["lead-runout"] }), null).snapshot;
  const r = evaluateCanonQa(input({ overdueStages: ["lead-runout"] }), prev);
  assert.deepEqual(r.newlyBroken, []);
});

test("service queues once, saves the new baseline, and keeps the old one when the queue write fails", async () => {
  let saved: CanonQaSnapshot | null = evaluateCanonQa(input(), null).snapshot;
  const items: CanonQaQueueItem[] = [];
  let fail = false;
  const svc = new CanonQaService({
    load: () => saved,
    save: (s) => { saved = s; },
    sink: { enqueue: async (i) => { if (fail) throw new Error("db down"); items.push(i); return true; } },
    deploySha: () => "abc",
    log: () => {},
  });
  const bad = input({ findings: { missing_canary: 90, esp_mix: 18 } });
  fail = true;
  const r1 = await svc.run(bad);
  assert.equal(r1.queued, false);
  assert.equal(saved?.findings.missing_canary, 85, "baseline kept so it retries");
  fail = false;
  const r2 = await svc.run(bad);
  assert.equal(r2.queued, true);
  assert.equal(items.length, 1);
  assert.equal(saved?.findings.missing_canary, 90);
  const r3 = await svc.run(bad);
  assert.equal(r3.newlyBroken, 0);
  assert.equal(items.length, 1, "no repeat");
});

test("no sink configured logs only and still advances the baseline", async () => {
  let saved: CanonQaSnapshot | null = evaluateCanonQa(input(), null).snapshot;
  const lines: string[] = [];
  const svc = new CanonQaService({ load: () => saved, save: (s) => { saved = s; }, sink: null, deploySha: () => null, log: (l) => lines.push(l) });
  const r = await svc.run(input({ findings: { missing_canary: 99, esp_mix: 18 } }));
  assert.equal(r.queued, false);
  assert.ok(lines.some((l) => /no queue configured/.test(l)));
  assert.equal(saved?.findings.missing_canary, 99);
});
