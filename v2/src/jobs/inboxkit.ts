import { chicagoYmd, isLapsedSeat, type InboxkitMailbox } from "../clients/inboxkit.js";
import type { WriteGate } from "../shadow.js";
import type { Finding, IntendedAction, SlimAccount } from "../types.js";

export async function runInboxkitSweep(opts: {
  seats: InboxkitMailbox[];
  accounts: SlimAccount[];
  gate: WriteGate;
  now?: Date;
}): Promise<{ findings: Finding[]; intended: IntendedAction[]; deleted: number }> {
  const today = chicagoYmd(opts.now);
  const findings: Finding[] = [];
  const intended: IntendedAction[] = [];
  let deleted = 0;
  const byEmail = new Map(opts.accounts.map((a) => [a.email.toLowerCase(), a]));

  for (const seat of opts.seats) {
    if (!seat.email || !isLapsedSeat(seat, today)) continue;
    const account = byEmail.get(seat.email);
    findings.push({
      kind: "inboxkit_lapsed",
      accountId: account?.id,
      email: seat.email,
      detail: `${seat.email} InboxKit ${seat.status} cancel=${seat.cancelDate ?? "n/a"}`,
    });
    intended.push(
      (
        await opts.gate.intend({
          kind: "smartlead_delete",
          accountId: account?.id,
          email: seat.email,
          payload: { reason: "lapsed", status: seat.status },
          run: async () => undefined,
        })
      ).action,
    );
    intended.push(
      (
        await opts.gate.intend({
          kind: "inboxkit_delete",
          accountId: account?.id,
          email: seat.email,
          payload: { reason: "lapsed", status: seat.status },
          run: async () => undefined,
        })
      ).action,
    );
    deleted += 1;
  }

  if (deleted > 0) {
    intended.push(
      (
        await opts.gate.intend({
          kind: "slack",
          payload: {
            text: `Found ${deleted} inboxes that had lapsed; they're deleted from Smartlead and InboxKit.`,
          },
          run: async () => undefined,
        })
      ).action,
    );
  }

  return { findings, intended, deleted };
}
