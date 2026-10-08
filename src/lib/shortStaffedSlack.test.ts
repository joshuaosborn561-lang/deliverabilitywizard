import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  groupShortStaffedByClient,
  shortStaffedLines,
  shortStaffedSnapshot,
} from "./shortStaffedSlack.js";

describe("D248 — short-staffed on change, one line per client", () => {
  it("lumps campaigns per client and no-ops an unchanged snapshot", () => {
    const rows = groupShortStaffedByClient([
      { clientId: 521881, clientName: "TechEvo", name: "TE A", shortBy: 4 },
      { clientId: 521881, clientName: "TechEvo", name: "TE B", shortBy: 2 },
      { clientId: 542838, clientName: "BCP", name: "BCP A", shortBy: 1 },
    ]);
    assert.equal(rows.length, 2);
    const text = shortStaffedLines(rows);
    assert.match(text ?? "", /TechEvo is short 6 staffable across 2 campaigns/);
    assert.match(text ?? "", /BCP is short 1 staffable across 1 campaign/);
    assert.equal(
      shortStaffedSnapshot(rows),
      shortStaffedSnapshot(groupShortStaffedByClient([
        { clientId: 521881, clientName: "TechEvo", name: "TE A", shortBy: 4 },
        { clientId: 521881, clientName: "TechEvo", name: "TE B", shortBy: 2 },
        { clientId: 542838, clientName: "BCP", name: "BCP A", shortBy: 1 },
      ])),
    );
  });
});
