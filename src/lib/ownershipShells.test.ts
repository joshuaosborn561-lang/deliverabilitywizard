import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { SmartleadClient } from "../clients/smartlead.js";
import { isAnyShellCampaign, liveCampaignIdFromCanaryShellName } from "./canaryShell.js";
import { campaignHasSendWindowRule } from "./campaignSendCanon.js";
import { campaignHasStep2DelayRule } from "./sequenceDelay.js";
import { seatSitsOnForeignNamedCampaign } from "./podOwnedInventory.js";
import { isExcluded } from "../services/campaignTopUp.js";
import {
  applyAccountOwnership,
  applyCampaignOwnership,
  applyCampaignOwnershipToList,
  cachedCampaignOwner,
  resetOwnershipForTests,
  resolveCampaignOwner,
  shellParentCampaignId,
} from "./ownership.js";

const tag = (name: string) => ({ tag_id: 1, tag_name: name, tag_color: "#000" });
const originalFetch = globalThis.fetch;
beforeEach(() => resetOwnershipForTests());
afterEach(() => {
  globalThis.fetch = originalFetch;
  resetOwnershipForTests();
});

type C = {
  id: number;
  name: string;
  status: string;
  client_id: number | null;
  tags?: ReturnType<typeof tag>[];
  owner_slug?: string | null;
  owner_client_id?: number | null;
  owner_reason?: string;
};

