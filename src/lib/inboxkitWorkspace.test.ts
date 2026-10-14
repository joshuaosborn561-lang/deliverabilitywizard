import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mailboxOrderFollowup,
  pickReplacementWorkspace,
} from "./inboxkitWorkspace.js";

const GENERIC = "81e7f800-4203-4892-a40d-18648b89b90c";

describe("D266 — client InboxKit workspace + mailbox wording", () => {
  it("a client cover buy uses the client's workspace, never the generic pool", () => {
    const pick = pickReplacementWorkspace({
      ownerKind: "client",
      ownerClientName: "BCP",
      sourceDomainWorkspaceId: "ws-bcp",
      sourceDomainWorkspaceName: "Bolder Cyper Partner",
      genericPoolWorkspaceId: GENERIC,
      workspaces: [
        { uid: GENERIC, name: "DW Generic Pool" },
        { uid: "ws-bcp", name: "Bolder Cyper Partner" },
      ],
    });
    assert.equal(pick.workspaceId, "ws-bcp");
    assert.equal(pick.generic, false);
  });

  it("matches a workspace by client name when the source domain is unknown", () => {
    const pick = pickReplacementWorkspace({
      ownerKind: "client",
      ownerClientName: "TechEvo",
      genericPoolWorkspaceId: GENERIC,
      workspaces: [
        { uid: GENERIC, name: "DW Generic Pool" },
        { uid: "ws-te", name: "TechEvolution" },
      ],
    });
    assert.equal(pick.workspaceId, "ws-te");
  });

  it("refuses to fall through to the generic pool for a named client", () => {
    const pick = pickReplacementWorkspace({
      ownerKind: "client",
      ownerClientName: "BCP",
      genericPoolWorkspaceId: GENERIC,
      workspaces: [{ uid: GENERIC, name: "DW Generic Pool" }],
    });
    assert.equal(pick.workspaceId, undefined);
    assert.equal(pick.generic, false);
    assert.match(pick.reason, /will not buy into the generic pool/);
  });

  it("generic/pool domains still use the generic-pool workspace", () => {
    const pick = pickReplacementWorkspace({
      ownerKind: "generic",
      genericPoolWorkspaceId: GENERIC,
    });
    assert.equal(pick.workspaceId, GENERIC);
    assert.equal(pick.generic, true);
  });

  it("does not say I will finish the mailbox order when it already finished", () => {
    assert.equal(
      mailboxOrderFollowup({ mailboxesOrdered: 3, awaitingNameservers: false }),
      undefined,
    );
    assert.match(
      mailboxOrderFollowup({ mailboxesOrdered: 0, awaitingNameservers: true }) ??
        "",
      /I will finish the mailbox order myself/,
    );
  });
});
