import { postJson } from "./http.js";

export interface InboxkitMailbox {
  email: string;
  status: string;
  scheduledForCancellation?: boolean;
  cancelDate?: string | null;
  renewalDate?: string | null;
  /** D303 — InboxKit platform (GOOGLE / MICROSOFT …) for the ESP-mix share. */
  platform?: string | null;
}

const INBOXKIT_BASE = "https://api.inboxkit.com";
const INBOXKIT_PAGE_SIZE = 200;
const INBOXKIT_MAX_PAGES = 20;

/**
 * Read-only InboxKit client. D298: the old `GET /v1/mailboxes` path 404s;
 * InboxKit lists via `POST /v1/api/mailboxes/list` (a read) scoped by the
 * `X-Workspace-Id` header, same as the old wizard's client.
 */
export class InboxkitReader {
  constructor(
    private readonly apiKey: string,
    private readonly workspaceId?: string,
    private readonly post: typeof postJson = postJson,
  ) {}

  private headers(ws?: string): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      // Cloudflare on api.inboxkit.com blocks empty/bot UAs from some hosts.
      "User-Agent": "DeliverabilityWizardV2/1.0 (+railway)",
    };
    if (ws) h["X-Workspace-Id"] = ws;
    return h;
  }

  async resolveWorkspaceId(signal?: AbortSignal): Promise<string> {
    if (this.workspaceId) return this.workspaceId;
    const raw = await this.post<unknown>(`${INBOXKIT_BASE}/v1/api/workspaces/list`, {}, this.headers(), signal);
    const first = inboxkitList(raw, ["workspaces", "result", "data", "items"])[0] as
      | Record<string, unknown>
      | undefined;
    const id = first?.uid ?? first?.id;
    if (!id) throw new Error("InboxKit: no workspaces found for this API key");
    return String(id);
  }

  async listMailboxes(signal?: AbortSignal): Promise<InboxkitMailbox[]> {
    if (!this.apiKey) return [];
    const ws = await this.resolveWorkspaceId(signal);
    const out: InboxkitMailbox[] = [];
    for (let page = 1; page <= INBOXKIT_MAX_PAGES; page += 1) {
      const raw = await this.post<unknown>(
        `${INBOXKIT_BASE}/v1/api/mailboxes/list`,
        { page, limit: INBOXKIT_PAGE_SIZE },
        this.headers(ws),
        signal,
      );
      const rows = inboxkitList(raw, ["mailboxes", "result", "data", "items"]);
      out.push(...rows.map((row) => normalizeInboxkitMailbox(row as Record<string, unknown>)));
      if (rows.length < INBOXKIT_PAGE_SIZE) break;
    }
    return out;
  }
}

export function inboxkitList(raw: unknown, keys: string[]): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const key of keys) {
      const value = obj[key];
      if (Array.isArray(value)) return value;
      if (value && typeof value === "object") {
        const nested = value as Record<string, unknown>;
        for (const k2 of ["items", "data", "results", "rows", "mailboxes", "workspaces"]) {
          if (Array.isArray(nested[k2])) return nested[k2] as unknown[];
        }
      }
    }
  }
  return [];
}

export function normalizeInboxkitMailbox(o: Record<string, unknown>): InboxkitMailbox {
  const username = String(o.username ?? "");
  const domain = String(o.domain_name ?? o.domain ?? "");
  const email = String(o.email ?? (username && domain ? `${username}@${domain}` : "")).toLowerCase();
  return {
    email,
    status: String(o.status ?? "").toLowerCase(),
    scheduledForCancellation: Boolean(o.scheduled_for_cancellation),
    cancelDate: o.cancel_date ? String(o.cancel_date) : o.cancellation_date ? String(o.cancellation_date) : null,
    renewalDate: o.renewal_date ? String(o.renewal_date) : null,
    platform: o.platform != null ? String(o.platform) : o.provider != null ? String(o.provider) : null,
  };
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
