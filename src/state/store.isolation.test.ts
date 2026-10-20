import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { StateStore } from "./store.js";

describe("isolation state", () => {
  it("reloads pod controls, mailbox tags, and suppressed terms", async () => {
    const path = `/tmp/dw-iso-state-${process.pid}-${Date.now()}.json`;
    const state = new StateStore(path);
    await state.load();
    state.upsertMailboxControl({
      email: "a@client.com",
      ranAt: "2026-08-23T00:00:00.000Z",
      placement: "SPAM",
      history: ["SPAM"],
      rollingFailCount: 1,
      tag: "watch",
    });
    state.upsertSuppressedTerm({
      term: "free",
      kind: "word",
      firstSeen: "2026-08-23T00:00:00.000Z",
      timesConfirmed: 1,
      status: "confirmed",
    });
    state.markCopySuspect({
      campaignId: 7,
      campaignName: "Acme",
      at: "2026-08-23T00:00:00.000Z",
    });
    await state.save();

    const reloaded = new StateStore(path);
    await reloaded.load();
    assert.equal(reloaded.getMailboxControl("A@client.com")?.tag, "watch");
    assert.equal(reloaded.listSuppressedTerms()[0]?.term, "free");
    assert.equal(reloaded.listCopySuspects()[0]?.campaignId, 7);
  });

  it("reloads the dedicated canary fleet", async () => {
    const path = `/tmp/dw-iso-canary-${process.pid}-${Date.now()}.json`;
    const state = new StateStore(path);
    await state.load();
    state.setCopyCanaryFleet({
      status: "ready",
      googleDomain: "canary-g.info",
      microsoftDomain: "canary-o.info",
      domains: ["canary-g.info", "canary-o.info"],
      emails: ["a@canary-g.info", "b@canary-o.info"],
      updatedAt: "2026-08-23T00:00:00.000Z",
    });
    await state.save();
    const reloaded = new StateStore(path);
    await reloaded.load();
    assert.equal(reloaded.getCopyCanaryFleet()?.status, "ready");
    assert.equal(reloaded.isCopyCanary("A@canary-g.info"), true);
    assert.equal(reloaded.isCopyCanary("other@pool.info"), false);
  });

  it("D261: prunes placement scores and suspects for deleted or finished campaigns", async () => {
    const path = `/tmp/dw-iso-prune-${process.pid}-${Date.now()}.json`;
    const state = new StateStore(path);
    await state.load();
    state.recordPlacementScore({
      campaignId: 3739316,
      campaignName: "Cold Call Followup",
      testId: "547425",
      source: "canary-copy",
      inboxPercent: 0,
      at: "2026-10-08T00:00:00.000Z",
    });
    state.recordPlacementScore({
      campaignId: 3847794,
      campaignName: "TechEvo SFL Startup Owners AirPods",
      testId: "544718",
      source: "canary-copy",
      inboxPercent: 0,
      at: "2026-10-13T14:00:00.000Z",
    });
    state.markCopySuspect({
      campaignId: 3739316,
      campaignName: "Cold Call Followup",
      at: "2026-10-08T00:00:00.000Z",
    });
    state.markCopySuspect({
      campaignId: 3763805,
      campaignName: "BCP Logistics Over-1k",
      at: "2026-08-24T12:00:00.000Z",
    });
    state.setCopyCanaries(3739316, ["canary@g.test"], "547425");
    const dropped = state.pruneIsolationForGoneCampaigns([
      { id: 3847794, status: "ACTIVE" },
      { id: 3763805, status: "COMPLETED" },
      { id: 3705889, status: "PAUSED" },
    ]);
    assert.ok(dropped >= 2);
    assert.equal(
      state.listPlacementScores().some((row) => row.campaignId === 3739316),
      false,
      "deleted Cold Call Followup must not stay on the hole list",
    );
    assert.equal(
      state.listCopySuspects().some((row) => row.campaignId === 3739316),
      false,
    );
    assert.equal(
      state.listCopySuspects().some((row) => row.campaignId === 3763805),
      false,
      "COMPLETED leftover suspects are pruned",
    );
    assert.ok(
      state.listPlacementScores().some((row) => row.campaignId === 3847794),
    );
    assert.equal(
      state.getCopyCanaryTestId(3739316),
      undefined,
      "D262: deleted campaigns drop their copy-canary row",
    );
  });

  it("D267: prune persists via the sidecar even when the full dump is stale", async () => {
    const path = `/tmp/dw-iso-prune-hot-${process.pid}-${Date.now()}.json`;
    const stale = new StateStore(path);
    await stale.load();
    stale.recordPlacementScore({
      campaignId: 3739316,
      campaignName: "Cold Call Followup",
      testId: "547425",
      source: "canary-copy",
      inboxPercent: 0,
      at: "2026-10-08T00:00:00.000Z",
    });
    stale.recordPlacementScore({
      campaignId: 3847794,
      campaignName: "TechEvo SFL Startup Owners AirPods",
      testId: "544718",
      source: "canary-copy",
      inboxPercent: 0,
      at: "2026-10-13T14:00:00.000Z",
    });
    stale.markCopySuspect({
      campaignId: 3739316,
      campaignName: "Cold Call Followup",
      at: "2026-10-08T00:00:00.000Z",
    });
    stale.setCopyCanaries(3739316, ["canary@g.test"], "547425");
    await stale.save();

    const live = new StateStore(path);
    await live.load();
    const dropped = live.pruneIsolationForGoneCampaigns([
      { id: 3847794, status: "ACTIVE" },
    ]);
    assert.ok(dropped >= 2);
    await live.persistIsolationPrune();

    const reloaded = new StateStore(path);
    await reloaded.load();
    assert.equal(
      reloaded.listPlacementScores().some((row) => row.campaignId === 3739316),
      false,
      "stale dump must not resurrect deleted #3739316 after sidecar prune",
    );
    assert.equal(
      reloaded.listCopySuspects().some((row) => row.campaignId === 3739316),
      false,
    );
    assert.equal(reloaded.getCopyCanaryTestId(3739316), undefined);
    assert.ok(
      reloaded.listPlacementScores().some((row) => row.campaignId === 3847794),
      "living scores stay",
    );
  });

  it("D288: saveHot sidecar never embeds isolation maps", async () => {
    const path = `/tmp/dw-iso-hot-slim-${process.pid}-${Date.now()}.json`;
    const state = new StateStore(path);
    await state.load();
    for (let i = 0; i < 80; i += 1) {
      state.recordPlacementScore({
        campaignId: 4000000 + i,
        campaignName: `Fat score ${i}`,
        testId: `t-${i}`,
        source: "canary-copy",
        inboxPercent: 0,
        at: "2026-10-19T00:00:00.000Z",
        raw: "x".repeat(20_000),
      } as never);
      state.markCopySuspect({
        campaignId: 4000000 + i,
        campaignName: `Fat score ${i}`,
        at: "2026-10-19T00:00:00.000Z",
      });
      state.setCopyCanaries(4000000 + i, [`canary${i}@g.test`], `t-${i}`);
    }
    state.pruneIsolationForGoneCampaigns([{ id: 1, status: "ACTIVE" }]);
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 1);
    timer.unref?.();
    const t0 = Date.now();
    await state.saveHot();
    const wall = Date.now() - t0;
    clearInterval(timer);
    const sidecar = JSON.parse(
      await readFile(state.stampsFilePath(), "utf8"),
    ) as {
      isolationPrune?: Record<string, unknown>;
    };
    assert.equal(
      sidecar.isolationPrune?.placementScores,
      undefined,
      "sidecar must not stringify placementScores",
    );
    assert.equal(sidecar.isolationPrune?.copySuspects, undefined);
    assert.equal(sidecar.isolationPrune?.copyCanaries, undefined);
    assert.ok(Array.isArray(sidecar.isolationPrune?.goneIds));
    assert.ok(wall < 2_000, `saveHot of fat isolation maps took ${wall}ms`);
    assert.ok(ticks >= 0);
  });

  it("D294: sidecar decide receipts upgrade a pending action after freeze-kill", async () => {
    const path = `/tmp/dw-iso-decide-${process.pid}-${Date.now()}.json`;
    const live = new StateStore(path);
    await live.load();
    live.upsertIsolationAction({
      id: "retire_domain-tap-1",
      kind: "retire_domain",
      status: "pending",
      title: "Retire leftover.info",
      proof: "proof",
      detail: { domain: "leftover.info" },
      allowed: "owner_or_operator",
      requestedAt: "2026-10-20T12:00:00.000Z",
    });
    await live.save();
    live.upsertIsolationAction({
      ...live.getIsolationAction("retire_domain-tap-1")!,
      status: "approved",
      decidedAt: "2026-10-20T12:01:00.000Z",
      decidedBy: "Cayden",
    });
    await live.persistIsolationDecisions();

    const reloaded = new StateStore(path);
    await reloaded.load();
    const row = reloaded.getIsolationAction("retire_domain-tap-1");
    assert.equal(row?.status, "approved");
    assert.equal(row?.decidedBy, "Cayden");
    const sidecar = JSON.parse(await readFile(reloaded.stampsFilePath(), "utf8")) as {
      isolationDecisions?: { receipts?: Array<{ id: string }> };
    };
    assert.ok(
      sidecar.isolationDecisions?.receipts?.some((r) => r.id === "retire_domain-tap-1"),
    );
  });

  it("D294: a second save() and saveHot() after the first actually write", async () => {
    const path = `/tmp/dw-iso-save2-${process.pid}-${Date.now()}.json`;
    const live = new StateStore(path);
    await live.load();
    live.upsertIsolationAction({
      id: "retire_domain-first",
      kind: "retire_domain",
      status: "pending",
      title: "first",
      proof: "proof",
      detail: { domain: "first.info" },
      allowed: "owner_or_operator",
      requestedAt: "2026-10-20T12:00:00.000Z",
    });
    await live.save();
    live.upsertIsolationAction({
      id: "retire_domain-second",
      kind: "retire_domain",
      status: "pending",
      title: "second",
      proof: "proof",
      detail: { domain: "second.info" },
      allowed: "owner_or_operator",
      requestedAt: "2026-10-20T12:01:00.000Z",
    });
    await live.save();
    const afterSecond = new StateStore(path);
    await afterSecond.load();
    assert.ok(afterSecond.getIsolationAction("retire_domain-second"));
  });
});
