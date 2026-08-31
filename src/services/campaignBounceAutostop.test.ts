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

describe("CampaignBounceAutostopService (D141/D148)", () => {
  it("the lifetime rate never trips — bad-looking rates are artifacts, not storms", async () => {
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
    assert.deepEqual(
      result.bursts,
      [],
      "a lifetime rate — even 10.1% after 1k — is not a burst (D141)",
    );
    assert.deepEqual(paused, []);
    assert.deepEqual(started, []);
    assert.equal(
      settings.every((row) => row.threshold === null),
      true,
      "off means cleared — null, not a nominal 100",
    );
    assert.equal(settings.some((row) => row.id === 9), false);
    assert.ok(settings.some((row) => row.id === 6));
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

  it("never writes a campaign status — no START (D40), no PAUSE (D148)", async () => {
    const src = await readFile(
      new URL("./campaignBounceAutostop.ts", import.meta.url),
      "utf8",
    );
    assert.equal(/updateCampaignStatus\([^)]*START/.test(src), false);
    assert.equal(/updateCampaignStatus\([^)]*PAUSED/.test(src), false);
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
      clearBouncePaused: () => undefined,
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
      clearBouncePaused: () => undefined,
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
      writes.every((row) => row.body.bounce_autopause_threshold === null),
      "the force pass clears bounce protection (null = off)",
    );
    assert.ok(forceAllAt);

    writes.length = 0;
    const second = await service.run({ dryRun: false });
    assert.deepEqual(writes, []);
    assert.equal(second.smartleadDisabled, 0);
  });

  it("D80: GET settings 404 is not off — GET campaign 5% is drift and we clear it", async () => {
    const writes: Array<{ id: number; body: Record<string, unknown> }> = [];
    const autopauseOff = new Map<string, string>([["8", "already"]]);
    let campaignGetAt: string | null = null;
    const state = {
      getAutopauseOffAt: (id: number) => autopauseOff.get(String(id)),
      markAutopauseOff: (id: number) => {
        autopauseOff.set(String(id), new Date().toISOString());
      },
      getLastAutopauseVerifyAt: () => new Date().toISOString(),
      setLastAutopauseVerifyAt: () => undefined,
      getAutopauseForceAllAt: () => "already-forced",
      setAutopauseForceAllAt: () => undefined,
      getAutopauseCampaignGetAt: () => campaignGetAt,
      setAutopauseCampaignGetAt: (iso: string) => {
        campaignGetAt = iso;
      },
      getBounceSnapshot: () => undefined,
      setBounceSnapshot: () => undefined,
      clearBouncePaused: () => undefined,
      save: async () => undefined,
    } as never;
    const service = new CampaignBounceAutostopService(
      loadConfig({ DRY_RUN: "false" }),
      {
        listCampaigns: async () => [{ id: 8, name: "Live", status: "ACTIVE" }],
        getCampaignAnalyticsByDate: async () => ({
          sent_count: 10,
          bounce_count: 0,
        }),
        getCampaignStatistics: async () => ({}),
        getCampaignSettings: async () => {
          throw new Error("HTTP 404");
        },
        getCampaign: async () => ({
          id: 8,
          name: "Live",
          status: "ACTIVE",
          bounce_autopause_threshold: "5",
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
    assert.equal(first.smartleadDisabled, 1);
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.id, 8);
    assert.equal(writes[0]?.body.bounce_autopause_threshold, null);
    assert.equal(writes[0]?.body.send_as_plain_text, true);
    assert.ok(campaignGetAt, "the confirm-read stamp is set so the next pass is write-on-drift");

    writes.length = 0;
    const second = await service.run({ dryRun: false });
    assert.deepEqual(writes, []);
    assert.equal(second.smartleadDisabled, 0);
  });

  it("D80: an unreadable threshold is cleared, not skipped", async () => {
    const writes: number[] = [];
    let campaignGetAt: string | null = null;
    const service = new CampaignBounceAutostopService(
      loadConfig({ DRY_RUN: "false" }),
      {
        listCampaigns: async () => [{ id: 3, name: "Live", status: "ACTIVE" }],
        getCampaignAnalyticsByDate: async () => ({
          sent_count: 10,
          bounce_count: 0,
        }),
        getCampaignStatistics: async () => ({}),
        getCampaignSettings: async () => {
          throw new Error("HTTP 404");
        },
        getCampaign: async () => ({ id: 3, name: "Live", status: "ACTIVE" }),
        updateCampaignStatus: async () => undefined,
        updateCampaignSettings: async (id: number) => {
          writes.push(id);
        },
      } as never,
      {
        getAutopauseOffAt: () => "already",
        markAutopauseOff: () => undefined,
        getLastAutopauseVerifyAt: () => new Date().toISOString(),
        setLastAutopauseVerifyAt: () => undefined,
        getAutopauseForceAllAt: () => "already-forced",
        setAutopauseForceAllAt: () => undefined,
        getAutopauseCampaignGetAt: () => campaignGetAt,
        setAutopauseCampaignGetAt: (iso: string) => {
          campaignGetAt = iso;
        },
        getBounceSnapshot: () => undefined,
        setBounceSnapshot: () => undefined,
        clearBouncePaused: () => undefined,
        save: async () => undefined,
      } as never,
    );

    await service.run({ dryRun: false });
    assert.deepEqual(writes, [3]);
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
});
