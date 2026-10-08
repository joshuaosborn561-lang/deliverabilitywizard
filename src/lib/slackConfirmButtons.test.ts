import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isolationAskNeedsConfirm,
  isolationBlockActionShouldDecide,
  isolationNativeButton,
  slackConfirmDialog,
} from "./slackConfirmButtons.js";

describe("D248 — native confirm buttons, never url+action", () => {
  it("Retire / Buy Approve requires a Slack confirm dialog and never a url", () => {
    for (const kind of ["retire_domain", "buy_domains", "buy_canary_fleet"] as const) {
      assert.equal(isolationAskNeedsConfirm(kind, "approve"), true);
      const confirm = slackConfirmDialog({
        kind,
        decision: "approve",
        label: kind === "retire_domain" ? "Retire this domain" : "Buy replacements",
      });
      assert.ok(confirm, `${kind} Approve must have a confirm dialog`);
      assert.match(String((confirm.text as { text?: string }).text), /spends real money/);

      const button = isolationNativeButton({
        label: "Retire this domain",
        actionId: "isolation_approve",
        value: `${kind}:id-1:approve`,
        kind,
        decision: "approve",
        style: "primary",
      });
      assert.equal(button.type, "button");
      assert.equal(button.action_id, "isolation_approve");
      assert.ok(button.confirm, `${kind} button must carry Slack confirm`);
      assert.equal(
        "url" in button,
        false,
        "a single tap on a url button would decide and open the confirm page (D248)",
      );
    }
  });

  it("Not now / swap_copy do not need a spend confirm", () => {
    assert.equal(isolationAskNeedsConfirm("retire_domain", "deny"), false);
    assert.equal(isolationAskNeedsConfirm("swap_copy", "approve"), false);
    const deny = isolationNativeButton({
      label: "Not now",
      actionId: "isolation_deny",
      value: "retire_domain:id-1:deny",
      kind: "retire_domain",
      decision: "deny",
    });
    assert.equal(deny.confirm, undefined);
    assert.equal("url" in deny, false);
  });

  it("a leftover url button click must not decide (so one tap cannot spend)", () => {
    const leftover = isolationBlockActionShouldDecide({
      action_id: "isolation_approve",
      value: "retire_domain:id-1:approve",
      url: "https://example.test/slack/action?id=id-1&decision=approve",
    });
    assert.equal(leftover.decide, false);
    assert.equal(leftover.reason, "url_button");

    const confirmed = isolationBlockActionShouldDecide({
      action_id: "isolation_approve",
      value: "buy_domains:id-2:approve",
    });
    assert.equal(confirmed.decide, true);
    assert.equal(confirmed.reason, "native");
  });
});
