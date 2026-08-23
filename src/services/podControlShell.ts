import type { AppConfig } from "../config.js";
import {
  accountEmail,
  pickSequence,
  sequenceMappingIdOf,
  type SmartleadClient,
} from "../clients/smartlead.js";
import { isCopyCanaryFleetEmail } from "../lib/copyCanaryFleet.js";
import type { ControlTemplate } from "../lib/controlTemplate.js";
import { chunkArray, sleep } from "../lib/http.js";
import {
  campaignIdFromCreate,
  isPodControlShellCampaign,
  POD_CONTROL_SHELL_NAME,
} from "../lib/podControlShell.js";
import type { Pod } from "../lib/pods.js";
import type { StateStore } from "../state/store.js";
import type { SmartleadCampaign, SmartleadSequence } from "../types/index.js";

export interface PodControlShellResult {
  campaignId: number;
  sequenceMappingId: number;
  attached: number;
  created: boolean;
  paused: boolean;
}

export async function ensurePodControlShell(input: {
  config: AppConfig;
  smartlead: SmartleadClient;
  state: StateStore;
  pods: Pod[];
  template: ControlTemplate;
  dryRun?: boolean;
}): Promise<PodControlShellResult> {
  const campaigns = await input.smartlead.listCampaigns();
  const pinned = input.config.podControlShellCampaignId || undefined;
  const stored = input.state.getIsolation().shellCampaignId ?? undefined;
  let campaign =
    campaigns.find((row) => isPodControlShellCampaign(row, pinned)) ??
    campaigns.find((row) => isPodControlShellCampaign(row, stored));
  let created = false;

  if (!campaign) {
    if (input.dryRun) {
      throw new Error(
        "Pod control shell campaign is missing — create it before scheduling tests.",
      );
    }
    const raw = await input.smartlead.createCampaign(POD_CONTROL_SHELL_NAME);
    const id = campaignIdFromCreate(raw);
    if (id == null) {
      throw new Error("Smartlead did not return an id for the pod control shell.");
    }
    campaign = {
      id,
      name: POD_CONTROL_SHELL_NAME,
      status: "PAUSED",
    };
    created = true;
  }

  if (isActiveCampaign(campaign) && input.dryRun) {
    throw new Error(
      `Pod control shell #${campaign.id} is ACTIVE — refuse to use a live campaign.`,
    );
  }
  if (!input.dryRun && String(campaign.status ?? "").toUpperCase() !== "PAUSED") {
    await input.smartlead.updateCampaignStatus(campaign.id, "PAUSED");
    campaign = { ...campaign, status: "PAUSED" };
  }

  await writeKnownGoodSequence(input, campaign.id);
  const sequences = await input.smartlead.getCampaignSequences(campaign.id);
  const sequence = pickSequence(sequences ?? [], input.config.sequenceNumber);
  const sequenceMappingId = sequence ? sequenceMappingIdOf(sequence) : undefined;
  if (sequenceMappingId == null) {
    throw new Error(
      `Pod control shell #${campaign.id} has no sequence_mapping_id.`,
    );
  }

  const attached = input.dryRun
    ? 0
    : await syncShellMembers(input, campaign.id);

  input.state.patchIsolation({ shellCampaignId: campaign.id });

  return {
    campaignId: campaign.id,
    sequenceMappingId,
    attached,
    created,
    paused: !isActiveCampaign(campaign),
  };
}

function isActiveCampaign(campaign: SmartleadCampaign): boolean {
  const status = String(campaign.status ?? "").toUpperCase();
  return status === "ACTIVE" || status === "START";
}

async function writeKnownGoodSequence(
  input: {
    smartlead: SmartleadClient;
    template: ControlTemplate;
  },
  campaignId: number,
): Promise<void> {
  const existing = (await input.smartlead.getCampaignSequences(campaignId)) ?? [];
  const next = sequencesForControl(existing, input.template);
  if (sequencesMatchControl(existing, input.template)) return;
  await input.smartlead.updateCampaignSequences(campaignId, next);
}

function sequencesMatchControl(
  sequences: SmartleadSequence[],
  template: ControlTemplate,
): boolean {
  const first = pickSequence(sequences, 1);
  if (!first) return false;
  const variant = first.sequence_variants?.[0] ?? first.variants?.[0];
  const subject = (first.subject ?? variant?.subject ?? "").trim();
  const body = (first.email_body ?? variant?.email_body ?? "").trim();
  return subject === template.subject && body === template.bodyHtml;
}

function sequencesForControl(
  existing: SmartleadSequence[],
  template: ControlTemplate,
): SmartleadSequence[] {
  if (!existing.length) {
    return [
      {
        id: 0,
        seq_number: 1,
        seq_delay_details: { delayInDays: 0, delay_in_days: 0 },
        subject: template.subject,
        email_body: template.bodyHtml,
      },
    ];
  }
  const target = pickSequence(existing, 1) ?? existing[0]!;
  return existing.map((sequence) => {
    if (sequence !== target && sequence.id !== target.id) return sequence;
    return {
      id: sequence.id,
      seq_number: sequence.seq_number,
      seq_delay_details: sequence.seq_delay_details ?? {
        delayInDays: 0,
        delay_in_days: 0,
      },
      subject: template.subject,
      email_body: template.bodyHtml,
    };
  });
}

async function syncShellMembers(
  input: {
    config: AppConfig;
    smartlead: SmartleadClient;
    state: StateStore;
    pods: Pod[];
  },
  campaignId: number,
): Promise<number> {
  const fleet = input.state.getCopyCanaryFleet();
  const isolationEmails = new Set(
    input.config.isolationMailboxEmails.map((email) => email.toLowerCase()),
  );
  const desired = new Map<number, string>();
  for (const pod of input.pods) {
    for (const mailbox of pod.mailboxes) {
      const email = mailbox.email.toLowerCase();
      if (isolationEmails.has(email)) continue;
      if (isCopyCanaryFleetEmail(email, fleet)) continue;
      desired.set(mailbox.accountId, email);
    }
  }

  const current = await input.smartlead.getCampaignEmailAccounts(campaignId);
  const currentIds = new Set<number>();
  const remove: number[] = [];
  for (const account of current) {
    currentIds.add(account.id);
    const email = accountEmail(account)?.toLowerCase() ?? "";
    if (
      isolationEmails.has(email) ||
      isCopyCanaryFleetEmail(email, fleet)
    ) {
      remove.push(account.id);
    }
  }

  const add = [...desired.keys()].filter((id) => !currentIds.has(id));
  for (const batch of chunkArray(add, 25)) {
    await input.smartlead.addEmailAccountsToCampaign(campaignId, batch);
    await sleep(200);
  }
  for (const batch of chunkArray(remove, 25)) {
    await input.smartlead.removeEmailAccountsFromCampaign(campaignId, batch);
    await sleep(200);
  }
  return add.length;
}
