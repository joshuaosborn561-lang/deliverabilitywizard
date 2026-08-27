import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import { StateStore } from "../state/store.js";
import {
  BounceResurrectionService,
  restorableLead,
} from "./bounceResurrection.js";

const TENANT_NDR =
  "<html>Delivery has failed. Remote server returned '550 5.7.233 - your tenant has exceeded its daily limit (tenant external recipient rate limit)'</html>";
const BAD_ADDRESS_NDR =
  "<html>Delivery has failed. Remote server returned '550 5.1.1 user unknown'</html>";

function store(): StateStore {
  return new StateStore(
    `/tmp/dw-resurrect-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`,
  );
}

describe("D147 — remediated infra bounces re-queue their leads", () => {
  it("opens a job only for a sender-fault verdict on a real restart", async () => {
    const state = store();
    await state.load();
    const service = new BounceResurrectionService(
      loadConfig({ DRY_RUN: "false" }),
      {} as never,
      state,
    );

    // No stamp → no job (nothing was bounce-paused).
    service.noteRestart({ id: 1, name: "Never paused" });
    assert.equal(state.getBounceResurrectionJob(1), undefined);

    // Sender-fault verdict → job.
    const pausedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    state.markBouncePaused(5, pausedAt);
    state.setBounceVerdict({
      campaignId: 5,
      at: pausedAt,
      dominant: "tenant_rate_limit",
      summary: "tenant_rate_limit×3 invalid_recipient×1",
      senderDomains: ["salesgliderset.info"],
    });
    service.noteRestart({ id: 5, name: "Engagers" });
    const job = state.getBounceResurrectionJob(5);
    assert.ok(job, "restart of a sender-fault pause opens a job");
    assert.equal(job!.pausedAt, pausedAt);

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

  it("re-queues only leads whose own NDR was the sender's fault, once, suppression-respecting", async () => {
    const state = store();
    await state.load();
    const now = Date.now();
    const pausedAt = new Date(now - 60 * 60 * 1000).toISOString();
    const inWindow = new Date(now - 90 * 60 * 1000).toISOString();
    const beforeWindow = new Date(now - 30 * 60 * 60 * 1000).toISOString();

    state.markBouncePaused(5, pausedAt);
    state.setBounceVerdict({
      campaignId: 5,
      at: pausedAt,
      dominant: "tenant_rate_limit",
      summary: "tenant_rate_limit×3 invalid_recipient×1",
      senderDomains: ["salesgliderset.info"],
    });

    const bounced = [
      { lead_email: "good@target.com", sent_time: inWindow },
      { lead_email: "bad@target.com", sent_time: inWindow },
      { lead_email: "old@target.com", sent_time: beforeWindow },
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
    );

    service.noteRestart({ id: 5, name: "Engagers" });
    const result = await service.work();

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
    assert.equal(result.requeued, 1);
    assert.equal(result.skippedDead, 1, "the real bad address stays dead");
    const job = state.getBounceResurrectionJob(5);
    assert.equal(job?.done, true);
    // 1 outside the window + 1 overlap re-read (the resurrected row does
    // not advance the cursor, so a non-shrinking stats list re-serves the
    // tail once — harmless, the ledger/window skips it).
    assert.equal(job?.skippedOther, 2);
    assert.ok(state.wasLeadResurrected(5, "good@target.com"));
    assert.equal(sent.length, 1, "one action receipt per finished job");
    assert.match(sent[0]!, /Re-queued 1 bounced lead/);

    // The incident is worked once: a second pass re-queues nothing.
    const again = await service.work();
    assert.equal(again.requeued, 0);
    assert.equal(deleted.length, 1);
    // And the ledger blocks a second resurrection of the same lead even
    // if a new incident opens on the same campaign.
    state.markBouncePaused(5, new Date().toISOString());
    state.setBounceVerdict({
      campaignId: 5,
      at: new Date().toISOString(),
      dominant: "tenant_rate_limit",
      summary: "tenant_rate_limit×2",
      senderDomains: ["salesgliderset.info"],
    });
    service.noteRestart({ id: 5, name: "Engagers" });
    await service.work();
    assert.equal(
      deleted.length,
      1,
      "one resurrection per lead per campaign (D147)",
    );
  });

  it("dry-run opens no jobs and writes nothing", async () => {
    const state = store();
    await state.load();
    const pausedAt = new Date().toISOString();
    state.markBouncePaused(7, pausedAt);
    state.setBounceVerdict({
      campaignId: 7,
      at: pausedAt,
      dominant: "sender_blocked",
      summary: "sender_blocked×1",
      senderDomains: ["x.info"],
    });
    const service = new BounceResurrectionService(
      loadConfig({ DRY_RUN: "true" }),
      {} as never,
      state,
    );
    service.noteRestart({ id: 7, name: "Dry" });
    assert.equal(state.getBounceResurrectionJob(7), undefined);
    const result = await service.work();
    assert.equal(result.jobs, 0);
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
