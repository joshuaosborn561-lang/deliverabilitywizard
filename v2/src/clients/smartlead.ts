import { getJson } from "./http.js";
import type { SlimAccount, SlimCampaign } from "../types.js";

const BASE = "https://server.smartlead.ai/api/v1";

export class SmartleadReader {
  constructor(private readonly apiKey: string) {}

  private url(path: string, extra: Record<string, string> = {}): string {
    const u = new URL(`${BASE}/${path.replace(/^\//, "")}`);
    u.searchParams.set("api_key", this.apiKey);
    for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
    return u.toString();
  }

  async listCampaigns(): Promise<SlimCampaign[]> {
    const raw = await getJson<unknown>(this.url("campaigns"));
    const rows = Array.isArray(raw) ? raw : [];
    return rows.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        id: Number(r.id),
        name: String(r.name ?? ""),
        status: String(r.status ?? "").toUpperCase(),
        clientId: r.client_id == null ? null : Number(r.client_id),
        minTimeBtwnEmails:
          r.min_time_btwn_emails == null ? null : Number(r.min_time_btwn_emails),
      };
    });
  }

  async listAccounts(): Promise<SlimAccount[]> {
    const out: SlimAccount[] = [];
    for (let offset = 0; offset < 20000; offset += 100) {
      const raw = await getJson<unknown>(
        this.url("email-accounts", { offset: String(offset), limit: "100" }),
      );
      const rows = Array.isArray(raw)
        ? raw
        : Array.isArray((raw as { data?: unknown }).data)
          ? ((raw as { data: unknown[] }).data)
          : [];
      if (!rows.length) break;
      for (const row of rows) out.push(normalizeAccount(row as Record<string, unknown>));
      if (rows.length < 100) break;
    }
    return out;
  }
}

function normalizeAccount(r: Record<string, unknown>): SlimAccount {
  const tagsRaw = Array.isArray(r.tags) ? r.tags : [];
  const tags = tagsRaw.map((t) => {
    if (typeof t === "string") return t;
    const o = t as { tag_name?: string; name?: string };
    return String(o.tag_name ?? o.name ?? "");
  }).filter(Boolean);
  const campaigns = Array.isArray(r.campaigns) ? r.campaigns : [];
  const campaignIds = [
    ...((r.campaign_ids as number[] | undefined) ?? []),
    ...campaigns.map((c) => {
      const o = c as { id?: number; campaign_id?: number };
      return Number(o.id ?? o.campaign_id);
    }),
  ].filter((n) => Number.isFinite(n));
  const warmup = (r.warmup_details ?? {}) as Record<string, unknown>;
  const email = String(r.from_email ?? r.username ?? r.email ?? "").toLowerCase();
  return {
    id: Number(r.id),
    email,
    fromName: String(r.from_name ?? ""),
    clientId: r.client_id == null ? null : Number(r.client_id),
    campaignIds: [...new Set(campaignIds)],
    tags,
    smtpOk: r.is_smtp_success !== false,
    imapOk: r.is_imap_success !== false,
    messagePerDay:
      r.message_per_day == null && r.max_email_per_day == null
        ? null
        : Number(r.message_per_day ?? r.max_email_per_day),
    warmupBlocked: Boolean(warmup.is_warmup_blocked),
    createdAt: r.created_at ? String(r.created_at) : null,
    warmupStartedAt: warmup.created_at
      ? String(warmup.created_at)
      : warmup.warmup_created_at
        ? String(warmup.warmup_created_at)
        : null,
    signature: String(r.signature ?? r.email_signature ?? ""),
  };
}
