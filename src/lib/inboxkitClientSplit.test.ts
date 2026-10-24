import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  InboxkitClientSplitCache,
  SMARTLEAD_TO_INBOXKIT_WORKSPACE,
  countInboxkitEspSplit,
  inboxkitWorkspaceForClient,
} from "./inboxkitClientSplit.js";

describe("InboxKit client ESP split (D301)", () => {
  it("maps Smartlead person-names to InboxKit workspaces", () => {
    assert.equal(inboxkitWorkspaceForClient("Corey Tapper"), "TechEvolution");
    assert.equal(inboxkitWorkspaceForClient("Kyle Peterson"), "Roofs Peterson");
    assert.equal(inboxkitWorkspaceForClient("Mike Trpkosh"), "BolderCyberPartners");
    assert.equal(inboxkitWorkspaceForClient("Myles McIntosh"), "EMCOR");
    assert.equal(inboxkitWorkspaceForClient("Randy Haba"), "Parlay");
    assert.equal(
      inboxkitWorkspaceForClient({ name: "Randy Haba", logo: "Parlay Tech" }),
      "Parlay",
    );
    assert.equal(
      inboxkitWorkspaceForClient({ name: "Kyle Peterson", logo: "Roofs by Peterson" }),
      "Roofs Peterson",
    );
    assert.deepEqual(
      SMARTLEAD_TO_INBOXKIT_WORKSPACE.map((row) => row.inboxkit),
      [
        "TechEvolution",
        "Roofs Peterson",
        "BolderCyberPartners",
        "EMCOR",
        "Parlay",
      ],
    );
  });

  it("counts active InboxKit Google vs Microsoft and ignores lapsed", () => {
    const split = countInboxkitEspSplit([
      { platform: "GOOGLE", status: "active" },
      { platform: "GOOGLE", status: "active" },
      { platform: "MICROSOFT", status: "active" },
      { platform: "MICROSOFT", status: "lapsed" },
      { platform: "GOOGLE", status: "cancelled" },
    ]);
    assert.equal(split.google, 2);
    assert.equal(split.microsoft, 1);
    assert.equal(split.total, 3);
    assert.equal(split.microsoftShare, 1 / 3);
  });

  it("caches Parlay 54%, EMCOR 60%, Peterson 35% Microsoft shares", () => {
    const cache = new InboxkitClientSplitCache();
    cache.seed([
      { workspace: "Parlay", google: 46, microsoft: 54 },
      { workspace: "EMCOR", google: 40, microsoft: 60 },
      { workspace: "Roofs Peterson", google: 65, microsoft: 35 },
    ]);
    assert.equal(cache.shareForClient("Randy Haba")?.toFixed(2), "0.54");
    assert.equal(cache.shareForClient("Myles McIntosh"), 0.6);
    assert.equal(cache.shareForClient("Kyle Peterson"), 0.35);
    assert.equal(cache.shareForClient("Unknown Client"), undefined);
  });
});
