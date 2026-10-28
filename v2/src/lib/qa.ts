import { STEP2_DELAY_DAYS, STEP3_DELAY_DAYS } from "../canon/constants.js";
import type { Finding, LeadSample, SequenceSample, SlimAccount, SlimCampaign } from "../types.js";
import { isShellOrWordHuntCampaign, isTestCampaign } from "./campaignCanon.js";
import { isCallerFollowUpCampaign } from "./poc.js";
import { mailboxSignatureMismatch } from "./signature.js";

/** D180 — pages merge_tag_blank; never rewrites live copy or lead fields. */
export function mergeTagHoles(sample: {
  body?: string;
  customFields?: Record<string, string | null | undefined>;
}): string[] {
  const holes: string[] = [];
  const body = sample.body ?? "";
  const tags = [...body.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]!);
  for (const tag of tags) {
    if (tag.toLowerCase() === "signature") continue;
    const value = sample.customFields?.[tag];
    if (value == null || String(value).trim() === "") holes.push(tag);
  }
  return holes;
}

export function step2DelayWrong(delayInDays: number | null | undefined): boolean {
  if (delayInDays == null) return false;
  return delayInDays !== STEP2_DELAY_DAYS;
}

/** D306 — check only. Never a sequence_write. */
export function missingBreakupStep(
  sequences: SequenceSample[] | null | undefined,
): string | null {
  const rows = sequences ?? [];
  const numbered = rows.filter(
    (s) => s.seqNumber != null && Number.isFinite(Number(s.seqNumber)),
  );
  if (!numbered.length) return null;
  const hasStep2 = numbered.some((s) => Number(s.seqNumber) === 2);
  const step3 = numbered.find((s) => Number(s.seqNumber) === 3);
  if (!hasStep2 && !step3) return null;
  if (!step3) return "step 3 missing (want delay 2d so it lands on day 4)";
  if (step3.delayInDays !== STEP3_DELAY_DAYS) {
    return `step 3 delay ${step3.delayInDays == null ? "unset" : `${step3.delayInDays}d`} (want ${STEP3_DELAY_DAYS} so it lands on day 4)`;
  }
  return null;
}

function campaignHasBreakupStepRule(campaign: SlimCampaign): boolean {
  if (isCallerFollowUpCampaign(campaign)) return false;
  if (isShellOrWordHuntCampaign(campaign)) return false;
  if (isTestCampaign(campaign)) return false;
  return true;
}

export function sequenceHasSignatureTag(body: string): boolean {
  return /%signature%|\{\{\s*Signature\s*\}\}/i.test(body);
}

/** New copy + new leads QA: merge tags resolve, signatures present. */
export function qaCopyAndLeads(opts: {
  campaign: SlimCampaign;
  members: SlimAccount[];
  sequences?: SequenceSample[];
  leads?: LeadSample[];
  clientBrand?: string;
  otherClientBrands?: readonly string[];
}): Finding[] {
  const findings: Finding[] = [];
  // D298: never fall back to the campaign name for the brand line.
  const brand = opts.clientBrand;

  for (const account of opts.members) {
    const sig = mailboxSignatureMismatch({
      fromName: account.fromName,
      signature: account.signature,
      clientBrand: brand,
      otherClientBrands: opts.otherClientBrands,
      tags: account.tags,
    });
    if (sig) {
      findings.push({
        kind: "mailbox_sig",
        campaignId: opts.campaign.id,
        accountId: account.id,
        email: account.email,
        detail: sig,
      });
    }
  }

  const seqs = (opts.sequences ?? []).filter((s) => s.campaignId === opts.campaign.id);
  const leads = (opts.leads ?? []).filter((l) => l.campaignId === opts.campaign.id);
  for (const seq of seqs) {
    if (seq.body && !sequenceHasSignatureTag(seq.body)) {
      findings.push({
        kind: "missing_signature_tag",
        campaignId: opts.campaign.id,
        detail: `${opts.campaign.name} sequence has no %signature% / {{Signature}}`,
      });
    }
    const fields = leads[0]?.customFields ?? {};
    const holes = mergeTagHoles({ body: seq.body, customFields: fields });
    if (holes.length) {
      findings.push({
        kind: "merge_tag_blank",
        campaignId: opts.campaign.id,
        detail: `${opts.campaign.name} unresolved merge tags: ${holes.join(", ")}`,
      });
    }
    if (step2DelayWrong(seq.delayInDays)) {
      findings.push({
        kind: "step2_delay",
        campaignId: opts.campaign.id,
        detail: `step 2 delay is ${seq.delayInDays}, want ${STEP2_DELAY_DAYS}`,
      });
    }
  }
  if (campaignHasBreakupStepRule(opts.campaign)) {
    const breakup = missingBreakupStep(seqs);
    if (breakup) {
      findings.push({
        kind: "missing_breakup_step",
        campaignId: opts.campaign.id,
        detail: breakup,
      });
    }
  }
  return findings;
}
