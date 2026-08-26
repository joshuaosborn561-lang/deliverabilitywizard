/**
 * Isolation-domain mailboxes exist only to send SmartDelivery tests.
 * They must never join a production campaign (D48).
 */

export class IsolationAttachBlockedError extends Error {
  readonly blockedIds: number[];

  constructor(blockedIds: number[]) {
    super(
      `Isolation-domain mailboxes cannot be attached to a campaign: ${blockedIds.join(",")}`,
    );
    this.name = "IsolationAttachBlockedError";
    this.blockedIds = blockedIds;
  }
}

export interface IsolationDenylist {
  accountIds: Set<number>;
  emails: Set<string>;
  domain: string | undefined;
}

export function normalizeIsolationDomain(domain: string | undefined): string | undefined {
  const trimmed = domain?.trim().toLowerCase().replace(/^@/, "");
  return trimmed || undefined;
}

export function isolationEmailsOf(emails: string[]): Set<string> {
  return new Set(
    emails.map((email) => email.trim().toLowerCase()).filter(Boolean),
  );
}

export function isIsolationEmail(
  email: string | undefined,
  denylist: Pick<IsolationDenylist, "emails" | "domain">,
): boolean {
  const normalized = email?.trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) return false;
  if (denylist.emails.has(normalized)) return true;
  if (!denylist.domain) return false;
  return normalized.endsWith(`@${denylist.domain}`);
}

export function isIsolationAccountId(
  accountId: number,
  denylist: Pick<IsolationDenylist, "accountIds">,
): boolean {
  return denylist.accountIds.has(accountId);
}

export function assertNotIsolationAccountIds(
  accountIds: number[],
  denylist: Pick<IsolationDenylist, "accountIds">,
): void {
  const blocked = accountIds.filter((id) => denylist.accountIds.has(id));
  if (blocked.length) throw new IsolationAttachBlockedError(blocked);
}

export function emailDomainOf(email: string | undefined): string | undefined {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return undefined;
  const at = normalized.lastIndexOf("@");
  if (at < 0 || at === normalized.length - 1) return undefined;
  return normalized.slice(at + 1);
}
