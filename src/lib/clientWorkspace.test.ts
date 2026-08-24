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
  { id: 1, name: "Goliath Cybersecurity (Dave Ackley)" },
  { id: 2, name: "Vasco Warranty" },
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
    assert.equal(matchSmartleadClient(clients, /goliath/i)?.id, 1);
    assert.equal(matchSmartleadClient(clients, /vasco/i)?.id, 2);
  });
});
