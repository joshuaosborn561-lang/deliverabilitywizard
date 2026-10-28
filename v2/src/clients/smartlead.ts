import { V2_SMARTLEAD_PAGE_DELAY_MS, V2_STAFF_ACCOUNT_PAGE_CAP } from "../canon/constants.js";
import { getJson, type ScheduleFn } from "./http.js";
import { abortableSleep, throwIfAborted } from "../lib/tickClock.js";
import { dedupeById } from "../lib/inventory.js";
import type { SequenceSample, SlimAccount, SlimCampaign, SlimClient } from "../types.js";

const BASE = "https://server.smartlead.ai/api/v1";

export type ReaderProgress = (info: {
  step: string;
  page?: number;
  offset?: number;
  id?: number;
  n?: number;
  truncated?: boolean;
}) => void;

export class SmartleadReader {
  constructor(
    private readonly apiKey: string,
    private readonly schedule: ScheduleFn = (fn) => fn(),
    private readonly pageDelayMs = V2_SMARTLEAD_PAGE_DELAY_MS,
  ) {}

  private url(path: string, extra: Record<string, string> = {}): string {
    const u = new URL(`${BASE}/${path.replace(/^\//, "")}`);
    u.searchParams.set("api_key", this.apiKey);
    for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
    return u.toString();
  }

  /** GET client/ — read-only; brand line for mailbox signatures (old wizard parity). */
  async listClients(signal?: AbortSignal): Promise<SlimClient[]> {
    const raw = await this.schedule(() => getJson<unknown>(this.url("client/"), {}, signal), signal);
    const rows = Array.isArray(raw) ? raw : [];
    return rows
      .map((row) => row as Record<string, unknown>)
      .filter((r) => r.id != null && Number.isFinite(Number(r.id)))
      .map((r) => ({
        id: Number(r.id),
        name: r.name == null ? null : String(r.name),
        logo: r.logo == null ? null : String(r.logo),
      }));
  }

  async listCampaigns(signal?: AbortSignal): Promise<SlimCampaign[]> {
    const raw = await this.schedule(
      () => getJson<unknown>(this.url("campaigns"), {}, signal),
      signal,
    );
    const rows = Array.isArray(raw) ? raw : [];
    return dedupeById(rows.map((row) => normalizeCampaign(row as Record<string, unknown>)));
  }

  async listAccounts(
    opts: { signal?: AbortSignal; maxPages?: number; onProgress?: ReaderProgress } = {},
  ): Promise<SlimAccount[]> {
    const maxPages = opts.maxPages ?? V2_STAFF_ACCOUNT_PAGE_CAP;
    const out: SlimAccount[] = [];
    try {
      for (let page = 0, offset = 0; page < maxPages; page += 1, offset += 100) {
        throwIfAborted(opts.signal, "list_accounts");
        opts.onProgress?.({ step: "list_accounts", page: page + 1, offset });
        const raw = await this.schedule(
          () =>
            getJson<unknown>(
              this.url("email-accounts", {
                offset: String(offset),
                limit: "100",
                fetch_campaigns: "true",
              }),
              {},
              opts.signal,
            ),
          opts.signal,
        );
        const rows = Array.isArray(raw)
          ? raw
          : Array.isArray((raw as { data?: unknown }).data)
            ? ((raw as { data: unknown[] }).data)
            : [];
        if (!rows.length) break;
        for (const row of rows) out.push(normalizeAccount(row as Record<string, unknown>));
        if (opts.signal?.aborted) {
          opts.onProgress?.({ step: "list_accounts", truncated: true, n: out.length });
          return dedupeById(out);
        }
        if (rows.length < 100) break;
        if (page + 1 >= maxPages) {
          opts.onProgress?.({
            step: "list_accounts",
            page: page + 1,
            offset,
            truncated: true,
          });
          break;
        }
        if (this.pageDelayMs > 0) await abortableSleep(this.pageDelayMs, opts.signal);
      }
    } catch (error) {
      if (out.length && opts.signal?.aborted) {
        opts.onProgress?.({ step: "list_accounts", truncated: true, n: out.length });
        return dedupeById(out);
      }
      throw error;
    }
    return dedupeById(out);
  }

