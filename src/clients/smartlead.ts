import { apiRequest, sleep } from "../lib/http.js";
import type { MutationQueue } from "../lib/mutationQueue.js";
import { assertNotIsolationAccountIds } from "../lib/isolationDomain.js";
import { sequencesForWrite } from "../lib/signatureQa.js";
import type {
  SmartleadCampaign,
  SmartleadEmailAccount,
  SmartleadSequence,
} from "../types/index.js";

const BASE_URL = "https://server.smartlead.ai/api/v1/";

export interface SmartleadAccountWithCampaigns extends SmartleadEmailAccount {
  campaign_ids?: number[];
  client_id?: number | null;
  campaigns?: Array<{ id?: number; campaign_id?: number; status?: string; name?: string }>;
}

/** Subset of `campaigns/{id}/analytics-by-date` we rely on. */
export interface SmartleadCampaignAnalytics {
  sent_count?: number | string;
  bounce_count?: number | string;
  reply_count?: number | string;
}

export interface SmartleadClientRecord {
  id: number;
  name?: string;
  email?: string;
  logo?: string | null;
  uuid?: string;
}

export class SmartleadClient {
  private mutationQueue: MutationQueue | null = null;
  private isolationAccountIds = new Set<number>();

  constructor(private readonly apiKey: string) {}

  /** D48 — isolation-domain mailbox IDs may never join a campaign. */
  setIsolationDenylist(accountIds: number[]): void {
    this.isolationAccountIds = new Set(
      accountIds.filter((id) => Number.isFinite(id) && id > 0),
    );
  }

  isolationDenylistIds(): number[] {
    return [...this.isolationAccountIds];
  }

