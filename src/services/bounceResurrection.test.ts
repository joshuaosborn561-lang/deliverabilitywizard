import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import { StateStore } from "../state/store.js";
import type { BounceVerdictRecord } from "../state/store.js";
import {
  BounceResurrectionService,
  restorableLead,
  tenantGateOpen,
  verdictBlamesSender,
} from "./bounceResurrection.js";

const TENANT_NDR =
  "<html>Delivery has failed. Remote server returned '550 5.7.233 - your tenant has exceeded its daily limit (tenant external recipient rate limit)'</html>";
const BAD_ADDRESS_NDR =
  "<html>Delivery has failed. Remote server returned '550 5.1.1 user unknown'</html>";
const BLOCKED_NDR =
  "<html>Delivery has failed. Remote server returned '550 5.1.8 Access denied, bad outbound sender AS(42004)'</html>";
const CONTENT_NDR =
  "<html>Delivery has failed. Remote server returned '550 5.7.1 Message rejected due to content policies'</html>";

/** Mid-day UTC so "same day" vs "next day" is unambiguous. */
const T0 = Date.parse("2026-08-27T15:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function store(): StateStore {
  return new StateStore(
    `/tmp/dw-resurrect-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`,
  );
}

function tenantVerdict(campaignId: number, at = iso(T0)): BounceVerdictRecord {
  return {
    campaignId,
    at,
    dominant: "tenant_rate_limit",
    summary: "tenant_rate_limit×3 invalid_recipient×1",
    senderDomains: ["salesgliderset.info"],
  };
}

