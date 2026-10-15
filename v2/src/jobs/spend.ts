import type { AppConfig } from "../config.js";
import type { WriteGate } from "../shadow.js";
import type { IntendedAction } from "../types.js";

export interface SpendAsk {
  id: string;
  kind: "buy_mailboxes" | "buy_domain" | "retire_domain";
  clientId?: number;
  amountUsd: number;
  payload: Record<string, unknown>;
}

/**
 * Job 7 — real-money spend is an intended action until a human approves
 * AND WRITE_ENABLED is on. Shadow never talks to Porkbun or InboxKit buy.
 */
export async function intendSpend(
  ask: SpendAsk,
  gate: WriteGate,
  config: AppConfig,
): Promise<IntendedAction> {
  const result = await gate.intend({
    kind: "spend",
    payload: {
      ...ask.payload,
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
