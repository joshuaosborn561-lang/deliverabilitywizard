import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import {
  resolveDomainOwner,
} from "./domainOwnership.js";
import {
  isClientSendingDomain,
  isGenericSendingDomain,
  replacementParentForRetiredDomain,
} from "./retireReplacement.js";

const goliath = { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" };

function cfg() {
  return loadConfig({} as NodeJS.ProcessEnv);
}

describe("D173 — ownership-aware sending-domain classification", () => {
  it("a plan-listed domain staffed by client mailboxes is client-owned", () => {
    const config = cfg();
    const owner = resolveDomainOwner(
      "nowoutreachdesk.com",
      [
        {
          from_email: "a@nowoutreachdesk.com",
          client_id: 548611,
        },
        {
          from_email: "b@nowoutreachdesk.com",
          client_id: 548611,
        },
      ],
      [goliath],
      config,
    );
    assert.equal(owner.kind, "client");
    assert.equal(owner.clientId, 548611);
    assert.match(owner.clientName ?? "", /Goliath/i);
    assert.equal(owner.planSaysGeneric, true);
    assert.equal(owner.conflict, true);
    assert.equal(isGenericSendingDomain("nowoutreachdesk.com", config, owner), false);
    assert.equal(isClientSendingDomain("nowoutreachdesk.com", config, owner), true);
  });

  it("the same domain with no client mailboxes stays generic (plan fallback)", () => {
    const config = cfg();
    const owner = resolveDomainOwner(
      "nowoutreachdesk.com",
      [{ from_email: "a@nowoutreachdesk.com" }],
      [goliath],
      config,
    );
    assert.equal(owner.kind, "generic");
    assert.equal(owner.clientId, null);
    assert.equal(isGenericSendingDomain("nowoutreachdesk.com", config, owner), true);
  });

  it("a client-owned pool domain's replacement is client-named, never crosslaunchco", () => {
    const config = cfg();
    const owner = resolveDomainOwner(
      "meetconnectapp.com",
      [{ from_email: "a@meetconnectapp.com", client_id: 548611 }],
      [goliath],
      config,
    );
    const parent = replacementParentForRetiredDomain(
      "meetconnectapp.com",
      config,
      { kind: "buy_domains", owner },
    );
    assert.match(parent, /goliath/);
    assert.doesNotMatch(parent, /crosslaunchco/);
    assert.doesNotMatch(parent, /meetconnect/);
  });
});
