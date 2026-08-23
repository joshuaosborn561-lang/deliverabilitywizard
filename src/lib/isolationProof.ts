import type { IsolationVerdict } from "./isolationVerdict.js";
import type { DomainCycleVerdict } from "./domainControl.js";

export function campaignProof(input: {
  verdict: IsolationVerdict;
  controlVersion?: string;
  senderSummary: string;
  whyNotTheOther: string;
  next: string;
}): string {
  return [
    `What I know: ${plainVerdict(input.verdict)}`,
    `What I ran: known-good email${input.controlVersion ? ` (${input.controlVersion})` : ""} — no offer, no link, no spam words — from ${input.senderSummary}.`,
    input.whyNotTheOther,
    `What I will not do yet: ${input.next}`,
  ].join("\n");
}

export function domainProof(verdict: DomainCycleVerdict, consecutiveFails: number): string {
  return [
    `What I ran: the known-good email from ${verdict.testedEmails.length} inbox${verdict.testedEmails.length === 1 ? "" : "es"} on ${verdict.domain}.`,
    `Who failed: ${verdict.failingEmails.length ? verdict.failingEmails.join(", ") : "nobody"}.`,
    verdict.reason,
    consecutiveFails >= 2
      ? "This is the second time in a row. I am not guessing from a campaign that landed in spam — that campaign still needs the copy-or-inboxes check."
      : consecutiveFails === 1
        ? "First fail. I will count this domain in what we order so replacements can warm. I will not retire it yet."
        : "This cycle is clean.",
    verdict.fleet
      ? "Fleet domain: I will not call it dead unless several inboxes failed, not one."
      : "Client domain: the whole domain is the unit.",
  ].join("\n");
}

export function copySwapProof(input: {
  campaignName: string;
  element: string;
  swap: string;
  controlLanded: boolean;
}): string {
  return [
    `Campaign: ${input.campaignName}.`,
    `Known-good email from the same inboxes ${input.controlLanded ? "landed in the inbox" : "did not land"} — so this is not “the inboxes are dead.”`,
    `Word hunt: taking out *${input.element}* is what recovered. Suggested swap: *${input.swap}*.`,
    "I have not edited the live email. Approve in Slack and I will make that one change.",
  ].join("\n");
}

function plainVerdict(verdict: IsolationVerdict): string {
  if (verdict === "COPY") return "the copy is the problem.";
  if (verdict === "INFRA") return "the inboxes / domain are the problem.";
  if (verdict === "HEALTHY") return "this campaign looks fine.";
  return "I cannot say copy vs inboxes yet.";
}
