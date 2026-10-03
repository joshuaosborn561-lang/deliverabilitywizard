import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StateStore } from "../state/store.js";
import { accountOnBounceHold } from "./bounceHold.js";
import { classifyBounceText } from "./bounceReason.js";
import {
  TENANT_OUTBOUND_BLOCK_MPD,
  TENANT_OUTBOUND_BLOCK_SEEDS,
  accountOnTenantOutboundHold,
  healTenantOutboundBlockSeeds,
  maybeNotifyTenantOutboundBlock,
  tenantOutboundBlockAlertText,
} from "./tenantOutboundBlock.js";

describe("D213 tenant outbound-block hold", () => {
  const seed = TENANT_OUTBOUND_BLOCK_SEEDS[0]!;
  const afterRestore = new Date("2026-10-01T00:20:00.000Z");

  it("classifies the live AS(42004) NDR as tenant_outbound_block", () => {
    assert.equal(
      classifyBounceText(
        "550 5.1.8 Access denied, bad outbound sender AS(42004)",
      ),
      "tenant_outbound_block",
    );
    assert.equal(TENANT_OUTBOUND_BLOCK_MPD, 0);
    assert.deepEqual(seed.accountIds, [
      21831478, 21831477, 21831461, 21831401, 21831312,
    ]);
    assert.equal(seed.tenant, "arborbrooksagesunsetxcom.onmicrosoft.com");
    assert.deepEqual([...seed.domains], ["appquickconnectsales.com"]);
  });

  it("seeds the five ids and survives the 7:15pm bounce-hold prune", async () => {
    const state = new StateStore(
      `/tmp/dw-tob-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    const healed = healTenantOutboundBlockSeeds(state);
    assert.equal(healed.wrote, true);
    assert.ok(state.isTenantOutboundBlockAccount(21831478));
    assert.ok(state.isTenantOutboundBlockDomain("appquickconnectsales.com"));
    assert.ok(
      state.isTenantOutboundBlockDomain(
        "arborbrooksagesunsetxcom.onmicrosoft.com",
      ),
    );

    state.ensureBounceHold([21831478], new Date("2026-09-30T14:00:00.000Z"));
    state.pruneBounceHold(afterRestore);
    assert.equal(
      state.isBounceHoldAccount(21831478, afterRestore),
      true,
      "D218: TERRL hold ids are not cleared at 7:15pm CT",
    );
    assert.ok(state.isTenantOutboundBlockAccount(21831478));
    assert.equal(
      accountOnBounceHold(
        {
          id: 21831478,
          type: "OUTLOOK",
          from_email: "angelatran@appquickconnectsales.com",
          message_per_day: 0,
        },
        state,
        afterRestore,
      ),
      true,
      "D183 must not write 15 after 7:15pm while the tenant hold is live",
    );
    assert.equal(
      accountOnTenantOutboundHold(
        { from_email: "newseat@appquickconnectsales.com" },
        state,
      ),
      true,
      "every seat on the sending domain is held",
    );
  });

  it("pages Watchdog once, then stays silent until a human clears", async () => {
    const state = new StateStore(
      `/tmp/dw-tob-slack-${process.pid}-${Date.now()}.json`,
    );
    await state.load();
    healTenantOutboundBlockSeeds(state);
    const pages: string[] = [];
    const slack = {
      notifyWatchdogTenantBlock: async (text: string) => {
        pages.push(text);
      },
    };
    assert.equal(await maybeNotifyTenantOutboundBlock({ store: state, slack }), true);
    assert.equal(pages.length, 1);
    assert.match(pages[0]!, /delist or replacement/);
    assert.match(pages[0]!, /arborbrooksagesunsetxcom\.onmicrosoft\.com/);
    assert.equal(await maybeNotifyTenantOutboundBlock({ store: state, slack }), false);
    assert.equal(pages.length, 1);

    assert.equal(
      state.clearTenantOutboundBlock("appquickconnectsales.com"),
      true,
    );
    assert.equal(state.isTenantOutboundBlockAccount(21831478), false);
    assert.match(
      tenantOutboundBlockAlertText({
        tenant: seed.tenant,
        domains: [...seed.domains],
        accountIds: [...seed.accountIds],
      }),
      /21831478/,
    );
  });
});