  /**
   * Serialiser for Smartlead reads AND writes. Inventory fetches (the 429
   * source) share the same gap as mutations so overlapping boot kicks and
   * the 15-minute sweep cannot stampede the key (D89).
   */
  setMutationQueue(queue: MutationQueue | null): void {
    this.mutationQueue = queue;
  }

  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    return this.mutationQueue ? this.mutationQueue.enqueue(fn) : fn();
  }

  listCampaigns(clientId?: number): Promise<SmartleadCampaign[]> {
    return this.mutate(() =>
      apiRequest<SmartleadCampaign[]>(BASE_URL, this.apiKey, "campaigns/", {
        query: clientId === undefined ? undefined : { client_id: clientId },
      }),
    );
  }

  /**
   * Per-sender bounce / health metrics (sent, opened, replied, bounced).
   *
   * Placement tests cannot see bounce against real leads — seed inboxes
   * accept mail — so remediation uses this independent signal. The official
   * path is `analytics/mailbox/name-wise-health-metrics`; the older
   * `analytics/overview` alias 404s on current Smartlead API versions.
   *
   * Defaults to an inclusive trailing 30-day window (Smartlead's typical
   * analytics max span) and `full_data=true` so we get every mailbox, not a
   * truncated page. Caller parses the envelope defensively.
   */
  async getMailboxHealthMetrics(
    options: {
      startDate?: string;
      endDate?: string;
      fullData?: boolean;
    } = {},
  ): Promise<unknown> {
    const endDate =
      options.endDate ?? new Date().toISOString().slice(0, 10);
    let startDate = options.startDate;
    if (!startDate) {
      const start = new Date(`${endDate}T00:00:00.000Z`);
      start.setUTCDate(start.getUTCDate() - 29);
      startDate = start.toISOString().slice(0, 10);
    }
    // full_data across a large fleet regularly exceeds the default 60s HTTP
    // budget and used to surface as opaque "This operation was aborted".
    // Give the analytics scrape three minutes and one retry.
    return apiRequest<unknown>(
      BASE_URL,
      this.apiKey,
      "analytics/mailbox/name-wise-health-metrics",
      {
        query: {
          start_date: startDate,
          end_date: endDate,
          ...(options.fullData === false ? {} : { full_data: "true" }),
        },
        timeoutMs: 180_000,
        retries: 1,
      },
    );
  }

  listClients(): Promise<SmartleadClientRecord[]> {
    return this.mutate(() =>
      apiRequest<SmartleadClientRecord[]>(BASE_URL, this.apiKey, "client/"),
    );
  }

  getCampaign(campaignId: number): Promise<SmartleadCampaign> {
    return apiRequest<SmartleadCampaign>(
      BASE_URL,
      this.apiKey,
      `campaigns/${campaignId}`,
    );
  }

  getCampaignEmailAccounts(campaignId: number): Promise<SmartleadEmailAccount[]> {
    return apiRequest<SmartleadEmailAccount[]>(
      BASE_URL,
      this.apiKey,
      `campaigns/${campaignId}/email-accounts`,
    );
  }

  getEmailAccount(
    emailAccountId: number,
    options: { fetchCampaigns?: boolean } = {},
  ): Promise<SmartleadAccountWithCampaigns> {
    return apiRequest<SmartleadAccountWithCampaigns>(
      BASE_URL,
      this.apiKey,
      `email-accounts/${emailAccountId}`,
      {
        query: options.fetchCampaigns ? { fetch_campaigns: true } : undefined,
      },
    );
  }

  /**
   * Sent/bounce/reply counts for one campaign over a date window.
   *
   * Smartlead has no account-wide volume endpoint, so a fleet total means one
   * call per campaign. Callers should filter to ACTIVE first and pace the
   * loop — see SendVolumeService.
   */
  getCampaignAnalyticsByDate(
    campaignId: number,
    startDate: string,
    endDate: string,
  ): Promise<SmartleadCampaignAnalytics> {
    return apiRequest<SmartleadCampaignAnalytics>(
      BASE_URL,
      this.apiKey,
      `campaigns/${campaignId}/analytics-by-date`,
      { query: { start_date: startDate, end_date: endDate } },
    );
  }

  getCampaignSequences(campaignId: number): Promise<SmartleadSequence[]> {
    return apiRequest<SmartleadSequence[]>(
      BASE_URL,
      this.apiKey,
      `campaigns/${campaignId}/sequences`,
    );
  }

  /**
   * Write sequence steps/variants. Only used after a human approves a
   * one-word copy swap (D49).
   */
  updateCampaignSequences(
    campaignId: number,
    sequences: SmartleadSequence[],
  ): Promise<unknown> {
    return this.mutate(() =>
      apiRequest(BASE_URL, this.apiKey, `campaigns/${campaignId}/sequences`, {
        method: "POST",
        body: { sequences: sequencesForWrite(sequences) },
      }),
    );
  }

  async listAllEmailAccounts(options: {
    fetchCampaigns?: boolean;
  } = {}): Promise<SmartleadAccountWithCampaigns[]> {
    return this.mutate(() => this.listAllEmailAccountsUnqueued(options));
  }

  private async listAllEmailAccountsUnqueued(options: {
    fetchCampaigns?: boolean;
  } = {}): Promise<SmartleadAccountWithCampaigns[]> {
    const out: SmartleadAccountWithCampaigns[] = [];
    let offset = 0;
    const limit = 100;
    for (;;) {
      const page = await apiRequest<SmartleadAccountWithCampaigns[]>(
        BASE_URL,
        this.apiKey,
        "email-accounts/",
        {
          query: {
            offset,
            limit,
            ...(options.fetchCampaigns ? { fetch_campaigns: true } : {}),
          },
        },
      );
      const rows = Array.isArray(page) ? page : [];
      out.push(...rows);
      if (rows.length < limit) break;
      offset += limit;
      await sleep(400);
    }
    return out;
  }

  removeEmailAccountsFromCampaign(
    campaignId: number,
    emailAccountIds: number[],
  ): Promise<unknown> {
    return this.mutate(() =>
      apiRequest(BASE_URL, this.apiKey, `campaigns/${campaignId}/email-accounts`, {
        method: "DELETE",
        body: { email_account_ids: emailAccountIds },
      }),
    );
  }

  /**
   * D115 / D118 — instrumentation only. Canary shells need one dummy
   * lead before SmartDelivery will schedule. Never call this for a
   * live client campaign (D52).
   */
  addLeadsToCampaign(
    campaignId: number,
    leadList: Array<{
      email: string;
      first_name?: string;
      last_name?: string;
    }>,
  ): Promise<{
    added_count?: number;
    skipped_count?: number;
    skipped_leads?: unknown;
    upload_count?: number;
    already_added_to_campaign?: number;
    total_leads?: number | string;
    lead_ids?: number[];
    success?: boolean;
  }> {
    return this.mutate(() =>
      apiRequest(BASE_URL, this.apiKey, `campaigns/${campaignId}/leads`, {
        method: "POST",
        body: {
          lead_list: leadList,
          settings: {
            ignore_duplicate_leads_in_other_campaign: true,
            ignore_global_block_list: true,
            ignore_unsubscribe_list: true,
            ignore_community_bounce_list: true,
            return_lead_ids: true,
          },
        },
      }),
    );
  }

  getCampaignLeads(
    campaignId: number,
    query: { limit?: number; offset?: number } = {},
  ): Promise<unknown> {
    return apiRequest(BASE_URL, this.apiKey, `campaigns/${campaignId}/leads`, {
      query: {
        limit: query.limit ?? 1,
        offset: query.offset ?? 0,
      },
    });
  }

  addEmailAccountsToCampaign(
    campaignId: number,
    emailAccountIds: number[],
  ): Promise<unknown> {
    try {
      assertNotIsolationAccountIds(emailAccountIds, {
        accountIds: this.isolationAccountIds,
      });
    } catch (error) {
      return Promise.reject(error);
    }
    return this.mutate(() =>
      apiRequest(BASE_URL, this.apiKey, `campaigns/${campaignId}/email-accounts`, {
        method: "POST",
        body: { email_account_ids: emailAccountIds },
      }),
    );
  }

  getCampaignStatistics(campaignId: number): Promise<unknown> {
    return apiRequest(BASE_URL, this.apiKey, `campaigns/${campaignId}/statistics`);
  }

  getCampaignSettings(campaignId: number): Promise<unknown> {
    return apiRequest(BASE_URL, this.apiKey, `campaigns/${campaignId}/settings`);
  }

  updateCampaignSettings(
    campaignId: number,
    settings: Record<string, unknown>,
  ): Promise<unknown> {
    return this.mutate(() =>
      apiRequest(BASE_URL, this.apiKey, `campaigns/${campaignId}/settings`, {
        method: "POST",
        body: settings,
      }),
    );
  }

  /** D77 — assign the Smartlead client tag on a campaign. */
  setCampaignClientId(campaignId: number, clientId: number): Promise<unknown> {
    return this.updateCampaignSettings(campaignId, { client_id: clientId });
  }

  getDayWiseOverallStats(options: {
    startDate: string;
    endDate: string;
  }): Promise<unknown> {
    return apiRequest(BASE_URL, this.apiKey, "analytics/day-wise-overall-stats", {
      query: { start_date: options.startDate, end_date: options.endDate },
    });
  }

  getDayWisePositiveReplyStats(options: {
    startDate: string;
    endDate: string;
  }): Promise<unknown> {
    return apiRequest(
      BASE_URL,
      this.apiKey,
      "analytics/day-wise-positive-reply-stats",
      { query: { start_date: options.startDate, end_date: options.endDate } },
    );
  }

  getDomainWiseHealthMetrics(options: {
    startDate: string;
    endDate: string;
  }): Promise<unknown> {
    return apiRequest(
      BASE_URL,
      this.apiKey,
      "analytics/mailbox/domain-wise-health-metrics",
      { query: { start_date: options.startDate, end_date: options.endDate } },
    );
  }

  deleteEmailAccount(emailAccountId: number): Promise<unknown> {
    return this.mutate(() =>
      apiRequest(BASE_URL, this.apiKey, `email-accounts/${emailAccountId}`, {
        method: "DELETE",
      }),
    );
  }

  createCampaign(name: string): Promise<unknown> {
    return this.mutate(() =>
      apiRequest(BASE_URL, this.apiKey, "campaigns/create", {
        method: "POST",
        body: { name },
      }),
    );
  }

  updateCampaignStatus(
    campaignId: number,
    status: "START" | "PAUSED" | "STOPPED",
  ): Promise<unknown> {
    return this.mutate(() =>
      apiRequest(BASE_URL, this.apiKey, `campaigns/${campaignId}/status`, {
        method: "POST",
        body: { status },
      }),
    );
  }

  deleteCampaign(campaignId: number): Promise<unknown> {
    return this.mutate(() =>
      apiRequest(BASE_URL, this.apiKey, `campaigns/${campaignId}`, {
        method: "DELETE",
      }),
    );
  }

  /**
   * Daily sending ceiling for a mailbox.
   *
   * Written as `max_email_per_day` (POST); Smartlead rejects `message_per_day`
   * on write but returns the value as `message_per_day` on read. This is the
   * UI field "Message Per Day (Warmups not included)" — warmup volume is a
   * separate field (`warmup_max_count`).
   */
  setDailySendLimit(
    emailAccountId: number,
    maxEmailPerDay: number,
  ): Promise<unknown> {
    return this.mutate(() =>
      apiRequest(
        BASE_URL,
        this.apiKey,
        `email-accounts/${emailAccountId}`,
        { method: "POST", body: { max_email_per_day: maxEmailPerDay } },
      ),
    );
  }

  configureWarmup(
    emailAccountId: number,
    settings: {
      warmup_enabled: boolean;
      total_warmup_per_day: number;
      daily_rampup: number;
      reply_rate_percentage: number;
    },
  ): Promise<unknown> {
    return this.mutate(() =>
      apiRequest(
        BASE_URL,
        this.apiKey,
        `email-accounts/${emailAccountId}/warmup`,
        { method: "POST", body: settings },
      ),
    );
  }

  /**
   * Update email account fields (signature, from_name, send gap, etc.).
   * Used by recovery-pool swaps and mailbox settings converge.
   * Write `time_to_wait_in_mins`; list responses expose `minTimeToWaitInMins`.
   */
  updateEmailAccount(
    emailAccountId: number,
    fields: {
      signature?: string;
      from_name?: string;
      client_id?: number | null;
      max_email_per_day?: number;
      time_to_wait_in_mins?: number;
    },
  ): Promise<unknown> {
    return this.mutate(() =>
      apiRequest(
        BASE_URL,
        this.apiKey,
        `email-accounts/${emailAccountId}`,
        { method: "POST", body: fields },
      ),
    );
  }

  /**
   * Re-authenticate / reconnect a disconnected Gmail or Outlook account.
   * Smartlead: POST /email-accounts/{id}/reauth
   */
  reauthEmailAccount(emailAccountId: number): Promise<{
    ok?: boolean;
    reauthenticated?: boolean;
    skipped?: boolean;
    message?: string;
    provider?: string;
    emailAccountId?: number;
  }> {
    return this.mutate(() =>
      apiRequest(
        BASE_URL,
        this.apiKey,
        `email-accounts/${emailAccountId}/reauth`,
        { method: "POST", body: {} },
      ),
    );
  }

  listTags(): Promise<Array<{ id: number; name: string; color?: string }>> {
    return apiRequest(BASE_URL, this.apiKey, "email-accounts/tags");
  }

  createTag(
    name: string,
    color = "#FF8A65",
  ): Promise<{ ok?: boolean; data?: { id: number; name: string; color?: string } }> {
    return apiRequest(BASE_URL, this.apiKey, "tags", {
      method: "POST",
      body: { name, color },
    });
  }

  /**
   * Assign tags to email accounts (max 25 accounts per call).
   */
  assignTags(emailAccountIds: number[], tagIds: number[]): Promise<unknown> {
    return apiRequest(BASE_URL, this.apiKey, "email-accounts/tag-mapping", {
      method: "POST",
      body: { email_account_ids: emailAccountIds, tag_ids: tagIds },
    });
  }

  /** Remove tag associations from email accounts (does not delete the tags). */
  removeTags(emailAccountIds: number[], tagIds: number[]): Promise<unknown> {
    return apiRequest(BASE_URL, this.apiKey, "email-accounts/tag-mapping", {
      method: "DELETE",
      body: { email_account_ids: emailAccountIds, tag_ids: tagIds },
    });
  }

  /** Ensure a named tag exists and return its id (create with color if not). */
  async ensureTag(name: string, color: string): Promise<{ id: number; name: string }> {
    const existing = await this.listTags();
    const match = existing.find(
      (t) => t.name.trim().toUpperCase() === name.toUpperCase(),
    );
    if (match) return { id: match.id, name: match.name };
    const created = await this.createTag(name, color);
    const id = created.data?.id;
    if (!id) {
      throw new Error(`Could not create tag ${name}`);
    }
    return { id, name };
  }

  /**
   * Ensure a HOLD-UNTIL-YYYY-MM-DD tag exists and return its id.
   */
  async ensureHoldUntilTag(holdUntilIsoDate: string): Promise<{
    id: number;
    name: string;
  }> {
    const name = `HOLD-UNTIL-${holdUntilIsoDate}`;
    const existing = await this.listTags();
    const match = existing.find(
      (t) => t.name.trim().toUpperCase() === name.toUpperCase(),
    );
    if (match) return { id: match.id, name: match.name };

    const created = await this.createTag(name, "#FF8A65");
    const id = created.data?.id;
    if (!id) {
      // Race: another process may have created it
      const again = await this.listTags();
      const retry = again.find(
        (t) => t.name.trim().toUpperCase() === name.toUpperCase(),
      );
      if (retry) return { id: retry.id, name: retry.name };
      throw new Error(`Failed to create Smartlead tag ${name}`);
    }
    return { id, name };
  }
}

