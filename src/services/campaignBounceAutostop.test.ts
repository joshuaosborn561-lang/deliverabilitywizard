import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { loadConfig } from "../config.js";
import { StateStore } from "../state/store.js";
import {
  CampaignBounceAutostopService,
  pausedByBounceProtection,
} from "./campaignBounceAutostop.js";

function store(): StateStore {
  return new StateStore(
    `/tmp/dw-bounce-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`,
  );
}

describe("pausedByBounceProtection (D157)", () => {
  it("matches the live LIST shape — a single activity-log object", () => {
    assert.equal(
      pausedByBounceProtection({
        id: 3763809,
        name: "BCP PE Firms (No Team)",
        status: "PAUSED",
        campaign_activity_logs: {
          pause_time: "2026-09-04T18:55:08.257Z",
          paused_reason: "bounce protection",
        },
      }),
      true,
      "object-shaped logs must attribute Smartlead bounce protection",
    );
  });

  it("still matches an array of log rows (fixtures)", () => {
    assert.equal(
      pausedByBounceProtection({
        id: 1,
        name: "x",
        status: "PAUSED",
        campaign_activity_logs: [{ paused_reason: "bounce protection" }],
      }),
      true,
    );
  });

  it("is false when there is no bounce-protection reason", () => {
    assert.equal(
      pausedByBounceProtection({
        id: 1,
        name: "x",
        status: "PAUSED",
        campaign_activity_logs: { paused_reason: "manual" },
      }),
      false,
    );
    assert.equal(
      pausedByBounceProtection({ id: 1, name: "x", status: "PAUSED" }),
      false,
    );
  });
});

