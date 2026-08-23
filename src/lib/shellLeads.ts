/** How many pre-warmed fleet addresses we plant as shell leads, per domain. */
export const SHELL_LEADS_PER_DOMAIN = 2;

export interface ShellLead {
  email: string;
  first_name: string;
  last_name: string;
}

/**
 * D57 — pick a tiny set of pre-warmed fleet inboxes to use as Smartlead
 * leads on the paused pod-control shell. Recipients only; never live
 * campaigns. Stable: keep existing picks that are still eligible.
 */
export function pickShellLeadEmails(input: {
  extraGenericDomains: string[];
  candidates: string[];
  existing?: string[];
  perDomain?: number;
}): string[] {
  const perDomain = input.perDomain ?? SHELL_LEADS_PER_DOMAIN;
  const domains = new Set(
    input.extraGenericDomains.map((domain) => domain.trim().toLowerCase()).filter(Boolean),
  );
  const eligible = [
    ...new Set(
      input.candidates
        .map((email) => email.trim().toLowerCase())
        .filter((email) => {
          const domain = email.split("@")[1] ?? "";
          return email.includes("@") && domains.has(domain);
        }),
    ),
  ].sort();

  const byDomain = new Map<string, string[]>();
  for (const email of eligible) {
    const domain = email.split("@")[1] ?? "";
    const list = byDomain.get(domain) ?? [];
    list.push(email);
    byDomain.set(domain, list);
  }

  const picked: string[] = [];
  const seen = new Set<string>();
  const existing = (input.existing ?? [])
    .map((email) => email.trim().toLowerCase())
    .filter((email) => eligible.includes(email));

  for (const email of existing) {
    const domain = email.split("@")[1] ?? "";
    const already = picked.filter((row) => row.endsWith(`@${domain}`)).length;
    if (already >= perDomain) continue;
    picked.push(email);
    seen.add(email);
  }

  for (const domain of [...domains].sort()) {
    const have = picked.filter((email) => email.endsWith(`@${domain}`)).length;
    const needed = perDomain - have;
    if (needed <= 0) continue;
    for (const email of byDomain.get(domain) ?? []) {
      if (seen.has(email)) continue;
      picked.push(email);
      seen.add(email);
      if (picked.filter((row) => row.endsWith(`@${domain}`)).length >= perDomain) {
        break;
      }
    }
  }

  return picked;
}

export function shellLeadRecords(emails: string[]): ShellLead[] {
  return emails.map((email) => {
    const local = email.split("@")[0] ?? "lead";
    const parts = local.split(/[._-]+/).filter(Boolean);
    const first = titleCase(parts[0] || "Lead");
    const last = titleCase(parts.slice(1).join(" ") || "Inbox");
    return { email, first_name: first, last_name: last };
  });
}

export function emailsFromLeadList(raw: unknown): string[] {
  const rows = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? ((raw as { data?: unknown }).data as unknown[]) ??
        ((raw as { leads?: unknown }).leads as unknown[]) ??
        ((raw as { lead_list?: unknown }).lead_list as unknown[]) ??
        []
      : [];
  const out: string[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const obj = row as Record<string, unknown>;
    const nested =
      obj.lead && typeof obj.lead === "object"
        ? (obj.lead as Record<string, unknown>)
        : obj;
    const email = [nested.email, nested.lead_email, obj.email]
      .find((value) => typeof value === "string" && value.includes("@"));
    if (typeof email === "string") out.push(email.trim().toLowerCase());
  }
  return [...new Set(out)];
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}
