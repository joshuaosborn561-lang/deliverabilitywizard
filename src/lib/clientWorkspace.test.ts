import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  expectedClientForDomain,
  matchRuleByDomain,
  matchRuleByWorkspaceName,
  matchSmartleadClient,
} from "./clientWorkspace.js";

const clients = [
  { id: 542838, name: "Mike Trpkosh (Bolder Cyber Partners)" },
  { id: 1, name: "Dave Ackley" },
  { id: 2, name: "Carlos Vasquez" },
  { id: 418275, name: "TJ Johnson" },
  { id: 418274, name: "Randy Haba" },
];

describe("client workspace map (D66)", () => {
  it("maps BCP domains and the BCP InboxKit workspace to Mike Trpkosh", () => {
    assert.equal(matchRuleByDomain("tryboldercyperpartner.info")?.key, "bcp");
    assert.equal(matchRuleByWorkspaceName("BolderCyberPartners")?.key, "bcp");
    assert.equal(expectedClientForDomain("tryboldercyperpartner.info", clients)?.id, 542838);
  });

  it("does not permanently tie a generic-pool workspace to a client", () => {
    assert.equal(matchRuleByWorkspaceName("DW Generic Pool")?.kind, "generic");
    assert.equal(expectedClientForDomain("labmeetconnect.info", clients), undefined);
  });

  it("matches Smartlead clients by name", () => {
    assert.equal(expectedClientForDomain("goliathcyber.info", clients)?.id, 1);
    assert.equal(expectedClientForDomain("hubvascowarranty.info", clients)?.id, 2);
    assert.equal(expectedClientForDomain("useculturefits.info", clients)?.id, 418275);
    assert.equal(expectedClientForDomain("nowparlay.info", clients)?.id, 418274);
  });
});
