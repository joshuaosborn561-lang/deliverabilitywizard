import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StateStore } from "../state/store.js";
import { CanonConvergeService } from "./canonConverge.js";
import { emptyGenericSeat } from "../lib/genericPool.js";
import { INSIGHT_CLIENT_ID } from "../lib/insightCampaigns.js";

async function rig(clock: { now: Date }) {
  const state = new StateStore(`/tmp/d303-${process.pid}-${Math.random()}.json`);
  await state.load();
  state.upsertGenericSeat(
    emptyGenericSeat("gen@pool.com", { slAccountId: 900, warmupEnabled: true, warmReadyAt: "2026-01-01T00:00:00Z" }),
  );
  const calls: string[] = [];
  const sent: string[] = [];
  const smartlead = {
    addEmailAccountsToCampaign: async (c: number, ids: number[]) => { calls.push(`add ${c} ${ids}`); return {}; },
    removeEmailAccountsFromCampaign: async (c: number, ids: number[]) => { calls.push(`rm ${c} ${ids}`); return {}; },
    getCampaign: async (id: number) => ({ id, scheduler_cron_value: { tz: "America/Chicago", days: [1, 2, 3, 4, 5], startHour: "09:00", endHour: "18:00" }, min_time_btwn_emails: 10, max_leads_per_day: 100 }),
    updateCampaignSchedule: async (id: number, body: Record<string, unknown>) => { calls.push(`sched ${id} ${JSON.stringify(body.days_of_the_week)}`); return {}; },
  };
  const slack = { send: async (t: string) => { sent.push(t); }, notifyIsolationAction: async () => undefined };
  const svc = new CanonConvergeService({
    smartlead: smartlead as never,
    state,
    slack: slack as never,
    config: { dryRun: false } as never,
    now: () => clock.now,
  });
  return { state, svc, calls, sent };
}

const account = { id: 1, from_email: "box@client.com", client_id: 5 } as never;

describe("D303 canon converge service", () => {
  it("INFRA + same-ESP under 80 rests the mailbox, generic covers via the ledger, returns after 14 days", async () => {
    const clock = { now: new Date("2026-10-26T12:00:00Z") };
    const { state, svc, calls, sent } = await rig(clock);
    const out = await svc.onIsolationVerdict({
      verdict: "INFRA", clientId: 5, pod: "A", campaignId: 11, accounts: [account],
      sameEspOf: () => ({ inboxRate: 50, scoredSameEsp: true }),
    });
    assert.deepEqual(out, [{ email: "box@client.com", action: "rest" }]);
    assert.ok(calls.includes("rm 11 1"));
    assert.ok(calls.includes("add 11 900"));
    const seat = state.getGenericSeat("gen@pool.com")!;
    assert.equal(seat.assignedClientId, 5);
    assert.equal(seat.assignedPod, "A");
    assert.equal(seat.coveringFor[0]!.email, "box@client.com");
    assert.equal(state.getMailboxRest("box@client.com")!.coveringGeneric, "gen@pool.com");
    assert.match(sent[0]!, /resting 14 days/);

    clock.now = new Date("2026-11-10T12:00:00Z");
    const back = await svc.returnDueRests();
    assert.deepEqual(back, ["box@client.com"]);
    assert.ok(calls.includes("rm 11 900"));
    assert.equal(state.getGenericSeat("gen@pool.com")!.assignedClientId, null);
    assert.equal(state.getMailboxRest("box@client.com")!.status, "returned");

    const again = await svc.onIsolationVerdict({
      verdict: "INFRA", clientId: 5, pod: "A", campaignId: 11, accounts: [account],
      sameEspOf: () => ({ inboxRate: 40, scoredSameEsp: true }),
    });
    assert.equal(again[0]!.action, "burn");
    assert.equal(state.getMailboxRest("box@client.com")!.status, "burned");
  });

  it("COPY verdict or healthy mailbox does nothing", async () => {
    const { svc, calls } = await rig({ now: new Date() });
    assert.deepEqual(await svc.onIsolationVerdict({ verdict: "COPY", clientId: 5, pod: "A", accounts: [account], sameEspOf: () => ({ inboxRate: 10, scoredSameEsp: true }) }), []);
    assert.deepEqual(await svc.onIsolationVerdict({ verdict: "INFRA", clientId: 5, pod: "A", accounts: [account], sameEspOf: () => ({ inboxRate: 95, scoredSameEsp: true }) }), []);
    assert.equal(calls.length, 0);
  });

  it("Insight rests but never gets a covering generic", async () => {
    const { state, svc } = await rig({ now: new Date() });
    await svc.onIsolationVerdict({ verdict: "INFRA", clientId: INSIGHT_CLIENT_ID, pod: "B", campaignId: 3, accounts: [account], sameEspOf: () => ({ inboxRate: 10, scoredSameEsp: true }) });
    assert.equal(state.getGenericSeat("gen@pool.com")!.assignedClientId, null);
    assert.equal(state.getMailboxRest("box@client.com")!.coveringGeneric, null);
  });

  it("send windows converge active client campaigns, skip shells and paused", async () => {
    const { svc, calls } = await rig({ now: new Date() });
    const r = await svc.convergeSendWindows([
      { id: 1, name: "Client", status: "ACTIVE" },
      { id: 2, name: "Paused", status: "PAUSED" },
    ] as never);
    assert.deepEqual(r.changed, [1]);
    assert.deepEqual(calls, ["sched 1 [1,2,3,4]"]);
  });

  it("ESP rebalance swaps 1-for-1 and releases a swapped-out generic through the ledger", async () => {
    const { state, svc, calls } = await rig({ now: new Date() });
    state.upsertGenericSeat(emptyGenericSeat("outgen@pool.com", { slAccountId: 77, assignedClientId: 5, assignedPod: "A", warmupEnabled: true }));
    const podSeats = [
      { email: "outgen@pool.com", esp: "outlook" as const, generic: true, accountId: 77 },
      ...Array.from({ length: 29 }, (_, i) => ({ email: `m${i}@c.com`, esp: "outlook" as const, generic: false, accountId: 100 + i })),
      ...Array.from({ length: 10 }, (_, i) => ({ email: `g${i}@c.com`, esp: "gmail" as const, generic: false, accountId: 200 + i })),
    ];
    const r = await svc.rebalancePod({
      clientId: 5, pod: "A", microsoftShare: 0.5, campaignIds: [11], podSeats,
      spares: [{ email: "own@c.com", esp: "gmail", generic: false, warm: true, clientId: 5, accountId: 300 }],
    });
    assert.equal(r.swaps, 1);
    assert.ok(calls.includes("add 11 300"));
    assert.ok(calls.includes("rm 11 77"));
    assert.equal(state.getGenericSeat("outgen@pool.com")!.assignedClientId, null);
  });
});
