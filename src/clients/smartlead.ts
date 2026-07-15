import { apiRequest } from "../lib/http.js";
import type {
  SmartleadCampaign,
  SmartleadEmailAccount,
  SmartleadSequence,
} from "../types/index.js";

const BASE_URL = "https://server.smartlead.ai/api/v1/";

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
}

export function extractSenderEmails(accounts: SmartleadEmailAccount[]): string[] {
  const emails: string[] = [];
  for (const account of accounts) {
    const email =
      account.from_email?.trim() ||
      account.email?.trim() ||
      account.username?.trim();
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

export function sequenceSubjectPreview(sequence: SmartleadSequence): string {
  const variant =
    sequence.sequence_variants?.[0] ?? sequence.variants?.[0] ?? undefined;
  return (
    sequence.subject?.trim() ||
    variant?.subject?.trim() ||
    `(sequence #${sequence.seq_number})`
  );
}