export function accountEmail(account: SmartleadEmailAccount): string | undefined {
  return (
    account.from_email?.trim() ||
    account.email?.trim() ||
    account.username?.trim() ||
    undefined
  );
}

export function accountDomain(account: SmartleadEmailAccount): string | undefined {
  const email = accountEmail(account);
  if (!email) return undefined;
  const at = email.lastIndexOf("@");
  if (at < 0) return undefined;
  return email.slice(at + 1).toLowerCase();
}

export function campaignIdsOf(account: SmartleadAccountWithCampaigns): number[] {
  if (Array.isArray(account.campaign_ids) && account.campaign_ids.length) {
    return account.campaign_ids.filter((n) => Number.isFinite(n));
  }
  if (Array.isArray(account.campaigns)) {
    return account.campaigns
      .map((c) => c.id ?? c.campaign_id)
      .filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  }
  return [];
}

export function clientDisplayName(client?: {
  name?: string | null;
  logo?: string | null;
  id?: number;
}): string {
  const logo = client?.logo?.trim();
  const name = client?.name?.trim();
  if (logo && name && logo.toLowerCase() !== name.toLowerCase()) {
    return `${logo} (${name})`;
  }
  return logo || name || (client?.id ? `Client ${client.id}` : "Unassigned / Agency");
}

