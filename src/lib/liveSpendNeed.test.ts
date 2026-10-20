import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StateStore } from "../state/store.js";
import { INSIGHT_CLIENT_ID } from "./insightCampaigns.js";
import { buildIsolationAction } from "./isolationActions.js";
import {
  SPEND_APPROVAL_TTL_MS,
  clientAttributionFromSeats,
  domainAlreadyAnnounced,
  domainHasLiveOrPendingCover,
  expireStaleApprovals,
  indexLiveSeats,
  isolationMailboxOrderConsumed,
  isFreshApproval,
  isInsightSpendDetail,
  markDomainAnnounced,
  persistCoverDomains,
  spendNeedDisappeared,
  spendNeedReason,
  triggerEmailsOf,
} from "./liveSpendNeed.js";

function tempStore(): StateStore {
  return new StateStore(
    `/tmp/dw-live-spend-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`,
  );
}

describe("D296 live spend need", () => {
  it("does not open a second cover when the domain already has a live cover", () => {
    const store = tempStore();
    const bought = buildIsolationAction({
      kind: "buy_domains",
      title: "Buy cover for meetconnectnow.com",
      proof: "Sep 8",
      detail: {
        domain: "meetconnectnow.com",
        domains: ["goliathcybersecuritygo.info"],
      },
    });
    store.upsertIsolationAction({
      ...bought,
      status: "executed",
      executedAt: "2026-09-08T12:00:00.000Z",
    });
    store.upsertPoolMailbox({
      email: "a@goliathcybersecuritygo.info",
      domain: "goliathcybersecuritygo.info",
      platform: "GOOGLE",
      firstName: "A",
      lastName: "Cover",
      status: "warming",
      warmedAt: "2026-09-08T12:00:00.000Z",
    });
    persistCoverDomains(store, "meetconnectnow.com", [
      "goliathcybersecuritygo.info",
    ]);
    const hit = domainHasLiveOrPendingCover(store, "meetconnectnow.com");
    assert.equal(hit?.kind, "live");
    assert.equal(hit?.cover, "goliathcybersecuritygo.info");
    const gone = spendNeedDisappeared(
      {
        kind: "buy_domains",
        id: "new-ask",
        status: "pending",
        detail: { domain: "meetconnectnow.com" },
      },
      store,
    );
    assert.equal(gone.gone, true);
    assert.equal(gone.why, "cover_exists");
  });

  it("drops a buy whose trigger seat is gone from live Smartlead", () => {
    const store = tempStore();
    const live = {
      seats: indexLiveSeats([
        {
          from_email: "other@culturefitsaio.info",
          client_id: 418275,
        },
      ]),
    };
    const gone = spendNeedDisappeared(
      {
        kind: "buy_domains",
        id: "stale",
        status: "pending",
        detail: {
          domain: "culturefitsaio.info",
          failingEmails: ["latoyaflatley@culturefitsaio.info"],
          triggerSeatEmail: "latoyaflatley@culturefitsaio.info",
        },
      },
      store,
      live,
    );
    assert.equal(gone.gone, true);
    assert.equal(gone.why, "seat_gone");
  });

  it("keeps a buy when the trigger seat is still in live Smartlead", () => {
    const store = tempStore();
    const live = {
      seats: indexLiveSeats([
        {
          from_email: "latoyaflatley@culturefitsaio.info",
          client_id: 418275,
        },
      ]),
    };
    const gone = spendNeedDisappeared(
      {
        kind: "buy_domains",
        id: "live-ask",
        status: "pending",
        detail: {
          domain: "culturefitsaio.info",
          failingEmails: ["latoyaflatley@culturefitsaio.info"],
        },
      },
      store,
      live,
    );
    assert.equal(gone.gone, false);
  });

  it("attributes the client from the trigger seat's client_id, not a stale card label", () => {
    const seats = indexLiveSeats(
      [{ from_email: "latoyaflatley@culturefitsaio.info", client_id: 418275 }],
      [{ id: 418275, name: "Culture Fits", logo: "Culture Fits" }],
    );
    const attr = clientAttributionFromSeats([...seats.values()], {
      clientId: 542838,
      clientName: "Bolder Cyber Partners",
    });
    assert.equal(attr.clientId, 418275);
    assert.equal(attr.clientKey, "id:418275");
    assert.match(attr.clientName, /Culture Fits/);
  });

  it("Insight spend is Josh-only", () => {
    assert.equal(
      isInsightSpendDetail({
        ownerClientId: INSIGHT_CLIENT_ID,
        domain: "joshuaosbornsalestry.info",
      }),
      true,
    );
    assert.equal(
      isInsightSpendDetail({ ownerClientId: 542838, domain: "bcp.info" }),
      false,
    );
  });

  it("approvals older than 48h are not fresh and revert to pending", () => {
    const store = tempStore();
    const now = new Date("2026-10-20T14:00:00.000Z");
    const stale = buildIsolationAction({
      kind: "buy_domains",
      title: "Buy cover for labgoliath",
      proof: "old",
      detail: { domain: "meetconnectnow.com" },
      now: "2026-10-17T12:00:00.000Z",
    });
    store.upsertIsolationAction({
      ...stale,
      status: "approved",
      decidedAt: "2026-10-17T12:00:00.000Z",
      decidedBy: "Cayden",
    });
    store.upsertSpendApproval({
      id: "porkbun:isolation:joshuaosbornsalestry.info",
      kind: "porkbun_domain",
      description: "Insight domain",
      detail: { domain: "joshuaosbornsalestry.info", clientId: INSIGHT_CLIENT_ID },
      requestedAt: "2026-10-17T12:00:00.000Z",
      status: "approved",
      decidedAt: "2026-10-17T12:00:00.000Z",
      decidedBy: "Cayden",
    });
    assert.equal(
      isFreshApproval(
        { decidedAt: "2026-10-17T12:00:00.000Z" },
        now.getTime(),
      ),
      false,
    );
    assert.equal(
      isFreshApproval({ decidedAt: now.toISOString() }, now.getTime()),
      true,
    );
    assert.equal(SPEND_APPROVAL_TTL_MS, 48 * 60 * 60 * 1000);
    const expired = expireStaleApprovals(store, now);
    assert.equal(expired.isolation, 1);
    assert.equal(expired.spend, 1);
    assert.equal(store.getIsolationAction(stale.id)?.status, "pending");
    assert.equal(
      store.getSpendApproval("porkbun:isolation:joshuaosbornsalestry.info")
        ?.status,
      "pending",
    );
  });

  it("card reason names the trigger seat", () => {
    const reason = spendNeedReason({
      kind: "buy_domains",
      domain: "culturefitsaio.info",
      triggerEmails: ["latoyaflatley@culturefitsaio.info"],
    });
    assert.match(reason, /latoyaflatley@culturefitsaio\.info/);
    assert.match(reason, /culturefitsaio\.info/);
    assert.equal(
      triggerEmailsOf({
        failingEmails: ["latoyaflatley@culturefitsaio.info"],
      })[0],
      "latoyaflatley@culturefitsaio.info",
    );
  });

  it("does not expire a mailbox-resume whose domain is already bought", () => {
    const store = tempStore();
    const now = new Date("2026-10-20T14:00:00.000Z");
    const action = buildIsolationAction({
      kind: "buy_domains",
      title: "Finish mailboxes for crosslaunchcohq.info",
      proof: "nameservers pending",
      detail: {
        domain: "crosslaunchco.com",
        domains: ["crosslaunchcohq.info"],
        phase: "awaiting_mailboxes",
      },
      now: "2026-10-17T12:00:00.000Z",
    });
    store.upsertIsolationAction({
      ...action,
      status: "approved",
      decidedAt: "2026-10-17T12:00:00.000Z",
      decidedBy: "Cayden",
    });
    store.upsertSpendApproval({
      id: "inboxkit:isolation:crosslaunchcohq.info:GOOGLE:n3",
      requestKey: "inboxkit:isolation:crosslaunchcohq.info:GOOGLE:n3",
      kind: "inboxkit_mailbox_purchase",
      description: "Mailboxes",
      detail: { domain: "crosslaunchcohq.info" },
      requestedAt: "2026-10-17T12:00:00.000Z",
      status: "approved",
      decidedAt: "2026-10-17T12:00:00.000Z",
      decidedBy: "Cayden",
    });
    const expired = expireStaleApprovals(store, now);
    assert.equal(expired.isolation, 0);
    assert.equal(expired.spend, 0);
    assert.equal(store.getIsolationAction(action.id)?.status, "approved");
  });

  it("stamps announce once per domain", () => {
    const store = tempStore();
    markDomainAnnounced(store, "retire_domain", "crosslaunchcohq.info");
    assert.equal(
      domainAlreadyAnnounced(store, "retire_domain", "crosslaunchcohq.info"),
      true,
    );
    assert.equal(
      domainAlreadyAnnounced(store, "buy_domains", "crosslaunchcohq.info"),
      false,
    );
  });

  it("treats a consumed InboxKit isolation key as already ordered", () => {
    const store = tempStore();
    store.upsertSpendApproval({
      id: "inboxkit:isolation:crosslaunchcohq.info:GOOGLE:n3",
      requestKey: "inboxkit:isolation:crosslaunchcohq.info:GOOGLE:n3",
      kind: "inboxkit_mailbox_purchase",
      description: "Mailboxes",
      detail: { domain: "crosslaunchcohq.info" },
      requestedAt: "2026-10-20T07:30:00.000Z",
      status: "consumed",
      decidedAt: "2026-10-20T07:30:00.000Z",
      decidedBy: "Cayden",
    });
    assert.equal(
      isolationMailboxOrderConsumed(
        store,
        "inboxkit:isolation:crosslaunchcohq.info:GOOGLE:n3",
      ),
      true,
    );
  });
});
