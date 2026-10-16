import { getJson } from "./http.js";

export interface InboxkitMailbox {
  email: string;
  status: string;
  scheduledForCancellation?: boolean;
  cancelDate?: string | null;
  renewalDate?: string | null;
}

export class InboxkitReader {
  constructor(
    private readonly apiKey: string,
    private readonly workspaceId?: string,
  ) {}

  async listMailboxes(): Promise<InboxkitMailbox[]> {
    if (!this.apiKey) return [];
    const url = this.workspaceId
      ? `https://api.inboxkit.com/v1/workspaces/${this.workspaceId}/mailboxes`
      : "https://api.inboxkit.com/v1/mailboxes";
    const raw = await getJson<unknown>(url, { Authorization: `Bearer ${this.apiKey}` });
    const rows = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as { data?: unknown }).data)
        ? ((raw as { data: unknown[] }).data)
        : [];
    return rows.map((row) => {
      const o = row as Record<string, unknown>;
      const username = String(o.username ?? "");
      const domain = String(o.domain_name ?? o.domain ?? "");
      const email = String(o.email ?? (username && domain ? `${username}@${domain}` : "")).toLowerCase();
      return {
        email,
        status: String(o.status ?? "").toLowerCase(),
        scheduledForCancellation: Boolean(o.scheduled_for_cancellation),
        cancelDate: o.cancel_date ? String(o.cancel_date) : o.cancellation_date ? String(o.cancellation_date) : null,
        renewalDate: o.renewal_date ? String(o.renewal_date) : null,
      };
    });
  }
}

/** D245 — lapsed / cancelled / inactive, or scheduled_for_cancellation on or before today CT. */
export function isLapsedSeat(
  row: InboxkitMailbox,
  todayCtYmd: string,
): boolean {
  const status = row.status.toLowerCase();
  if (status === "lapsed" || status === "cancelled" || status === "inactive") return true;
  if (row.scheduledForCancellation && row.cancelDate && row.cancelDate.slice(0, 10) <= todayCtYmd) {
    return true;
  }
  return false;
}

export function chicagoYmd(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