  async listCampaignAccounts(campaignId: number, signal?: AbortSignal): Promise<SlimAccount[]> {
    const raw = await this.schedule(
      () => getJson<unknown>(this.url(`campaigns/${campaignId}/email-accounts`), {}, signal),
      signal,
    );
    const rows = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as { data?: unknown }).data)
        ? ((raw as { data: unknown[] }).data)
        : [];
    return dedupeById(rows.map((row) => normalizeAccount(row as Record<string, unknown>)));
  }

  async listSequences(campaignId: number, signal?: AbortSignal): Promise<SequenceSample[]> {
    const raw = await this.schedule(
      () => getJson<unknown>(this.url(`campaigns/${campaignId}/sequences`), {}, signal),
      signal,
    );
    const rows = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as { sequences?: unknown }).sequences)
        ? ((raw as { sequences: unknown[] }).sequences)
        : [];
    return rows.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        campaignId,
        body: String(r.email_body ?? r.sequence_body ?? r.body ?? ""),
        seqNumber:
          r.seq_number == null || r.seq_number === ""
            ? null
            : Number(r.seq_number),
        delayInDays:
          r.seq_delay_details == null && r.delay_in_days == null
            ? null
            : Number(
                (r.seq_delay_details as { delay_in_days?: number } | undefined)?.delay_in_days ??
                  r.delay_in_days,
              ),
      };
    });
  }
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((v) => String(v)).filter(Boolean);
}

function asNumberArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((v) => Number(v)).filter((n) => Number.isFinite(n));
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nestedSchedule(r: Record<string, unknown>): Record<string, unknown> {
  const cron = asObject(r.scheduler_cron_value);
  const schedule = asObject(r.schedule);
  return { ...cron, ...schedule };
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (value == null || value === "") continue;
    return String(value);
  }
  return null;
}

export function normalizeCampaign(r: Record<string, unknown>): SlimCampaign {
  const schedule = nestedSchedule(r);
  const track = asStringArray(r.track_settings) ?? asStringArray(r.trackSettings);
  const days =
    asNumberArray(r.days_of_the_week) ??
    asNumberArray(schedule.days_of_the_week) ??
    asNumberArray(schedule.daysOfTheWeek) ??
    asNumberArray(schedule.days);
  return {
    id: Number(r.id),
    name: String(r.name ?? ""),
    status: String(r.status ?? "").toUpperCase(),
    clientId: r.client_id == null ? null : Number(r.client_id),
    minTimeBtwnEmails:
      r.min_time_btwn_emails == null && schedule.min_time_btw_emails == null
        ? null
        : Number(r.min_time_btwn_emails ?? schedule.min_time_btw_emails),
    enableAiEspMatching:
      r.enable_ai_esp_matching == null ? null : Boolean(r.enable_ai_esp_matching),
    sendAsPlainText: r.send_as_plain_text == null ? null : Boolean(r.send_as_plain_text),
    trackSettings: track,
    timezone: firstString(r.timezone, schedule.timezone, schedule.tz),
    daysOfTheWeek: days,
    startHour: firstString(r.start_hour, schedule.start_hour, schedule.startHour),
    endHour: firstString(r.end_hour, schedule.end_hour, schedule.endHour),
    maxLeadsPerDay:
      r.max_leads_per_day == null && schedule.max_leads_per_day == null
        ? null
        : Number(r.max_leads_per_day ?? schedule.max_leads_per_day),
  };
}

function normalizeAccount(r: Record<string, unknown>): SlimAccount {
  const tagsRaw = Array.isArray(r.tags) ? r.tags : [];
  const tags = tagsRaw.map((t) => {
    if (typeof t === "string") return t;
    const o = t as { tag_name?: string; name?: string };
    return String(o.tag_name ?? o.name ?? "");
  }).filter(Boolean);
  const campaignIds = campaignIdsFromAccount(r);
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

function campaignIdsFromAccount(r: Record<string, unknown>): number[] {
  const ids: number[] = [];
  const push = (value: unknown) => {
    if (value == null) return;
    if (typeof value === "object") {
      const o = value as { id?: unknown; campaign_id?: unknown };
      push(o.id ?? o.campaign_id);
      return;
    }
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) ids.push(n);
  };
  const raw = r.campaign_ids ?? r.campaignIds;
  if (Array.isArray(raw)) {
    for (const value of raw) push(value);
  } else {
    push(raw);
  }
  const campaigns = Array.isArray(r.campaigns) ? r.campaigns : [];
  for (const row of campaigns) push(row);
  return [...new Set(ids)];
}
