import {
  pickSequence,
  sequenceMappingIdOf,
  type SmartleadClient,
} from "../clients/smartlead.js";
import { chunkArray, sleep } from "../lib/http.js";
import {
  CANARY_SHELL_SEED_EMAIL,
  canaryShellName,
  isCanaryShellCampaign,
  liveCampaignIdFromCanaryShellName,
  shellLeadCount,
  shellLeadImportAccepted,
} from "../lib/canaryShell.js";
import { campaignIdFromCreate } from "../lib/podControlShell.js";
import type { SmartleadCampaign, SmartleadSequence } from "../types/index.js";

const WRITE_GAP_MS = process.env.NODE_TEST_CONTEXT ? 0 : 200;

export interface CanaryShellResult {
  campaignId: number;
  sequenceMappingId: number;
  created: boolean;
  attached: number;
}

/**
 * D114 — one paused shell per live campaign. SmartDelivery will only
 * schedule a test whose senders sit on the campaign_id we send. Canaries
 * stay off the live campaign (D55) and sit here instead.
 */
export async function ensureCanaryShell(input: {
  smartlead: SmartleadClient;
  campaigns: SmartleadCampaign[];
  live: SmartleadCampaign;
  subject: string;
  bodyHtml: string;
  senderAccountIds: number[];
  /** D118 — optional override; default is the non-sender instrumentation address. */
  seedEmail?: string;
  dryRun?: boolean;
  sequenceNumber?: number;
}): Promise<CanaryShellResult> {
  const wanted = canaryShellName(input.live.id, input.live.name);
  let campaign =
    input.campaigns.find(
      (row) => liveCampaignIdFromCanaryShellName(row.name) === input.live.id,
    ) ??
    input.campaigns.find((row) => String(row.name ?? "").trim() === wanted);
  let created = false;

  if (!campaign) {
    if (input.dryRun) {
      throw new Error(
        `Canary shell for #${input.live.id} is missing — create it before scheduling.`,
      );
    }
    const raw = await input.smartlead.createCampaign(wanted);
    const id = campaignIdFromCreate(raw);
    if (id == null) {
      throw new Error(
        `Smartlead did not return an id for canary shell #${input.live.id}.`,
      );
    }
    campaign = { id, name: wanted, status: "PAUSED" };
    input.campaigns.push(campaign);
    created = true;
    await sleep(WRITE_GAP_MS);
  }

  if (!isCanaryShellCampaign(campaign)) {
    throw new Error(
      `#${campaign.id} ${campaign.name} is not a canary shell — refuse to reuse it.`,
    );
  }
  if (isActiveCampaign(campaign)) {
    throw new Error(
      `Canary shell #${campaign.id} is ACTIVE — refuse to hang tests on a live campaign.`,
    );
  }
  // D118 — seed a non-sender contact, then pause. D117's fleet
  // inbox was a sending account and Smartlead reported added=0.
  if (!input.dryRun) {
    await writeLiveCopy(input, campaign.id);
    await seedShellLead(
      input.smartlead,
      campaign.id,
      input.seedEmail || CANARY_SHELL_SEED_EMAIL,
    );
  }
  if (!input.dryRun && String(campaign.status ?? "").toUpperCase() !== "PAUSED") {
    await input.smartlead.updateCampaignStatus(campaign.id, "PAUSED");
    campaign.status = "PAUSED";
    await sleep(WRITE_GAP_MS);
  }

  const sequences = await input.smartlead.getCampaignSequences(campaign.id);
  const sequence = pickSequence(sequences ?? [], input.sequenceNumber ?? 1);
  const sequenceMappingId = sequence ? sequenceMappingIdOf(sequence) : undefined;
  if (sequenceMappingId == null) {
    throw new Error(
      `Canary shell #${campaign.id} has no sequence_mapping_id.`,
    );
  }

  const attached = input.dryRun
    ? 0
    : await syncCanaryMembers(input.smartlead, campaign.id, input.senderAccountIds);

  return {
    campaignId: campaign.id,
    sequenceMappingId,
    created,
    attached,
  };
}