describe("CampaignBounceAutostopService (D141/D148)", () => {
  it("the lifetime rate never trips — bad-looking rates are artifacts, not storms", async () => {
    const paused: number[] = [];
    const started: number[] = [];
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
      } as never,
      store(),
    );

    const result = await service.run({ dryRun: false });
    assert.deepEqual(
      result.bursts,
      [],
      "a lifetime rate — even 10.1% after 1k — is not a burst (D141)",
    );
    assert.deepEqual(paused, []);
    assert.deepEqual(started, []);
  });

  it("D148: a real burst is investigated and receipted — the campaign keeps running", async () => {
    const statusWrites: string[] = [];
    const sent: string[] = [];
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
        updateCampaignStatus: async (_id: number, status: string) => {
          statusWrites.push(status);
        },
        getCampaignSettings: async () => ({ bounce_autopause_threshold: "100" }),
        updateCampaignSettings: async () => undefined,
        listBouncedSendStats: async () => ({
          total_stats: "2",
          data: [
            { lead_email: "a@x.com", sent_time: new Date(Date.now() - 30 * 60 * 1000).toISOString() },
            { lead_email: "b@x.com", sent_time: new Date(Date.now() - 45 * 60 * 1000).toISOString() },
          ],
        }),
      } as never,
      state,
      { send: async (text: string) => void sent.push(text) } as never,
    );

    const result = await service.run({ dryRun: false });
    assert.deepEqual(statusWrites, [], "nothing pauses anymore (D148)");
    assert.equal(result.bursts[0]?.reason, "burst");
    assert.equal(result.bursts[0]?.burstBounces, 12);
    assert.equal(sent.length, 1, "the burst itself is receipted");
    assert.match(sent[0]!, /Bounce burst on Burst/);
    assert.match(
      sent[0]!,
      /unreadable this tick/,
      "no readable NDRs here — the receipt says the loop keeps sampling",
    );
    assert.equal(
      state.getBounceResurrectionJob(8),
      undefined,
      "an unreadable verdict opens no incident",
    );
  });

  it("D141: a ledger dump of stale bounces never acts — logged and consumed", async () => {
    const statusWrites: string[] = [];
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
          { id: 8, name: "Backlog lands", status: "ACTIVE" },
        ],
        getCampaignAnalyticsByDate: async () => ({
          sent_count: 641,
          bounce_count: 15,
        }),
        getCampaignStatistics: async () => ({}),
        updateCampaignStatus: async (_id: number, status: string) => {
          statusWrites.push(status);
        },
        getCampaignSettings: async () => ({ bounce_autopause_threshold: "100" }),
        updateCampaignSettings: async () => undefined,
        // The 2026-08-27 shape: sends days old, batch-recorded tonight.
        listBouncedSendStats: async () => ({
          total_stats: "12",
          data: [
            { lead_email: "a@x.com", sent_time: "2026-08-13T14:05:53.775Z" },
            { lead_email: "b@x.com", sent_time: "2026-08-20T16:34:22.414Z" },
          ],
        }),
      } as never,
      state,
    );

    const result = await service.run({ dryRun: false });
    assert.deepEqual(statusWrites, [], "stale-send bounces are residue, not a storm");
    assert.deepEqual(result.bursts, []);
    assert.equal(result.ledgerDumps, 1);
    assert.equal(
      state.getBounceSnapshot(8)?.bounced,
      15,
      "the dump's delta is consumed so it cannot re-trip forever",
    );
  });

  it("D141: unreadable bounced rows defer the decision — snapshot kept for the next tick", async () => {
    const state = store();
    const staleAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    state.setBounceSnapshot(8, { bounced: 3, sent: 40, at: staleAt });
    const service = new CampaignBounceAutostopService(
      loadConfig({ DRY_RUN: "false" }),
      {
        listCampaigns: async () => [
          { id: 8, name: "Ledger lagging", status: "ACTIVE" },
        ],
        getCampaignAnalyticsByDate: async () => ({
          sent_count: 55,
          bounce_count: 15,
        }),
        getCampaignStatistics: async () => ({}),
        updateCampaignStatus: async () => undefined,
        getCampaignSettings: async () => ({ bounce_autopause_threshold: "100" }),
        updateCampaignSettings: async () => undefined,
        listBouncedSendStats: async () => ({ total_stats: "0", data: [] }),
      } as never,
      state,
    );

    const result = await service.run({ dryRun: false });
    assert.deepEqual(result.bursts, [], "no action on unverifiable data");
    assert.equal(result.ledgerDumps, 0);
    assert.equal(
      state.getBounceSnapshot(8)?.bounced,
      3,
      "snapshot not consumed — the burst re-evaluates next tick",
    );
  });

  it("does not trip on the first snapshot or on exactly 10 new bounces", async () => {
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
        updateCampaignStatus: async () => undefined,
        getCampaignSettings: async () => ({ bounce_autopause_threshold: "100" }),
        updateCampaignSettings: async () => undefined,
      } as never,
      state,
    );

    const first = await service.run({ dryRun: false });
    assert.deepEqual(first.bursts, []);
    assert.ok(state.getBounceSnapshot(8));

    state.setBounceSnapshot(8, {
      bounced: 2,
      sent: 30,
      at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });
    const second = await service.run({ dryRun: false });
    assert.deepEqual(second.bursts, [], "exactly 10 new bounces must not trip");
  });

  it("never writes a campaign status — no START (D40), no PAUSE (D148) — and no settings (D157)", async () => {
    const src = await readFile(
      new URL("./campaignBounceAutostop.ts", import.meta.url),
      "utf8",
    );
    assert.equal(/updateCampaignStatus\([^)]*START/.test(src), false);
    assert.equal(/updateCampaignStatus\([^)]*PAUSED/.test(src), false);
    assert.equal(/hasPendingResume|markPendingResume|clearPendingResume/.test(src), false);
    // D157 — bounce_autopause_threshold is handler-discarded on the API;
    // the loop attempts no settings write of any kind.
    assert.equal(/updateCampaignSettings|getCampaignSettings/.test(src), false);
  });

});

