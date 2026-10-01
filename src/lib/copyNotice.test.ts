import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bookFromCampaign,
  caydenMentionPrefix,
  copyNoticeSlackText,
  diffCopyNotice,
  isCopyNoticeCampaign,
  sequencesFromPayload,
  variantMarks,
} from "./copyNotice.js";

describe("copy notice fingerprints (D216)", () => {
  it("skips shells and finished campaigns", () => {
    assert.equal(
      isCopyNoticeCampaign({ id: 1, name: "Canary shell: #9 Live", status: "PAUSED" }),
      false,
    );
    assert.equal(
      isCopyNoticeCampaign({ id: 2, name: "DW Word Hunt Shell", status: "PAUSED" }),
      false,
    );
    assert.equal(
      isCopyNoticeCampaign({ id: 3, name: "Done", status: "COMPLETED" }),
      false,
    );
    assert.equal(
      isCopyNoticeCampaign({ id: 4, name: "EMCOR E Small Ops", status: "DRAFT" }),
      true,
    );
  });

  it("keys variants by id so a body edit is not a new variant", () => {
    const marks = variantMarks([
      {
        id: 1,
        seq_number: 1,
        sequence_variants: [
          { id: 11, variant_label: "A", subject: "old", email_body: "one" },
          { id: 12, variant_label: "B", subject: "old", email_body: "two" },
        ],
      },
    ]);
    assert.deepEqual(
      marks.map((row) => row.key),
      ["step:1:id:11", "step:1:id:12"],
    );
    const edited = variantMarks([
      {
        id: 1,
        seq_number: 1,
        sequence_variants: [
          { id: 11, variant_label: "A", subject: "new", email_body: "changed" },
          { id: 12, variant_label: "B", subject: "old", email_body: "two" },
        ],
      },
    ]);
    assert.deepEqual(
      edited.map((row) => row.key),
      ["step:1:id:11", "step:1:id:12"],
    );
  });

  it("diffs new campaigns and new variant ids only", () => {
    const previous = {
      "10": bookFromCampaign(
        { id: 10, name: "Live", status: "ACTIVE" },
        [
          {
            id: 1,
            seq_number: 1,
            sequence_variants: [{ id: 11, variant_label: "A" }],
          },
        ],
      ),
    };
    const current = {
      "10": bookFromCampaign(
        { id: 10, name: "Live", status: "ACTIVE" },
        [
          {
            id: 1,
            seq_number: 1,
            sequence_variants: [
              { id: 11, variant_label: "A" },
              { id: 12, variant_label: "B" },
            ],
          },
        ],
      ),
      "11": bookFromCampaign(
        { id: 11, name: "Brand new", status: "DRAFT" },
        [{ id: 2, seq_number: 1, email_body: "hello" }],
      ),
    };
    const marks = {
      "10": variantMarks(sequencesFromPayload([
        {
          id: 1,
          seq_number: 1,
          sequence_variants: [
            { id: 11, variant_label: "A" },
            { id: 12, variant_label: "B" },
          ],
        },
      ])),
      "11": variantMarks([{ id: 2, seq_number: 1, email_body: "hello" }]),
    };
    const diff = diffCopyNotice(previous, current, marks);
    assert.deepEqual(
      diff.newCampaigns.map((row) => row.id),
      [11],
    );
    assert.deepEqual(
      diff.newVariants.map((row) => row.label),
      ["step 1 B"],
    );
    const text = copyNoticeSlackText(diff, ["U0BL8JT75KN"]);
    assert.match(text ?? "", /<@U0BL8JT75KN>/);
    assert.match(text ?? "", /Brand new #11/);
    assert.match(text ?? "", /Live #10: step 1 B/);
    assert.equal(copyNoticeSlackText({ newCampaigns: [], newVariants: [] }, []), null);
    assert.equal(caydenMentionPrefix([]), "Cayden");
  });
});
