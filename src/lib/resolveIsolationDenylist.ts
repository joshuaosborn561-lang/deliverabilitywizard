import {
  isolationEmailsOf,
  isIsolationEmail,
  normalizeIsolationDomain,
} from "./isolationDomain.js";
import { accountEmail } from "../clients/smartlead.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { AppConfig } from "../config.js";

export async function resolveIsolationDenylist(
  config: Pick<
    AppConfig,
    "isolationDomain" | "isolationMailboxIds" | "isolationMailboxEmails"
  >,
  smartlead: Pick<SmartleadClient, "listAllEmailAccounts">,
  fallbackDomain?: string,
): Promise<{ accountIds: number[]; emails: string[]; domain?: string }> {
  const domain =
    normalizeIsolationDomain(config.isolationDomain) ||
    normalizeIsolationDomain(fallbackDomain ?? "");
  const emails = isolationEmailsOf(config.isolationMailboxEmails);
  const ids = new Set(config.isolationMailboxIds);

  if (domain || emails.size) {
    const accounts = await smartlead.listAllEmailAccounts().catch(() => []);
    for (const account of accounts) {
      const email = accountEmail(account);
      if (isIsolationEmail(email, { emails, domain })) {
        if (typeof account.id === "number") ids.add(account.id);
        if (email) emails.add(email.trim().toLowerCase());
      }
    }
  }

  return {
    accountIds: [...ids],
    emails: [...emails],
    domain,
  };
}