describe("D140/D148 — a burst reads the SMTP reasons and opens the incident", () => {
  const NDR =
    "<html>Delivery has failed to these recipients. Remote server returned '550 5.7.233 - Your message can't be sent because your tenant has exceeded its daily limit for sending email to external recipients (tenant external recipient rate limit).'</html>";
  // Mid-day UTC so the tenant gate is deterministically shut during the run.
  const FIXED_T = Date.parse("2026-08-27T15:00:00.000Z");

  const mkSl = (statusWrites: string[]) =>
    ({
      listCampaigns: async () => [{ id: 8, name: "Burst", status: "ACTIVE" }],
      getCampaignAnalyticsByDate: async () => ({
        sent_count: 55,
        bounce_count: 15,
      }),
      getCampaignStatistics: async () => ({}),
      updateCampaignStatus: async (_id: number, status: string) => {
        statusWrites.push(status);
      },
      getCampaignSettings: async () => ({ bounce_autopause_threshold: "100" }),
      updateCampaignSettings: async () => undefined,
      listBouncedSendStats: async () => ({
        total_stats: "2",
        data: [
          {
            lead_email: "a@target.com",
            sent_time: new Date(FIXED_T - 20 * 60 * 1000).toISOString(),
          },
          {
            lead_email: "b@target.com",
            sent_time: new Date(FIXED_T - 25 * 60 * 1000).toISOString(),
          },
        ],
      }),
      fetchLeadByEmail: async (email: string) => ({
        id: email === "a@target.com" ? 111 : 222,
      }),
      getLeadMessageHistory: async () => ({
        history: [
          { type: "SENT", from: "sender@cleartechco.com" },
          { type: "REPLY", email_body: NDR },
        ],
      }),
      fetchCampaignSequences: async () => [],
      deleteCampaignLead: async () => undefined,
      restoreCampaignLead: async () => undefined,
    }) as never;

  it("classifies a tenant-cap burst, pages once, opens the incident; the re-trip folds silently", async () => {
    const statusWrites: string[] = [];
    const sent: string[] = [];
    const state = store();
    state.setBounceSnapshot(8, {
      bounced: 3,
      sent: 40,
      at: new Date(FIXED_T - 10 * 60 * 1000).toISOString(),
    });
    const service = new CampaignBounceAutostopService(
      loadConfig({ DRY_RUN: "false" }),
      mkSl(statusWrites),
      state,
      { send: async (text: string) => void sent.push(text) } as never,
      undefined,
      () => FIXED_T,
    );
    const result = await service.run({ dryRun: false });
    assert.deepEqual(statusWrites, [], "no pause (D148)");
    const verdict = result.bursts[0]?.verdict;
    assert.equal(verdict?.dominant, "tenant_rate_limit");
    assert.deepEqual(verdict?.senderDomains, ["cleartechco.com"]);
    assert.equal(state.getBounceVerdict(8)?.dominant, "tenant_rate_limit");
    assert.equal(
      sent.filter((text) => /hit its Microsoft daily sending cap/.test(text)).length,
      1,
      "one tenant page",
    );
    assert.equal(
      sent.filter((text) => /Bounce burst on Burst/.test(text)).length,
      1,
      "one burst receipt naming the plan",
    );
    const job = state.getBounceResurrectionJob(8);
    assert.ok(job, "a sender-fault burst opens the resurrection incident (D148)");

    // Same wave still burning ten minutes later: everything folds into the
    // open incident — no second receipt, no second classification pass.
    const sentBefore = sent.length;
    state.setBounceSnapshot(8, {
      bounced: 3,
      sent: 40,
      at: new Date(FIXED_T - 10 * 60 * 1000).toISOString(),
    });
    const again = new CampaignBounceAutostopService(
      loadConfig({ DRY_RUN: "false" }),
      mkSl(statusWrites),
      state,
      { send: async (text: string) => void sent.push(text) } as never,
      undefined,
      () => FIXED_T,
    );
    const second = await again.run({ dryRun: false });
    assert.deepEqual(statusWrites, []);
    assert.deepEqual(second.bursts, [], "the re-trip folded into the open incident");
    assert.equal(sent.length, sentBefore, "no repeat Slack inside the hour");
    const foldedJob = state.getBounceResurrectionJob(8);
    assert.ok(
      Date.parse(foldedJob!.windowEnd) >= Date.parse(job!.windowEnd),
      "the incident window widened to cover the new bounces",
    );
  });

  it("D145/D146: one 5.1.8 sample opens the burned-domain retire ask even under a tenant-cap wave", async () => {
    // The real 8/27 shape: tenant caps dominate the samples, one sender
    // is spam-blocked. Dominant-gated alerting would have stayed silent.
    const TENANT_NDR =
      "<html>Delivery has failed. Remote server returned '550 5.7.233 - Your message can't be sent because your tenant has exceeded its daily limit for sending email to external recipients (tenant external recipient rate limit).'</html>";
    const BLOCKED_NDR =
      "<html>Delivery has failed. Remote server returned '550 5.1.8 Access denied, bad outbound sender AS(42004)'</html>";
    const mkBlockedSl = (statusWrites: string[]) =>
      ({
        listCampaigns: async () => [{ id: 9, name: "Engagers", status: "ACTIVE" }],
        getCampaignAnalyticsByDate: async () => ({
          sent_count: 60,
          bounce_count: 18,
        }),
        getCampaignStatistics: async () => ({}),
        updateCampaignStatus: async (_id: number, status: string) => {
          statusWrites.push(status);
        },
        getCampaignSettings: async () => ({ bounce_autopause_threshold: "100" }),
        updateCampaignSettings: async () => undefined,
        listBouncedSendStats: async () => ({
          total_stats: "2",
          data: [
            {
              lead_email: "a@target.com",
              sent_time: new Date(FIXED_T - 20 * 60 * 1000).toISOString(),
            },
            {
              lead_email: "b@target.com",
              sent_time: new Date(FIXED_T - 25 * 60 * 1000).toISOString(),
            },
          ],
        }),
        fetchLeadByEmail: async (email: string) => ({
          id: email === "a@target.com" ? 111 : 222,
        }),
        getLeadMessageHistory: async (leadId: number) => ({
          history:
            leadId === 111
              ? [
                  { type: "SENT", from: "ok@salesgliderset.info" },
                  { type: "REPLY", email_body: TENANT_NDR },
                ]
              : [
                  { type: "SENT", from: "flagged@salesgliderrun.com" },
                  { type: "REPLY", email_body: BLOCKED_NDR },
                ],
        }),
        fetchCampaignSequences: async () => [],
        deleteCampaignLead: async () => undefined,
        restoreCampaignLead: async () => undefined,
      }) as never;

    const statusWrites: string[] = [];
    const sent: string[] = [];
    const asks: Array<{ title: string; proof: string; kind: string }> = [];
    const slackFake = {
      send: async (text: string) => void sent.push(text),
      notifyIsolationAction: async (ask: {
        title: string;
        proof: string;
        kind: string;
      }) => void asks.push(ask),
    } as never;
    const state = store();
    state.setBounceSnapshot(9, {
      bounced: 3,
      sent: 40,
      at: new Date(FIXED_T - 10 * 60 * 1000).toISOString(),
    });
    const service = new CampaignBounceAutostopService(
      loadConfig({ DRY_RUN: "false" }),
      mkBlockedSl(statusWrites),
      state,
      slackFake,
      undefined,
      () => FIXED_T,
    );
    await service.run({ dryRun: false });
    assert.deepEqual(statusWrites, [], "no pause (D148)");
    // D146 — the block feeds the burned-domain flow, not a plain page.
    assert.equal(asks.length, 1, "one retire ask for the blocked domain");
    assert.equal(asks[0]!.kind, "retire_domain");
    assert.match(asks[0]!.title, /salesgliderrun\.com/);
    assert.match(asks[0]!.proof, /5\.1\.8/);
    assert.match(asks[0]!.proof, /flagged@salesgliderrun\.com/);
    const pending = state
      .listIsolationActions()
      .filter(
        (row) =>
          row.kind === "retire_domain" &&
          row.detail.domain === "salesgliderrun.com",
      );
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.status, "pending");
    assert.ok(
      state.getBounceResurrectionJob(9),
      "the mixed-class incident opens too — the 5.1.8 lead waits on the ask",
    );

    // the same wave ten minutes later folds — the pending ask holds alone
    const statusWrites2: string[] = [];
    state.setBounceSnapshot(9, {
      bounced: 3,
      sent: 40,
      at: new Date(FIXED_T - 10 * 60 * 1000).toISOString(),
    });
    const again = new CampaignBounceAutostopService(
      loadConfig({ DRY_RUN: "false" }),
      mkBlockedSl(statusWrites2),
      state,
      slackFake,
      undefined,
      () => FIXED_T,
    );
    await again.run({ dryRun: false });
    assert.deepEqual(statusWrites2, []);
    assert.equal(asks.length, 1, "the pending ask dedupes the re-ask");
    assert.equal(
      state
        .listIsolationActions()
        .filter((row) => row.kind === "retire_domain").length,
      1,
    );

    // Josh executes the retire. Stale pre-retire sends keep bouncing into
    // the ledger — a burst an hour later (cooldown expired, full classify)
    // must NOT re-ask for the already-retired domain.
    const executedAsk = state
      .listIsolationActions()
      .find((row) => row.kind === "retire_domain")!;
    state.upsertIsolationAction({
      ...executedAsk,
      status: "executed",
      executedAt: new Date(FIXED_T).toISOString(),
    });
    const LATER = FIXED_T + 61 * 60 * 1000;
    state.setBounceSnapshot(9, {
      bounced: 3,
      sent: 40,
      at: new Date(LATER - 10 * 60 * 1000).toISOString(),
    });
    const statusWrites3: string[] = [];
    const third = new CampaignBounceAutostopService(
      loadConfig({ DRY_RUN: "false" }),
      mkBlockedSl(statusWrites3),
      state,
      slackFake,
      undefined,
      () => LATER,
    );
    await third.run({ dryRun: false });
    assert.deepEqual(statusWrites3, []);
    assert.equal(
      asks.length,
      1,
      "a freshly retired domain is never re-asked (D146/D148 refinement)",
    );
    assert.equal(
      state
        .listIsolationActions()
        .filter((row) => row.kind === "retire_domain").length,
      1,
      "no second retire_domain record either",
    );
  });

  it("D158: dominant content_block queues isolation (never pauses)", async () => {
    const CONTENT_NDR =
      "<html>Delivery has failed. Remote server returned '554 5.7.1 Content rejected — message blocked for policy reasons.'</html>";
    const queued: number[] = [];
    const statusWrites: string[] = [];
    const state = store();
    state.setBounceSnapshot(3847794, {
      bounced: 3,
      sent: 40,
      at: new Date(FIXED_T - 10 * 60 * 1000).toISOString(),
    });
    const service = new CampaignBounceAutostopService(
      loadConfig({ DRY_RUN: "false" }),
      {
        listCampaigns: async () => [
          { id: 3847794, name: "TechEvo SFL Startup Owners AirPods", status: "ACTIVE" },
        ],
        getCampaignAnalyticsByDate: async () => ({
          sent_count: 55,
          bounce_count: 15,
        }),
        getCampaignStatistics: async () => ({}),
        updateCampaignStatus: async (_id: number, status: string) => {
          statusWrites.push(status);
        },
        listBouncedSendStats: async () => ({
          total_stats: "2",
          data: [
            {
              lead_email: "a@target.com",
              sent_time: new Date(FIXED_T - 20 * 60 * 1000).toISOString(),
            },
            {
              lead_email: "b@target.com",
              sent_time: new Date(FIXED_T - 25 * 60 * 1000).toISOString(),
            },
          ],
        }),
        fetchLeadByEmail: async (email: string) => ({
          id: email === "a@target.com" ? 111 : 222,
        }),
        getLeadMessageHistory: async () => ({
          history: [
            { type: "SENT", from: "ok@techevolutiongrp.info" },
            { type: "REPLY", email_body: CONTENT_NDR },
          ],
        }),
        fetchCampaignSequences: async () => [],
        deleteCampaignLead: async () => undefined,
        restoreCampaignLead: async () => undefined,
      } as never,
      state,
      { send: async () => undefined } as never,
      undefined,
      () => FIXED_T,
    );
    service.setIsolationBranch({
      queueContentBlockSuspect: async (campaignId: number) => {
        queued.push(campaignId);
      },
    });
    const result = await service.run({ dryRun: false });
    assert.deepEqual(statusWrites, [], "no pause (D148)");
    assert.equal(result.bursts[0]?.verdict?.dominant, "content_block");
    assert.deepEqual(queued, [3847794]);
  });
});