function isActiveCampaign(campaign: SmartleadCampaign): boolean {
  const status = String(campaign.status ?? "").toUpperCase();
  return status === "ACTIVE" || status === "START";
}

async function writeLiveCopy(
  input: {
    smartlead: SmartleadClient;
    subject: string;
    bodyHtml: string;
    sequenceNumber?: number;
  },
  campaignId: number,
): Promise<void> {
  const existing = (await input.smartlead.getCampaignSequences(campaignId)) ?? [];
  if (sequencesMatchCopy(existing, input.subject, input.bodyHtml, input.sequenceNumber)) {
    return;
  }
  await input.smartlead.updateCampaignSequences(
    campaignId,
    sequencesForCopy(existing, input.subject, input.bodyHtml, input.sequenceNumber),
  );
  await sleep(WRITE_GAP_MS);
}

function sequencesMatchCopy(
  sequences: SmartleadSequence[],
  subject: string,
  bodyHtml: string,
  sequenceNumber?: number,
): boolean {
  const first = pickSequence(sequences, sequenceNumber ?? 1);
  if (!first) return false;
  const variant = first.sequence_variants?.[0] ?? first.variants?.[0];
  const haveSubject = (first.subject ?? variant?.subject ?? "").trim();
  const haveBody = (first.email_body ?? variant?.email_body ?? "").trim();
  return haveSubject === subject.trim() && haveBody === bodyHtml.trim();
}

function sequencesForCopy(
  existing: SmartleadSequence[],
  subject: string,
  bodyHtml: string,
  sequenceNumber?: number,
): SmartleadSequence[] {
  if (!existing.length) {
    return [
      {
        id: 0,
        seq_number: 1,
        seq_delay_details: { delayInDays: 0, delay_in_days: 0 },
        subject,
        email_body: bodyHtml,
      },
    ];
  }
  const target = pickSequence(existing, sequenceNumber ?? 1) ?? existing[0]!;
  return existing.map((sequence) => {
    if (sequence !== target && sequence.id !== target.id) return sequence;
    return {
      id: sequence.id,
      seq_number: sequence.seq_number,
      seq_delay_details: sequence.seq_delay_details ?? {
        delayInDays: 0,
        delay_in_days: 0,
      },
      subject,
      email_body: bodyHtml,
    };
  });
}

async function seedShellLead(
  smartlead: SmartleadClient,
  campaignId: number,
  seedEmail: string,
): Promise<void> {
  const listed = await smartlead.getCampaignLeads(campaignId, { limit: 1 });
  if (shellLeadCount(listed) > 0) return;

  const result = await smartlead.addLeadsToCampaign(campaignId, [
    {
      email: seedEmail.toLowerCase(),
      first_name: "Canary",
      last_name: "Shell",
    },
  ]);
  await sleep(WRITE_GAP_MS);
  const rawAdd = safeJson(result);
  console.log(
    `[canary-shell] seed #${campaignId} ${seedEmail} upload_count=${Number(result.upload_count ?? 0)} already=${Number(result.already_added_to_campaign ?? 0)} added=${Number(result.added_count ?? 0)} raw=${rawAdd}`,
  );
  if (shellLeadImportAccepted(result)) return;

  const again = await smartlead.getCampaignLeads(campaignId, { limit: 1 });
  if (shellLeadCount(again) > 0) return;
  throw new Error(
    `canary shell #${campaignId} still has no leads add=${rawAdd} get=${safeJson(again)}`,
  );
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return String(value);
  }
}

async function syncCanaryMembers(
  smartlead: SmartleadClient,
  campaignId: number,
  senderAccountIds: number[],
): Promise<number> {
  const desired = [...new Set(senderAccountIds.filter((id) => id > 0))];
  const current = await smartlead.getCampaignEmailAccounts(campaignId);
  const currentIds = new Set(current.map((account) => account.id));
  const add = desired.filter((id) => !currentIds.has(id));
  for (const batch of chunkArray(add, 25)) {
    await smartlead.addEmailAccountsToCampaign(campaignId, batch);
    await sleep(WRITE_GAP_MS);
  }
  return add.length;
}