/**
 * Resolve which Smartlead client owns an email account via account.client_id
 * or any linked campaign's client_id.
 */
export function resolveAccountClient(
  account: SmartleadAccountWithCampaigns,
  campaignClientById: Map<number, number | null | undefined>,
  clientsById: Map<number, SmartleadClientRecord>,
): { clientId: number | null; clientName: string } {
  const direct =
    typeof account.client_id === "number" && Number.isFinite(account.client_id)
      ? account.client_id
      : null;
  if (direct != null) {
    return {
      clientId: direct,
      clientName: clientDisplayName(clientsById.get(direct) ?? { id: direct }),
    };
  }

  for (const campaignId of campaignIdsOf(account)) {
    const cid = campaignClientById.get(campaignId);
    if (typeof cid === "number" && Number.isFinite(cid)) {
      return {
        clientId: cid,
        clientName: clientDisplayName(clientsById.get(cid) ?? { id: cid }),
      };
    }
  }

  return { clientId: null, clientName: "Unassigned / Agency" };
}

export function extractSenderEmails(
  accounts: Array<SmartleadEmailAccount | Record<string, unknown>>,
): string[] {
  const emails: string[] = [];
  for (const account of accounts) {
    const nested =
      (account as { email_account?: SmartleadEmailAccount }).email_account ??
      account;
    const row = nested as SmartleadEmailAccount;
    const email =
      row.from_email?.trim() ||
      row.email?.trim() ||
      row.username?.trim() ||
      (typeof (account as { fromEmail?: string }).fromEmail === "string"
        ? (account as { fromEmail?: string }).fromEmail!.trim()
        : undefined);
    if (email) emails.push(email);
  }
  return emails;
}

export function pickSequence(
  sequences: SmartleadSequence[],
  sequenceNumber: number,
): SmartleadSequence | undefined {
  if (!sequences.length) return undefined;
  const byNumber = sequences.find((s) => s.seq_number === sequenceNumber);
  if (byNumber) return byNumber;
  return [...sequences].sort((a, b) => a.seq_number - b.seq_number)[0];
}

/** Prefer sequence id; fall back to first variant id (API accepts either). */
export function sequenceMappingIdOf(sequence: SmartleadSequence): number | undefined {
  if (typeof sequence.id === "number" && sequence.id > 0) return sequence.id;
  const variant =
    sequence.sequence_variants?.find((v) => typeof v.id === "number") ??
    sequence.variants?.find((v) => typeof v.id === "number");
  return typeof variant?.id === "number" ? variant.id : undefined;
}

export function sequenceSubjectPreview(sequence: SmartleadSequence): string {
  const variant =
    sequence.sequence_variants?.[0] ?? sequence.variants?.[0] ?? undefined;
  return (
    sequence.subject?.trim() ||
    variant?.subject?.trim() ||
    `(sequence #${sequence.seq_number})`
  );
}
