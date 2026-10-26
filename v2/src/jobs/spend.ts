import type { AppConfig } from "../config.js";
import { assertOneSentenceReason } from "../lib/retireReason.js";
import type { WriteGate } from "../shadow.js";
import type { IntendedAction } from "../types.js";

export interface SpendAsk {
  id: string;
  /** D303 — retire_mailbox retires one burned mailbox, never its domain. */
  kind: "buy_mailboxes" | "buy_domain" | "retire_domain" | "retire_mailbox";
  clientId?: number;
  amountUsd: number;
  payload: Record<string, unknown>;
}

/**
 * Job 7 — real-money spend is an intended action until a human approves
 * AND WRITE_ENABLED is on. Shadow never talks to Porkbun or InboxKit buy.
 * Canary/domain buys stay intended; real buys only at cutover.
 */
export async function intendSpend(
  ask: SpendAsk,
  gate: WriteGate,
  config: AppConfig,
): Promise<IntendedAction> {
  const payload = { ...ask.payload };
  if (ask.kind === "retire_domain" || ask.kind === "retire_mailbox") {
    payload.reason = assertOneSentenceReason(String(payload.reason ?? ""));
  }
  const result = await gate.intend({
    kind: "spend",
    payload: {
      ...payload,
      askId: ask.id,
      spendKind: ask.kind,
      clientId: ask.clientId,
      amountUsd: ask.amountUsd,
      requireSpendApproval: config.requireSpendApproval,
    },
    run: async () => {
      throw new Error("spend execute is not implemented in v2 until cutover");
    },
  });
  return result.action;
}
