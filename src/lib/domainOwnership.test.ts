import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../config.js";
import {
  resolveDomainOwner,
} from "./domainOwnership.js";
import {
  isClientSendingDomain,
  isForbiddenGenericReplacement,
  isGenericSendingDomain,
  replacementParentForRetiredDomain,
} from "./retireReplacement.js";

const goliath = { id: 548611, name: "Dave Ackley", logo: "Goliath Cybersecurity" };
const emcor = { id: 574020, name: "EMCOR", logo: "EMCOR" };
const techevo = { id: 521881, name: "TechEvolution", logo: "TechEvolution" };

function cfg() {
  return loadConfig({} as NodeJS.ProcessEnv);
}

describe("D173 — ownership-aware sending-domain classification", () => {
  it("a non-family domain staffed by client mailboxes is client-owned", () => {
    const config = cfg();
    const owner = resolveDomainOwner(
      "acmewidgets.info",
      [
        {
          from_email: "a@acmewidgets.info",
          client_id: 548611,
        },
        {
          from_email: "b@acmewidgets.info",
          client_id: 548611,
        },
      ],
      [goliath],
      config,
    );
    assert.equal(owner.kind, "client");
    assert.equal(owner.clientId, 548611);
    assert.match(owner.clientName ?? "", /Goliath/i);
    assert.equal(owner.planSaysGeneric, false);
    assert.equal(isGenericSendingDomain("acmewidgets.info", config, owner), false);
    assert.equal(isClientSendingDomain("acmewidgets.info", config, owner), true);
  });

  it("a plan-listed domain with no client mailboxes stays generic (plan fallback)", () => {
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

  it("a client-named domain's replacement is client-named, never crosslaunchco", () => {
    const config = cfg();
    const owner = resolveDomainOwner(
      "techevolutionusa.info",
      [{ from_email: "a@techevolutionusa.info", client_id: 521881 }],
      [techevo],
      config,
    );
    const parent = replacementParentForRetiredDomain(
      "techevolutionusa.info",
      config,
      { kind: "buy_domains", owner, requestedParent: config.isolationBuyParentDomain },
    );
    assert.match(parent, /techevolution/);
    assert.doesNotMatch(parent, /crosslaunchco/);
    assert.doesNotMatch(parent, /outreachdesk|meetconnect/);
  });
});

describe("D260 — generic-family assigned seats stay generic", () => {
  it("boxoutreachdesk.com assigned to EMCOR with GENERIC tags is generic", () => {
    const config = cfg();
    const owner = resolveDomainOwner(
      "boxoutreachdesk.com",
      [
        {
          from_email: "a@boxoutreachdesk.com",
          client_id: 574020,
          tags: [{ tag_name: "GENERIC" }],
        },
        {
          from_email: "b@boxoutreachdesk.com",
          client_id: 574020,
          tags: [{ tag_name: "GENERIC" }],
        },
      ],
      [emcor],
      config,
    );
    assert.equal(owner.kind, "generic");
    assert.equal(owner.clientId, null);
    assert.equal(isGenericSendingDomain("boxoutreachdesk.com", config, owner), true);
    assert.equal(isClientSendingDomain("boxoutreachdesk.com", config, owner), false);
    const parent = replacementParentForRetiredDomain(
      "boxoutreachdesk.com",
      config,
      { kind: "buy_domains", owner },
    );
    assert.equal(parent, config.isolationBuyParentDomain);
  });

  it("meetconnectbox.com assigned to EMCOR with GENERIC tags is generic", () => {
    const config = cfg();
    const owner = resolveDomainOwner(
      "meetconnectbox.com",
      [
        {
          from_email: "a@meetconnectbox.com",
          client_id: 574020,
          tags: [{ tag_name: "GENERIC" }],
        },
      ],
      [emcor],
      config,
    );
    assert.equal(owner.kind, "generic");
    assert.equal(isGenericSendingDomain("meetconnectbox.com", config, owner), true);
    assert.equal(isClientSendingDomain("meetconnectbox.com", config, owner), false);
    const parent = replacementParentForRetiredDomain(
      "meetconnectbox.com",
      config,
      { kind: "retire_domain", owner },
    );
    assert.equal(parent, config.isolationBuyParentDomain);
  });

  it("generic-family stays generic even when owner.kind is a stale client record", () => {
    const config = cfg();
    const stale = {
      kind: "client" as const,
      clientId: 574020,
      clientName: "EMCOR",
    };
    assert.equal(
      isGenericSendingDomain("boxoutreachdesk.com", config, stale),
      true,
    );
    assert.equal(
      isClientSendingDomain("boxoutreachdesk.com", config, stale),
      false,
    );
    assert.equal(
      replacementParentForRetiredDomain("boxoutreachdesk.com", config, {
        kind: "buy_domains",
        owner: stale,
      }),
      config.isolationBuyParentDomain,
    );
  });

  it("a client-named domain still refuses a generic parent (D161/D173)", () => {
    const config = cfg();
    const owner = resolveDomainOwner(
      "techevolutionusa.info",
      [
        {
          from_email: "a@techevolutionusa.info",
          client_id: 521881,
          tags: [{ tag_name: "GENERIC" }],
        },
      ],
      [techevo],
      config,
    );
    assert.equal(owner.kind, "client");
    assert.equal(isGenericSendingDomain("techevolutionusa.info", config, owner), false);
    assert.equal(isClientSendingDomain("techevolutionusa.info", config, owner), true);
    assert.equal(
      isForbiddenGenericReplacement(
        "techevolutionusa.info",
        "crosslaunchcotry.info",
        config,
        owner,
      ),
      true,
    );
    const parent = replacementParentForRetiredDomain(
      "techevolutionusa.info",
      config,
      {
        kind: "buy_domains",
        owner,
        requestedParent: config.isolationBuyParentDomain,
      },
    );
    assert.match(parent, /techevolution/);
    assert.doesNotMatch(parent, /crosslaunchco|outreachdesk|meetconnect/);
  });
});
