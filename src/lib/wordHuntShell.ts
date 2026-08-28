/**
 * D151 — word-hunt variants ride a paused shell campaign.
 * SmartDelivery's manual placement now requires campaign_id +
 * sequence_mapping_id + provider_ids, and the sender must already sit on
 * that campaign. Custom-sequence-only posts fail. Mirror the canary shell
 * pattern: one paused "DW Word Hunt Shell", isolation mailboxes attached,
 * a non-sender seed lead, write each variant onto the shell sequence, then
 * schedule the placement off that mapping id.
 */
import {
  accountEmail,
  pickSequence,
  sequenceMappingIdOf,
  type SmartleadClient,
} from "../clients/smartlead.js";
import { sleep } from "./http.js";
import {
  canaryShellSeedEmail,
  shellLeadCount,
  shellLeadImportAccepted,
} from "./canaryShell.js";
import type { AppConfig } from "../config.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadSequence } from "../types/index.js";

export const WORD_HUNT_SHELL_NAME = "DW Word Hunt Shell";
const WRITE_GAP_MS = 400;

export function isWordHuntShellCampaign(
  campaign: { id?: number; name?: string | null },
  pinnedId?: number,
): boolean {
  if (pinnedId && campaign.id === pinnedId) return true;
  return String(campaign.name ?? "").trim() === WORD_HUNT_SHELL_NAME;
}

export async function ensureWordHuntShell(input: {
  config: AppConfig;
  smartlead: SmartleadClient;
  state: StateStore;
  isolationEmails: string[];
  dryRun?: boolean;
}): Promise<{ campaignId: number; created: boolean }> {
  const campaigns = await input.smartlead.listCampaigns();
  const stored = input.state.getIsolation().wordHuntShellCampaignId ?? undefined;
  let campaign =
    campaigns.find((row) => isWordHuntShellCampaign(row, stored)) ??
    campaigns.find((row) => isWordHuntShellCampaign(row));
  let created = false;

  if (!campaign) {
    if (input.dryRun) {
      throw new Error("Word-hunt shell is missing — create it before hunting.");
    }
    const raw = await input.smartlead.createCampaign(WORD_HUNT_SHELL_NAME);
    const id =
      typeof (raw as { id?: unknown })?.id === "number"
        ? (raw as { id: number }).id
        : Number((raw as { id?: unknown })?.id);
    if (!Number.isFinite(id) || id <= 0) {
      throw new Error("Smartlead did not return an id for the word-hunt shell.");
    }
    campaign = { id, name: WORD_HUNT_SHELL_NAME, status: "DRAFTED" };
    created = true;
  }

  if (!input.dryRun) {
    if (String(campaign.status ?? "").toUpperCase() !== "PAUSED") {
      await input.smartlead.updateCampaignStatus(campaign.id, "PAUSED");
    }
    await attachIsolationMailboxes(
      input.smartlead,
      campaign.id,
      input.isolationEmails,
    );
    await seedWordHuntLead(input.smartlead, campaign.id);
  }

  input.state.patchIsolation({ wordHuntShellCampaignId: campaign.id });
  return { campaignId: campaign.id, created };
}

export async function writeWordHuntVariantSequence(input: {
  smartlead: SmartleadClient;
  config: AppConfig;
  campaignId: number;
  subject: string;
  bodyHtml: string;
}): Promise<{ sequenceMappingId: number }> {
  const existing =
    (await input.smartlead.getCampaignSequences(input.campaignId)) ?? [];
  const base = pickSequence(existing, input.config.sequenceNumber);
  const next = {
    ...(base ?? {}),
    seq_number: base?.seq_number ?? input.config.sequenceNumber,
    subject: input.subject,
    email_body: input.bodyHtml,
    seq_delay_details: base?.seq_delay_details ?? { delayInDays: 0 },
    sequence_variants: undefined,
    variants: undefined,
  } as SmartleadSequence;
  await input.smartlead.updateCampaignSequences(
    input.campaignId,
    existing.length
      ? existing.map((row) =>
          row === base ||
          (!base && row.seq_number === input.config.sequenceNumber)
            ? next
            : row,
        )
      : [next],
  );
  await sleep(WRITE_GAP_MS);
  const refreshed =
    (await input.smartlead.getCampaignSequences(input.campaignId)) ?? [];
  const written = pickSequence(refreshed, input.config.sequenceNumber);
  const mappingId = written ? sequenceMappingIdOf(written) : undefined;
  if (mappingId == null) {
    throw new Error(
      `Word-hunt shell #${input.campaignId} has no sequence_mapping_id after write.`,
    );
  }
  return { sequenceMappingId: mappingId };
}

async function attachIsolationMailboxes(
  smartlead: SmartleadClient,
  campaignId: number,
  isolationEmails: string[],
): Promise<void> {
  if (!isolationEmails.length) return;
  const want = new Set(isolationEmails.map((e) => e.toLowerCase()));
  const accounts = await smartlead.listAllEmailAccounts({
    fetchCampaigns: true,
  });
  const toAdd: number[] = [];
  for (const account of accounts) {
    const email = accountEmail(account)?.toLowerCase();
    if (!email || !want.has(email)) continue;
    const on = (account.campaign_ids ?? []).map(Number);
    if (!on.includes(campaignId)) toAdd.push(account.id);
  }
  if (toAdd.length) {
    await smartlead.addEmailAccountsToCampaign(campaignId, toAdd);
    await sleep(WRITE_GAP_MS);
  }
}

async function seedWordHuntLead(
  smartlead: SmartleadClient,
  campaignId: number,
): Promise<void> {
  const listed = await smartlead.getCampaignLeads(campaignId, { limit: 1 });
  if (shellLeadCount(listed) > 0) return;
  const seedEmail = canaryShellSeedEmail(campaignId);
  const result = await smartlead.addLeadsToCampaign(campaignId, [
    {
      email: seedEmail.toLowerCase(),
      first_name: "Word",
      last_name: "Hunt",
    },
  ]);
  await sleep(WRITE_GAP_MS);
  if (shellLeadImportAccepted(result)) return;
  const again = await smartlead.getCampaignLeads(campaignId, { limit: 1 });
  if (shellLeadCount(again) > 0) return;
  throw new Error(
    `word-hunt shell #${campaignId} still has no seed lead`,
  );
}