describe("D162 — 5.1.8 opens the retire ask without a burst", () => {
  const BLOCKED_NDR =
    "<html>Delivery has failed. Remote server returned '550 5.1.8 Access denied, bad outbound sender AS(42004)'</html>";
  const TENANT_NDR =
    "<html>Delivery has failed. Remote server returned '550 5.7.233 - Your message can't be sent because your tenant has exceeded its daily limit for sending email to external recipients (tenant external recipient rate limit).'</html>";
  const INVALID_NDR =
    "<html>Delivery has failed. Remote server returned '550 5.1.1 The email account that you tried to reach does not exist.'</html>";
  const FIXED_T = Date.parse("2026-08-31T20:00:00.000Z");

  function slackRecorder() {
    const sent: string[] = [];
    const asks: Array<{ title: string; proof: string; kind: string }> = [];
    return {
      sent,
      asks,
      slack: {
        send: async (text: string) => void sent.push(text),
        notifyIsolationAction: async (ask: {
          title: string;
          proof: string;
          kind: string;
        }) => void asks.push(ask),
      } as never,
    };
  }

  it("a 5.1.8 sample on a PAUSED campaign opens the burned-domain retire ask", async () => {
    const statusWrites: string[] = [];
    const { sent, asks, slack } = slackRecorder();
    const state = store();
    const service = new CampaignBounceAutostopService(
      loadConfig({ DRY_RUN: "false" }),
      {
        listCampaigns: async () => [
          {
            id: 42,
            name: "BCP Engagers",
            status: "PAUSED",
            campaign_activity_logs: {
              paused_reason: "bounce protection",
              pause_time: "2026-09-04T18:55:08.257Z",
            },
          },
        ],
        getCampaignAnalyticsByDate: async () => ({
          sent_count: 80,
          bounce_count: 4,
        }),
        getCampaignStatistics: async () => ({}),
        updateCampaignStatus: async (_id: number, status: string) => {
          statusWrites.push(status);
        },
        listBouncedSendStats: async () => ({
          total_stats: "1",
          data: [
            {
              lead_email: "prospect@example.com",
              sent_time: new Date(FIXED_T - 2 * 60 * 60 * 1000).toISOString(),
              lead_category: "Sender Originated Bounce",
            },
          ],
        }),
        fetchLeadByEmail: async () => ({ id: 991 }),
        getLeadMessageHistory: async () => ({
          history: [
            { type: "SENT", from: "caseykassulke@boldercyperpartnerpro.info" },
            { type: "REPLY", email_body: BLOCKED_NDR },
          ],
        }),
        fetchCampaignSequences: async () => [],
        deleteCampaignLead: async () => undefined,
        restoreCampaignLead: async () => undefined,
      } as never,
      state,
      slack,
      undefined,
      () => FIXED_T,
    );

    const result = await service.run({ dryRun: false });
    assert.deepEqual(statusWrites, [], "never START/STOP/pause from this path (D40/D148)");
    assert.deepEqual(result.bursts, [], "a paused campaign is not a burst hunt (D91/D162)");
    assert.equal(result.senderBlockAsks, 1);
    assert.equal(asks.length, 1, "one retire ask for the blocked domain");
    assert.equal(asks[0]!.kind, "retire_domain");
    assert.match(asks[0]!.title, /boldercyperpartnerpro\.info/);
    assert.match(asks[0]!.proof, /5\.1\.8/);
    assert.match(asks[0]!.proof, /caseykassulke@boldercyperpartnerpro\.info/);
    assert.equal(
      sent.filter((text) => /Bounce burst/.test(text)).length,
      0,
      "no burst receipt — this is not a D141 trip",
    );
    const pending = state
      .listIsolationActions()
      .filter(
        (row) =>
          row.kind === "retire_domain" &&
          row.detail.domain === "boldercyperpartnerpro.info",
      );
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.status, "pending");

    const again = new CampaignBounceAutostopService(
      loadConfig({ DRY_RUN: "false" }),
      {
        listCampaigns: async () => [
          {
            id: 42,
            name: "BCP Engagers",
            status: "PAUSED",
            campaign_activity_logs: {
              paused_reason: "bounce protection",
              pause_time: "2026-09-04T18:55:08.257Z",
            },
          },
        ],
        getCampaignAnalyticsByDate: async () => ({
          sent_count: 80,
          bounce_count: 4,
        }),
        getCampaignStatistics: async () => ({}),
        updateCampaignStatus: async (_id: number, status: string) => {
          statusWrites.push(status);
        },
        listBouncedSendStats: async () => ({
          total_stats: "1",
          data: [
            {
              lead_email: "prospect@example.com",
              sent_time: new Date(FIXED_T - 2 * 60 * 60 * 1000).toISOString(),
              lead_category: "Sender Originated Bounce",
            },
          ],
        }),
        fetchLeadByEmail: async () => ({ id: 991 }),
        getLeadMessageHistory: async () => ({
          history: [
            { type: "SENT", from: "caseykassulke@boldercyperpartnerpro.info" },
            { type: "REPLY", email_body: BLOCKED_NDR },
          ],
        }),
        fetchCampaignSequences: async () => [],
        deleteCampaignLead: async () => undefined,
        restoreCampaignLead: async () => undefined,
      } as never,
      state,
      slack,
      undefined,
      () => FIXED_T,
    );
    const second = await again.run({ dryRun: false });
    assert.deepEqual(statusWrites, []);
    assert.equal(second.senderBlockAsks, 0);
    assert.equal(asks.length, 1, "one pending ask per domain (D146) — no double-ask");
  });

  it("a slow ACTIVE 5.1.8 drip (no >10 burst) still opens the retire ask", async () => {
    const statusWrites: string[] = [];
    const { asks, slack } = slackRecorder();
    const state = store();
    state.setBounceSnapshot(7, {
      bounced: 5,
      sent: 40,
      at: new Date(FIXED_T - 10 * 60 * 1000).toISOString(),
    });
    const service = new CampaignBounceAutostopService(
      loadConfig({ DRY_RUN: "false" }),
      {
        listCampaigns: async () => [
          { id: 7, name: "BCP Slow drip", status: "ACTIVE" },
        ],
        getCampaignAnalyticsByDate: async () => ({
          sent_count: 44,
          bounce_count: 7,
        }),
        getCampaignStatistics: async () => ({}),
        updateCampaignStatus: async (_id: number, status: string) => {
          statusWrites.push(status);
        },
        listBouncedSendStats: async () => ({
          total_stats: "2",
          data: [
            {
              lead_email: "a@target.com",
              sent_time: new Date(FIXED_T - 20 * 60 * 1000).toISOString(),
              lead_category: "Sender Originated Bounce",
            },
          ],
        }),
        fetchLeadByEmail: async () => ({ id: 111 }),
        getLeadMessageHistory: async () => ({
          history: [
            { type: "SENT", from: "casey@boldercyperpartnerpro.info" },
            { type: "REPLY", email_body: BLOCKED_NDR },
          ],
        }),
        fetchCampaignSequences: async () => [],
        deleteCampaignLead: async () => undefined,
        restoreCampaignLead: async () => undefined,
      } as never,
      state,
      slack,
      undefined,
      () => FIXED_T,
    );
    const result = await service.run({ dryRun: false });
    assert.deepEqual(statusWrites, []);
    assert.deepEqual(result.bursts, [], "+2 is not a burst (D141) — 5.1.8 still acts (D162)");
    assert.equal(result.senderBlockAsks, 1);
    assert.equal(asks[0]!.kind, "retire_domain");
    assert.match(asks[0]!.title, /boldercyperpartnerpro\.info/);
  });

  it("a non-5.1.8 PAUSED sample does not open a retire ask", async () => {
    const { asks, slack } = slackRecorder();
    const state = store();
    const service = new CampaignBounceAutostopService(
      loadConfig({ DRY_RUN: "false" }),
      {
        listCampaigns: async () => [
          { id: 8, name: "Paused tenant cap", status: "PAUSED" },
        ],
        getCampaignAnalyticsByDate: async () => ({
          sent_count: 50,
          bounce_count: 12,
        }),
        getCampaignStatistics: async () => ({}),
        updateCampaignStatus: async () => undefined,
        listBouncedSendStats: async () => ({
          total_stats: "1",
          data: [
            {
              lead_email: "a@target.com",
              sent_time: new Date(FIXED_T - 20 * 60 * 1000).toISOString(),
            },
          ],
        }),
        fetchLeadByEmail: async () => ({ id: 111 }),
        getLeadMessageHistory: async () => ({
          history: [
            { type: "SENT", from: "ok@cleartechco.com" },
            { type: "REPLY", email_body: TENANT_NDR },
          ],
        }),
        fetchCampaignSequences: async () => [],
        deleteCampaignLead: async () => undefined,
        restoreCampaignLead: async () => undefined,
      } as never,
      state,
      slack,
      undefined,
      () => FIXED_T,
    );
    const result = await service.run({ dryRun: false });
    assert.deepEqual(result.bursts, []);
    assert.equal(result.senderBlockAsks, 0);
    assert.equal(asks.length, 0, "tenant-cap on a paused campaign is not a retire ask");
    assert.equal(
      state.listIsolationActions().filter((row) => row.kind === "retire_domain")
        .length,
      0,
    );
  });

  it("a non-5.1.8 invalid-recipient burst is unchanged — no retire ask", async () => {
    const statusWrites: string[] = [];
    const { asks, slack } = slackRecorder();
    const state = store();
    state.setBounceSnapshot(8, {
      bounced: 3,
      sent: 40,
      at: new Date(FIXED_T - 10 * 60 * 1000).toISOString(),
    });
    const service = new CampaignBounceAutostopService(
      loadConfig({ DRY_RUN: "false" }),
      {
        listCampaigns: async () => [
          { id: 8, name: "Bad list", status: "ACTIVE" },
        ],
        getCampaignAnalyticsByDate: async () => ({
          sent_count: 55,
          bounce_count: 15,
        }),
        getCampaignStatistics: async () => ({}),
        updateCampaignStatus: async (_id: number, status: string) => {
          statusWrites.push(status);
        },
        listBouncedSendStats: async () => ({
          total_stats: "2",
          data: [
            {
              lead_email: "a@x.com",
              sent_time: new Date(FIXED_T - 20 * 60 * 1000).toISOString(),
            },
            {
              lead_email: "b@x.com",
              sent_time: new Date(FIXED_T - 25 * 60 * 1000).toISOString(),
            },
          ],
        }),
        fetchLeadByEmail: async (email: string) => ({
          id: email === "a@x.com" ? 111 : 222,
        }),
        getLeadMessageHistory: async () => ({
          history: [
            { type: "SENT", from: "ok@cleartechco.com" },
            { type: "REPLY", email_body: INVALID_NDR },
          ],
        }),
        fetchCampaignSequences: async () => [],
        deleteCampaignLead: async () => undefined,
        restoreCampaignLead: async () => undefined,
      } as never,
      state,
      slack,
      undefined,
      () => FIXED_T,
    );
    const result = await service.run({ dryRun: false });
    assert.deepEqual(statusWrites, []);
    assert.equal(result.bursts[0]?.reason, "burst");
    assert.equal(result.bursts[0]?.verdict?.dominant, "invalid_recipient");
    assert.equal(asks.length, 0, "bad-list burst does not open a burned-domain ask");
    assert.equal(result.senderBlockAsks, 0);
  });
});