describe("D332 shells: owner attribution from tags", () => {
  it("parses the parent id exactly like canaryShell.liveCampaignIdFromCanaryShellName", () => {
    for (const name of [
      "Canary shell: #4456009 EMCOR | A",
      "canary shell:  #12",
      "Canary shell #12",
      "Canary shell: EMCOR",
      "Pod control shell",
      "BCP | A",
    ]) {
      assert.equal(shellParentCampaignId(name) ?? undefined, liveCampaignIdFromCanaryShellName(name), name);
    }
  });

  it("(1) a shell's own unique sg-owner tag attributes it", () => {
    const r = resolveCampaignOwner({ id: 5, name: "Pod control shell", client_id: null, tags: [tag("sg-owner:emcor")] });
    assert.deepEqual(r, { clientId: null, slug: "emcor", reason: "shell_sg_owner_tag", ownerClientId: 574020 });
  });

  it("(2) an untagged canary shell inherits its parent's tag from the same list (parent listed after the shell)", () => {
    const list: C[] = [
      { id: 9001, name: "Canary shell: #100 BCP | A", status: "PAUSED", client_id: null, tags: [] },
      { id: 100, name: "BCP | A", status: "ACTIVE", client_id: null, tags: [tag("sg-owner:bcp")] },
    ];
    applyCampaignOwnershipToList(list);
    assert.equal(list[1]!.client_id, 542838);
    assert.equal(list[0]!.client_id, null, "shell client_id stays null");
    assert.equal(list[0]!.owner_slug, "bcp");
    assert.equal(list[0]!.owner_client_id, 542838);
    assert.equal(list[0]!.owner_reason, "shell_parent_sg_owner_tag");
  });

  it("own tag beats a conflicting parent tag", () => {
    const list: C[] = [
      { id: 100, name: "BCP | A", status: "ACTIVE", client_id: null, tags: [tag("sg-owner:bcp")] },
      { id: 9001, name: "Canary shell: #100 BCP | A", status: "PAUSED", client_id: null, tags: [tag("sg-owner:goliath")] },
    ];
    applyCampaignOwnershipToList(list);
    assert.equal(list[1]!.owner_slug, "goliath");
    assert.equal(list[1]!.owner_client_id, 548611);
    assert.equal(list[1]!.client_id, null);
  });

  it("two distinct own sg-owner tags = ambiguous = unowned, and do not fall back to the parent", () => {
    const list: C[] = [
      { id: 100, name: "BCP | A", status: "ACTIVE", client_id: null, tags: [tag("sg-owner:bcp")] },
      {
        id: 9001,
        name: "Canary shell: #100 BCP | A",
        status: "PAUSED",
        client_id: null,
        tags: [tag("sg-owner:bcp"), tag("sg-owner:emcor")],
      },
    ];
    applyCampaignOwnershipToList(list);
    assert.equal(list[1]!.owner_slug, null);
    assert.equal(list[1]!.owner_client_id, null);
    assert.equal(list[1]!.owner_reason, "shell");
  });

  it("an ambiguous or untagged parent leaves the shell unowned", () => {
    const list: C[] = [
      { id: 100, name: "X | A", status: "ACTIVE", client_id: null, tags: [tag("sg-owner:bcp"), tag("sg-owner:emcor")] },
      { id: 101, name: "Y | A", status: "ACTIVE", client_id: null, tags: [] },
      { id: 9001, name: "Canary shell: #100 X", status: "PAUSED", client_id: null, tags: [] },
      { id: 9002, name: "Canary shell: #101 Y", status: "PAUSED", client_id: null, tags: [] },
    ];
    applyCampaignOwnershipToList(list);
    for (const shell of list.slice(2)) {
      assert.equal(shell.owner_slug, null);
      assert.equal(shell.owner_client_id, null);
      assert.equal(shell.client_id, null);
    }
  });

  it("no tag and no parent → unowned (word hunt shell, pod control shell)", () => {
    for (const name of ["DW Word Hunt Shell", "Pod control shell", "Canary shell: #777 gone"]) {
      const r = resolveCampaignOwner({ id: 1, name, client_id: null, tags: [] });
      assert.deepEqual(r, { clientId: null, slug: null, reason: "shell", ownerClientId: null }, name);
    }
  });

  it("a shell never takes a campaign-name guess or its own id as parent", () => {
    const r = resolveCampaignOwner(
      { id: 42, name: "Canary shell: #42 Emcor", client_id: null, tags: [] },
      { parentSlug: () => "emcor" },
    );
    assert.equal(r.slug, null);
  });

  it("a parent tagged with a slug that never had a space attributes the slug with a null owner id", () => {
    const list: C[] = [
      { id: 100, name: "Vasco | A", status: "ACTIVE", client_id: null, tags: [tag("sg-owner:vasco")] },
      { id: 9001, name: "Canary shell: #100 Vasco", status: "PAUSED", client_id: null, tags: [] },
    ];
    applyCampaignOwnershipToList(list);
    assert.equal(list[1]!.owner_slug, "vasco");
    assert.equal(list[1]!.owner_client_id, null);
  });

  it("getCampaign on a shell falls back to the parent seen on the last list", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      const body =
        calls === 1
          ? [{ id: 100, name: "Nexus | A", status: "ACTIVE", client_id: null, tags: [tag("sg-owner:nexus")] }]
          : { id: 9001, name: "Canary shell: #100 Nexus", status: "PAUSED", client_id: null, tags: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const client = new SmartleadClient("k");
    await client.listCampaigns();
    const shell = await client.getCampaign(9001);
    assert.equal(shell.client_id, null);
    assert.equal(shell.owner_slug, "nexus");
    assert.equal(shell.owner_client_id, 607522);
  });

  it("a client-scoped list still never returns shells", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify([
          { id: 100, name: "BCP | A", status: "ACTIVE", client_id: null, tags: [tag("sg-owner:bcp")] },
          { id: 9001, name: "Canary shell: #100 BCP", status: "PAUSED", client_id: null, tags: [tag("sg-owner:bcp")] },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    const bcp = await new SmartleadClient("k").listCampaigns(542838);
    assert.deepEqual(bcp.map((c) => c.id), [100]);
  });
});

describe("D332 shells: still excluded from everything that treats them as client campaigns", () => {
  const attributedShell = (): C => {
    const list: C[] = [
      { id: 100, name: "BCP | A", status: "ACTIVE", client_id: null, tags: [tag("sg-owner:bcp")] },
      { id: 9001, name: "Canary shell: #100 BCP | A", status: "ACTIVE", client_id: null, tags: [tag("sg-owner:bcp")] },
    ];
    applyCampaignOwnershipToList(list);
    return list[1]!;
  };

  it("send / staff / top-up predicates still skip an attributed shell", () => {
    const shell = attributedShell();
    assert.equal(shell.owner_slug, "bcp");
    assert.equal(isAnyShellCampaign(shell), true);
    assert.equal(campaignHasSendWindowRule(shell), false);
    assert.equal(campaignHasStep2DelayRule(shell), false);
    assert.equal(isExcluded(shell, []), true);
    assert.equal(
      seatSitsOnForeignNamedCampaign({
        campaignIds: [9001],
        ownerClientId: 418274,
        campaignById: new Map([[9001, shell]]),
      }),
      false,
      "a seat on a BCP-attributed shell is not a borrowed seat on a BCP campaign",
    );
  });

  it("the client_id every consumer keys by stays null, and mailbox inference ignores shells", () => {
    const shell = attributedShell();
    assert.equal(shell.client_id, null);
    assert.equal(cachedCampaignOwner(9001), null);
    const box = applyAccountOwnership({ id: 999_111_222, client_id: null, tags: [], campaign_ids: [9001] });
    assert.equal(box.client_id, null, "a mailbox only on an attributed shell stays unassigned");
    const real = applyAccountOwnership({ id: 999_111_223, client_id: null, tags: [], campaign_ids: [9001, 100] });
    assert.equal(real.client_id, 542838);
  });

  it("applyCampaignOwnership on a single shell is idempotent", () => {
    const shell = attributedShell();
    applyCampaignOwnership(shell);
    applyCampaignOwnership(shell);
    assert.equal(shell.client_id, null);
    assert.equal(shell.owner_slug, "bcp");
  });
});
