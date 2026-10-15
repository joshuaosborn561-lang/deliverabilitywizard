import type { WriteGate } from "../shadow.js";
import type { Finding, IntendedAction, SlimAccount } from "../types.js";

/** D94 — disconnected SMTP/IMAP is an intended reconnect. Shadow never POSTs /reauth. */
export function needsReconnect(account: SlimAccount): boolean {
  return account.smtpOk === false || account.imapOk === false;
}

export async function runReconnectTick(opts: {
  accounts: SlimAccount[];
  gate: WriteGate;
}): Promise<{ findings: Finding[]; intended: IntendedAction[]; scanned: number; disconnected: number }> {
  const findings: Finding[] = [];
  const intended: IntendedAction[] = [];
  let disconnected = 0;
  for (const account of opts.accounts) {
    if (!needsReconnect(account)) continue;
    disconnected += 1;
    const parts = [
      account.smtpOk === false ? "SMTP" : null,
      account.imapOk === false ? "IMAP" : null,
    ].filter(Boolean);
    findings.push({
      kind: "smtp_imap_disconnected",
      accountId: account.id,
      email: account.email,
      detail: `${account.email} ${parts.join("/")} disconnected`,
    });
    intended.push(
      (
        await opts.gate.intend({
          kind: "reconnect",
          accountId: account.id,
          email: account.email,
          payload: {
            smtpOk: account.smtpOk,
            imapOk: account.imapOk,
            reason: "dcd_mailbox",
          },
          run: async () => undefined,
        })
      ).action,
    );
  }
  return { findings, intended, scanned: opts.accounts.length, disconnected };
}