describe("D148 — bounces are investigated, remediated and re-queued, never paused away", () => {
  it("noteIncident opens only on a sender-fault verdict, folds repeats, stays inert in dry-run", async () => {
    const state = store();
    await state.load();
    let now = T0;
    const service = new BounceResurrectionService(
      loadConfig({ DRY_RUN: "false" }),
      {} as never,
      state,
      undefined,
      () => now,
    );

    // Real bad addresses are the list's problem — nothing to resend.
    service.noteIncident(
      { id: 1, name: "Bad list" },
      {
        campaignId: 1,
        at: iso(T0),
        dominant: "invalid_recipient",
        summary: "invalid_recipient×4",
        senderDomains: [],
      },
    );
    assert.equal(state.getBounceResurrectionJob(1), undefined);

    service.noteIncident({ id: 5, name: "Engagers" }, tenantVerdict(5));
    const job = state.getBounceResurrectionJob(5);
    assert.ok(job, "a sender-fault burst opens the incident — no pause, no restart needed");
    assert.equal(job!.windowEnd, iso(T0));
    assert.equal(job!.windowStart, iso(T0 - 24 * 60 * 60 * 1000));

    // A repeat burst while the incident is open folds in: window widens,
    // the job does not restart.
    now = T0 + 30 * 60 * 1000;
    service.noteIncident({ id: 5, name: "Engagers" }, tenantVerdict(5));
    const folded = state.getBounceResurrectionJob(5);
    assert.equal(folded!.windowEnd, iso(now));
    assert.equal(folded!.openedAt, iso(T0), "still the same incident");

    const dryState = store();
    await dryState.load();
    const dryService = new BounceResurrectionService(
      loadConfig({ DRY_RUN: "true" }),
      {} as never,
      dryState,
      undefined,
      () => T0,
    );
    dryService.noteIncident({ id: 5, name: "Dry" }, tenantVerdict(5));
    assert.equal(dryState.getBounceResurrectionJob(5), undefined);
    const dryResult = await dryService.work();
    assert.equal(dryResult.jobs, 0);
  });

  it("tenant-cap wave: parks same-day, flushes after the UTC midnight reset, once per lead", async () => {
    const state = store();
    await state.load();
    let now = T0;

    const bounced = [
      { lead_email: "good@target.com", sent_time: iso(T0 - 60 * 60 * 1000) },
      { lead_email: "bad@target.com", sent_time: iso(T0 - 60 * 60 * 1000) },
      { lead_email: "old@target.com", sent_time: iso(T0 - 30 * 60 * 60 * 1000) },
    ];
    const deleted: Array<{ campaignId: number; leadId: number | string }> = [];
    const restored: Array<{ campaignId: number; lead: Record<string, unknown> }> =
      [];
    const smartlead = {
      listBouncedSendStats: async (
        _campaignId: number,
        limit: number,
        offset: number,
      ) => ({
        total_stats: String(bounced.length),
        data: bounced.slice(offset, offset + limit),
      }),
      fetchLeadByEmail: async (email: string) =>
        email === "good@target.com"
          ? {
              id: 11,
              first_name: "Gwen",
              company_name: "Goodco",
              custom_fields: { Local_Sports_Team: "Astros" },
              // never carried over:
              email_lead_map_id: 999,
            }
          : { id: 12 },
      getLeadMessageHistory: async (_campaignId: number, leadId: number) => ({
        history: [
          { type: "SENT", from: "s@salesgliderset.info" },
          {
            type: "REPLY",
            email_body: leadId === 11 ? TENANT_NDR : BAD_ADDRESS_NDR,
          },
        ],
      }),
      fetchCampaignSequences: async () => {
        throw new Error("no content leads parked — sequences never read");
      },
      deleteCampaignLead: async (campaignId: number, leadId: number | string) => {
        deleted.push({ campaignId, leadId });
      },
      restoreCampaignLead: async (
        campaignId: number,
        lead: Record<string, unknown>,
      ) => {
        restored.push({ campaignId, lead });
      },
    } as never;
    const sent: string[] = [];
    const service = new BounceResurrectionService(
      loadConfig({ DRY_RUN: "false" }),
      smartlead,
      state,
      { send: async (text: string) => void sent.push(text) } as never,
      () => now,
    );

    service.noteIncident({ id: 5, name: "Engagers" }, tenantVerdict(5));
    const sameDay = await service.work();

    // Same UTC day: the cap has not reset — everything classified, the
    // sender-fault lead parked, nothing written to Smartlead yet.
    assert.equal(sameDay.classified, 2, "good + bad classified; old is out of window");
    assert.equal(sameDay.requeued, 0, "the cap has not reset yet — hold the resend");
    assert.deepEqual(deleted, []);
    let job = state.getBounceResurrectionJob(5);
    assert.equal(job?.scanDone, true);
    assert.equal(job?.deferred.length, 1);
    assert.equal(job?.deferred[0]?.email, "good@target.com");
    assert.equal(job?.skippedDead, 1, "the real bad address stays dead");
    assert.equal(job?.skippedOther, 1, "the out-of-window row is not this incident");
    assert.equal(sent.length, 0, "no receipt while nothing has been re-queued");

    // Past midnight UTC the tenant's cap is fresh — the parked lead goes out.
    now = Date.parse("2026-08-28T01:00:00.000Z");
    const nextDay = await service.work();
    assert.equal(nextDay.requeued, 1);
    assert.deepEqual(deleted, [{ campaignId: 5, leadId: 11 }]);
    assert.equal(restored.length, 1);
    assert.equal(restored[0]!.lead.email, "good@target.com");
    assert.equal(restored[0]!.lead.first_name, "Gwen");
    assert.deepEqual(restored[0]!.lead.custom_fields, {
      Local_Sports_Team: "Astros",
    });
    assert.equal(
      restored[0]!.lead.email_lead_map_id,
      undefined,
      "only merge fields carry over",
    );
    job = state.getBounceResurrectionJob(5);
    assert.equal(job?.done, true);
    assert.ok(state.wasLeadResurrected(5, "good@target.com"));
    assert.equal(sent.length, 1, "one receipt for the flushed wave");
    assert.match(sent[0]!, /Re-queued 1 bounced lead/);

    // A second incident on the same campaign cannot resend the same lead —
    // the once-per-lead ledger holds (D147).
    service.noteIncident({ id: 5, name: "Engagers" }, tenantVerdict(5, iso(now)));
    await service.work();
    assert.equal(
      deleted.length,
      1,
      "one resurrection per lead per campaign (D147)",
    );
  });

  it("a blocked sender waits for its retire ask; a content block waits for a copy edit", async () => {
    const state = store();
    await state.load();
    let now = T0;
    let sequences: Array<Record<string, unknown>> = [
      { updated_at: iso(T0 - 2 * 60 * 60 * 1000) },
    ];
    const deleted: number[] = [];
    const mkSl = (email: string, ndr: string, from: string) =>
      ({
        listBouncedSendStats: async () => ({
          total_stats: "1",
          data: [{ lead_email: email, sent_time: iso(T0 - 60 * 60 * 1000) }],
        }),
        fetchLeadByEmail: async () => ({ id: 21 }),
        getLeadMessageHistory: async () => ({
          history: [
            { type: "SENT", from },
            { type: "REPLY", email_body: ndr },
          ],
        }),
        fetchCampaignSequences: async () => sequences,
        deleteCampaignLead: async (campaignId: number) => {
          deleted.push(campaignId);
        },
        restoreCampaignLead: async () => undefined,
      }) as never;

    // Campaign 7 — sender_blocked, its domain's retire ask still pending.
    state.upsertIsolationAction({
      id: "ask-1",
      kind: "retire_domain",
      status: "pending",
      title: "Retire burned.info",
      proof: "550 5.1.8",
      detail: { domain: "burned.info" },
      allowed: "owner",
      requestedAt: iso(T0),
    });
    const blockedService = new BounceResurrectionService(
      loadConfig({ DRY_RUN: "false" }),
      mkSl("lead@x.com", BLOCKED_NDR, "flagged@burned.info"),
      state,
      undefined,
      () => now,
    );
    blockedService.noteIncident(
      { id: 7, name: "Blocked" },
      {
        campaignId: 7,
        at: iso(T0),
        dominant: "sender_blocked",
        summary: "sender_blocked×1",
        senderDomains: ["burned.info"],
      },
    );
    // Next day — the tenant gate would be open by now, so what holds this
    // lead is the unresolved block, not the calendar.
    now = Date.parse("2026-08-28T01:00:00.000Z");
    await blockedService.work();
    assert.deepEqual(deleted, [], "an unresolved sender block holds the resend");
    assert.equal(state.getBounceResurrectionJob(7)?.deferred.length, 1);
    assert.equal(state.getBounceResurrectionJob(7)?.deferred[0]?.domain, "burned.info");

    // Josh resolves the ask (retired, or unblocked in Defender + Cancel).
    state.upsertIsolationAction({
      id: "ask-1",
      kind: "retire_domain",
      status: "executed",
      title: "Retire burned.info",
      proof: "550 5.1.8",
      detail: { domain: "burned.info" },
      allowed: "owner",
      requestedAt: iso(T0),
    });
    await blockedService.work();
    assert.deepEqual(deleted, [7], "a resolved block releases the resend");
    assert.equal(state.getBounceResurrectionJob(7)?.done, true);

    // Campaign 8 — content_block, copy untouched since the incident.
    deleted.length = 0;
    const contentService = new BounceResurrectionService(
      loadConfig({ DRY_RUN: "false" }),
      mkSl("lead@y.com", CONTENT_NDR, "s@fine.info"),
      state,
      undefined,
      () => now,
    );
    now = T0;
    contentService.noteIncident(
      { id: 8, name: "Content" },
      {
        campaignId: 8,
        at: iso(T0),
        dominant: "content_block",
        summary: "content_block×1",
        senderDomains: ["fine.info"],
      },
    );
    now = Date.parse("2026-08-28T01:00:00.000Z");
    await contentService.work();
    assert.deepEqual(deleted, [], "unchanged copy holds the resend");

    // The copy gets edited after the incident opened → the lead goes out.
    sequences = [{ updated_at: iso(Date.parse("2026-08-27T20:00:00.000Z")) }];
    await contentService.work();
    assert.deepEqual(deleted, [8], "an edited sequence releases the resend");
    assert.ok(state.getBounceResurrectionJob(8)?.copyEditedAt);
  });

  it("a gate that never opens expires after 7 days and the receipt says so", async () => {
    const state = store();
    await state.load();
    let now = T0;
    state.upsertIsolationAction({
      id: "ask-2",
      kind: "retire_domain",
      status: "pending",
      title: "Retire stuck.info",
      proof: "550 5.1.8",
      detail: { domain: "stuck.info" },
      allowed: "owner",
      requestedAt: iso(T0),
    });
    const sent: string[] = [];
    const service = new BounceResurrectionService(
      loadConfig({ DRY_RUN: "false" }),
      {
        listBouncedSendStats: async () => ({
          total_stats: "1",
          data: [{ lead_email: "lead@x.com", sent_time: iso(T0 - 60 * 60 * 1000) }],
        }),
        fetchLeadByEmail: async () => ({ id: 31 }),
        getLeadMessageHistory: async () => ({
          history: [
            { type: "SENT", from: "flagged@stuck.info" },
            { type: "REPLY", email_body: BLOCKED_NDR },
          ],
        }),
        fetchCampaignSequences: async () => [],
        deleteCampaignLead: async () => {
          throw new Error("expired leads are never re-queued");
        },
        restoreCampaignLead: async () => undefined,
      } as never,
      state,
      { send: async (text: string) => void sent.push(text) } as never,
      () => now,
    );
    service.noteIncident(
      { id: 9, name: "Stuck" },
      {
        campaignId: 9,
        at: iso(T0),
        dominant: "sender_blocked",
        summary: "sender_blocked×1",
        senderDomains: ["stuck.info"],
      },
    );
    await service.work();
    assert.equal(state.getBounceResurrectionJob(9)?.deferred.length, 1);

    now = T0 + 8 * 24 * 60 * 60 * 1000;
    await service.work();
    const job = state.getBounceResurrectionJob(9);
    assert.equal(job?.done, true);
    assert.equal(job?.dropped, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /expired un-resent/);
  });

  it("pre-D148 transition: a stamped pause restarted by a human still opens its job", async () => {
    const state = store();
    await state.load();
    const service = new BounceResurrectionService(
      loadConfig({ DRY_RUN: "false" }),
      {} as never,
      state,
      undefined,
      () => T0,
    );

    // No stamp → no job (nothing was bounce-paused).
    service.noteRestart({ id: 1, name: "Never paused" });
    assert.equal(state.getBounceResurrectionJob(1), undefined);

    // Sender-fault verdict → job, windowed on the stamp.
    const pausedAt = iso(T0 - 60 * 60 * 1000);
    state.markBouncePaused(5, pausedAt);
    state.setBounceVerdict(tenantVerdict(5, pausedAt));
    service.noteRestart({ id: 5, name: "Engagers" });
    const job = state.getBounceResurrectionJob(5);
    assert.ok(job, "restart of a sender-fault pause opens a job");
    assert.equal(
      job!.windowStart,
      iso(Date.parse(pausedAt) - 24 * 60 * 60 * 1000),
    );

    // Bad-list verdict → the bounces were real; nothing to resend.
    state.markBouncePaused(6, pausedAt);
    state.setBounceVerdict({
      campaignId: 6,
      at: pausedAt,
      dominant: "invalid_recipient",
      summary: "invalid_recipient×4",
      senderDomains: [],
    });
    service.noteRestart({ id: 6, name: "Bad list" });
    assert.equal(state.getBounceResurrectionJob(6), undefined);
  });

  it("tenantGateOpen: closed on the bounce's UTC day, open the next", () => {
    const sent = "2026-08-27T15:00:00.000Z";
    assert.equal(tenantGateOpen(sent, Date.parse("2026-08-27T23:59:00Z")), false);
    assert.equal(tenantGateOpen(sent, Date.parse("2026-08-28T00:10:00Z")), true);
    assert.equal(
      tenantGateOpen("2026-08-27T23:50:00.000Z", Date.parse("2026-08-28T00:10:00Z")),
      true,
      "a cap bounce minutes before midnight is eligible minutes after",
    );
  });

  it("verdictBlamesSender reads dominant and minority classes alike", () => {
    assert.equal(verdictBlamesSender(tenantVerdict(1)), true);
    assert.equal(
      verdictBlamesSender({
        campaignId: 1,
        at: iso(T0),
        dominant: "invalid_recipient",
        summary: "invalid_recipient×3 sender_blocked×1",
        senderDomains: [],
      }),
      true,
      "a minority sender_blocked sample still opens the incident",
    );
    assert.equal(
      verdictBlamesSender({
        campaignId: 1,
        at: iso(T0),
        dominant: "invalid_recipient",
        summary: "invalid_recipient×4",
        senderDomains: [],
      }),
      false,
    );
  });

  it("restorableLead keeps merge fields and drops empties", () => {
    assert.deepEqual(
      restorableLead("a@b.com", {
        first_name: "A",
        last_name: "",
        company_name: null,
        website: "b.com",
        id: 5,
      }),
      { email: "a@b.com", first_name: "A", website: "b.com" },
    );
  });
});
