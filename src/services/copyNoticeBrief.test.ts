import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import { StateStore } from "../state/store.js";
import { CopyNoticeBriefService } from "./copyNoticeBrief.js";

function store(): StateStore {
  return new StateStore(
    `/tmp/dw-copy-notice-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`,
  );
}

describe("CopyNoticeBriefService (D216)", () => {
  it("first tick seeds silently; the next 7am names new campaigns and variants", async () => {
    const state = store();
    const sent: string[] = [];
    const sequences: Record<number, unknown> = {
      10: [
        {
          id: 1,
          seq_number: 1,
          sequence_variants: [{ id: 11, variant_label: "A", email_body: "a" }],
        },
      ],
    };
    const mk = () =>
      new CopyNoticeBriefService(
        loadConfig({
          DRY_RUN: "false",
          SLACK_CAYDEN_USER_ID: "U0BL8JT75KN",
        }),
        {
          listCampaigns: async () => [
            { id: 10, name: "Live", status: "ACTIVE" },
            ...(sequences[11]
              ? [{ id: 11, name: "Brand new", status: "DRAFT" }]
              : []),
            { id: 99, name: "Canary shell: #10 Live", status: "PAUSED" },
          ],
          getCampaignSequences: async (id: number) => sequences[id] ?? [],
        } as never,
        { send: async (text: string) => void sent.push(text) } as never,
        state,
      );

    const first = await mk().run({ dryRun: false });
    assert.equal(first.seeded, true);
    assert.equal(first.posted, false);
    assert.equal(sent.length, 0);
    assert.ok(state.getCopyNoticeSeededAt());

    sequences[10] = [
      {
        id: 1,
        seq_number: 1,
        sequence_variants: [
          { id: 11, variant_label: "A", email_body: "a" },
          { id: 12, variant_label: "B", email_body: "b" },
        ],
      },
    ];
    sequences[11] = [{ id: 2, seq_number: 1, email_body: "hello" }];

    const second = await mk().run({ dryRun: false });
    assert.equal(second.seeded, false);
    assert.equal(second.newCampaigns, 1);
    assert.equal(second.newVariants, 1);
    assert.equal(second.posted, true);
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /<@U0BL8JT75KN>/);
    assert.match(sent[0]!, /Brand new #11/);
    assert.match(sent[0]!, /Live #10: step 1 B/);
    assert.doesNotMatch(sent[0]!, /Canary shell/);
  });

  it("stays silent when the book did not change", async () => {
    const state = store();
    const sent: string[] = [];
    const service = new CopyNoticeBriefService(
      loadConfig({ DRY_RUN: "false" }),
      {
        listCampaigns: async () => [
          { id: 10, name: "Live", status: "ACTIVE" },
        ],
        getCampaignSequences: async () => [
          { id: 1, seq_number: 1, email_body: "same" },
        ],
      } as never,
      { send: async (text: string) => void sent.push(text) } as never,
      state,
    );
    await service.run({ dryRun: false });
    const again = await service.run({ dryRun: false });
    assert.equal(again.posted, false);
    assert.equal(again.newCampaigns, 0);
    assert.equal(again.newVariants, 0);
    assert.equal(sent.length, 0);
  });

  it("a sequence fetch miss keeps the old fingerprint (no false new campaign)", async () => {
    const state = store();
    const sent: string[] = [];
    let fail = false;
    const service = new CopyNoticeBriefService(
      loadConfig({ DRY_RUN: "false" }),
      {
        listCampaigns: async () => [
          { id: 10, name: "Live", status: "ACTIVE" },
        ],
        getCampaignSequences: async () => {
          if (fail) throw new Error("429");
          return [{ id: 1, seq_number: 1, email_body: "same" }];
        },
      } as never,
      { send: async (text: string) => void sent.push(text) } as never,
      state,
    );
    await service.run({ dryRun: false });
    fail = true;
    const missed = await service.run({ dryRun: false });
    assert.equal(missed.posted, false);
    assert.equal(missed.newCampaigns, 0);
    assert.equal(missed.errors.some((row) => row.includes("#10")), true);
    assert.ok(state.getCopyNoticeBook()["10"]);
    fail = false;
    const recovered = await service.run({ dryRun: false });
    assert.equal(recovered.posted, false);
    assert.equal(recovered.newCampaigns, 0);
    assert.equal(sent.length, 0);
  });
});
