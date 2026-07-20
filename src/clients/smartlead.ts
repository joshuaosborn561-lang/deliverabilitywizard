import { apiRequest, sleep } from "../lib/http.js";
import type {
  SmartleadCampaign,
  SmartleadEmailAccount,
  SmartleadSequence,
} from "../types/index.js";

const BASE_URL = "https://server.smartlead.ai/api/v1/";

export interface SmartleadAccountWithCampaigns extends SmartleadEmailAccount {
  campaign_ids?: number[];
  campaigns?: Array<{ id?: number; campaign_id?: number; status?: string; name?: string }>;
}

export class SmartleadClient {
  constructor(private readonly apiKey: string) {}

  listCampaigns(clientId?: number): Promise<SmartleadCampaign[]> {
    return apiRequest<SmartleadCampaign[]>(BASE_URL, this.apiKey, "campaigns/", {
      query: clientId === undefined ? undefined : { client_id: clientId },
    });
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

  getCampaignSequences(campaignId: number): Promise<SmartleadSequence[]> {
    return apiRequest<SmartleadSequence[]>(
      BASE_URL,
      this.apiKey,
      `campaigns/${campaignId}/sequences`,
    );
  }

  async listAllEmailAccounts(options: {
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
      await sleep(150);
    }
    return out;
  }

  removeEmailAccountsFromCampaign(
    campaignId: number,
    emailAccountIds: number[],
  ): Promise<unknown> {
    return apiRequest(BASE_URL, this.apiKey, `campaigns/${campaignId}/email-accounts`, {
      method: "DELETE",
      body: { email_account_ids: emailAccountIds },
    });
  }

  deleteEmailAccount(emailAccountId: number): Promise<unknown> {
    return apiRequest(BASE_URL, this.apiKey, `email-accounts/${emailAccountId}`, {
      method: "DELETE",
    });
  }

  updateCampaignStatus(
    campaignId: number,
    status: "START" | "PAUSED" | "STOPPED",
  ): Promise<unknown> {
    return apiRequest(BASE_URL, this.apiKey, `campaigns/${campaignId}/status`, {
      method: "PATCH",
      body: { status },
    });
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
    return apiRequest(
      BASE_URL,
      this.apiKey,
      `email-accounts/${emailAccountId}/warmup`,
      { method: "POST", body: settings },
    );
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
