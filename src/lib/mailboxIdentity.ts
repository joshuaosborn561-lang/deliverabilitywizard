/**
 * Match a Smartlead account against a configured identifier list.
 *
 * Entries may be full email addresses or a person's display name
 * (e.g. "harmony norris"), because hand-bought mailboxes are usually known by
 * the name on them rather than the address.
 */
export function matchesMailboxIdentity(
  account: { from_email?: string; email?: string; username?: string; from_name?: string },
  identifiers: string[],
): boolean {
  if (!identifiers.length) return false;
  const email = String(account.from_email ?? account.email ?? account.username ?? "")
    .trim()
    .toLowerCase();
  const fromName = String(account.from_name ?? "").trim().toLowerCase();

  return identifiers.some((raw) => {
    const id = raw.trim().toLowerCase();
    if (!id) return false;
    if (email && id === email) return true;
    if (fromName && id === fromName) return true;
    return false;
  });
}
