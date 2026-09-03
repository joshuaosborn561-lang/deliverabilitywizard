import { plainProseSubstitute, preferEllipsis } from "./isolationActions.js";

const FENCE_MAX = 2800;

/**
 * D170 UX — Slack swap_copy card. REMOVE / REPLACE WITH fenced blocks
 * sit right under the campaign name so the substitute cannot be missed.
 */
export function swapCopySlackBody(input: {
  title: string;
  proof: string;
  element: string;
  suggestedSwap: string;
  campaignName?: string;
}): string {
  const find = input.element.trim();
  const withText = preferEllipsis(plainProseSubstitute(find, input.suggestedSwap));
  const campaign = input.campaignName?.trim() || campaignFromProof(input.proof);
  const header = campaign || input.title;
  const withBlock = withText
    ? withText
    : "(delete that phrase... leave nothing)";
  const leftover = leftoverProof(input.proof);
  return [
    `*${header}*`,
    "",
    "*REMOVE this exact text:*",
    fence(find),
    "",
    "*REPLACE WITH:*",
    fence(withBlock),
    leftover ? "" : undefined,
    leftover || undefined,
    "",
    "Josh or Cayden: *Use suggested edit* applies REPLACE WITH fleet-wide on every ACTIVE campaign that still carries that phrase (D133). *Write my own edit* opens a Slack form that shows REMOVE again so you can type a different replacement.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export function swapCopyDeleteLabel(): string {
  return "(delete that phrase... leave nothing)";
}

function fence(value: string): string {
  return `\`\`\`${value.slice(0, FENCE_MAX)}\`\`\``;
}

function campaignFromProof(proof: string): string {
  const match = proof.match(/^Campaign:\s*\*(.+?)\*\.?$/m);
  return match?.[1]?.trim() ?? "";
}

function leftoverProof(proof: string): string {
  return proof
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t) return false;
      if (/^Campaign:/i.test(t)) return false;
      if (/REMOVE this exact text/i.test(t)) return false;
      if (/REPLACE WITH/i.test(t)) return false;
      if (/Replacing this exact phrase/i.test(t)) return false;
      if (/^Suggested edit:/i.test(t)) return false;
      if (/Use suggested edit, or Write my own/i.test(t)) return false;
      return true;
    })
    .join("\n");
}
