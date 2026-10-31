/**
 * D322 — merge gate for LOCKED canon.
 *
 * Canon-consistent PRs (LOCKED section and the definition files unchanged)
 * pass without Josh's approval. A PR that modifies locked canon files or
 * rules fails unless it has the `canon-change` label approved by Josh.
 * Canon edits themselves still need Josh. Unauthorized edits must never
 * auto-merge.
 *
 * The locked rule strings live in lockedCanon.ts. This module does not
 * change them.
 */

import { extractLockedCanonSection } from "./lockedCanon.js";

export const CANON_CHANGE_LABEL = "canon-change";

export const JOSH_GITHUB_LOGIN = "joshuaosborn561-lang";

/** Files whose bytes are the locked canon definition. CANON.md is checked
 * by its LOCKED section only, so a canon-consistent decision blurb is not
 * a locked edit. */
export const LOCKED_DEFINITION_FILES = [
  "docs/LOCKED-CANON.md",
  "src/lib/lockedCanon.ts",
] as const;

export interface Review {
  login: string;
  state: string;
}

export interface LabelEvent {
  event: string;
  label?: string;
  actor?: string;
}

export interface DefinitionDrift {
  lockedSectionChanged: boolean;
  definitionFilesChanged: string[];
}

export function lockedDefinitionDrift(input: {
  baseCanon: string | null;
  headCanon: string;
  files: readonly { path: string; base: string | null; head: string | null }[];
}): DefinitionDrift {
  const lockedSectionChanged =
    input.baseCanon == null ||
    extractLockedCanonSection(input.headCanon) !==
      extractLockedCanonSection(input.baseCanon);
  const definitionFilesChanged: string[] = [];
  for (const file of input.files) {
    if (file.base == null || file.head == null || file.base !== file.head) {
      definitionFilesChanged.push(file.path);
    }
  }
  return { lockedSectionChanged, definitionFilesChanged };
}

function latestJoshReviewState(reviews: readonly Review[]): string | null {
  let state: string | null = null;
  for (const review of reviews) {
    if (review.login !== JOSH_GITHUB_LOGIN) continue;
    if (review.state === "PENDING" || review.state === "") continue;
    state = review.state;
  }
  return state;
}

/**
 * The label is approved by Josh when it is on the PR and either his latest
 * review is APPROVED, or the latest canon-change label event was him
 * applying it (he cannot approve his own pull request).
 */
export function canonChangeApprovedByJosh(input: {
  labels: readonly string[];
  reviews: readonly Review[];
  labelEvents: readonly LabelEvent[];
}): boolean {
  if (!input.labels.includes(CANON_CHANGE_LABEL)) return false;
  if (latestJoshReviewState(input.reviews) === "APPROVED") return true;
  const relevant = input.labelEvents.filter(
    (event) =>
      (event.event === "labeled" || event.event === "unlabeled") &&
      event.label === CANON_CHANGE_LABEL,
  );
  const latest = relevant[relevant.length - 1];
  return latest?.event === "labeled" && latest.actor === JOSH_GITHUB_LOGIN;
}

export interface GateResult {
  ok: boolean;
  message: string;
}

export function evaluateLockedCanonGate(input: {
  lockedSectionChanged: boolean;
  definitionFilesChanged: readonly string[];
  labels: readonly string[];
  reviews: readonly Review[];
  labelEvents: readonly LabelEvent[];
}): GateResult {
  const changed =
    input.lockedSectionChanged || input.definitionFilesChanged.length > 0;
  if (!changed) {
    return {
      ok: true,
      message:
        "Canon-consistent: locked canon files and rules are unchanged. Josh's approval is not required.",
    };
  }
  const what = [
    ...(input.lockedSectionChanged ? ["CANON.md LOCKED section"] : []),
    ...input.definitionFilesChanged,
  ];
  if (
    canonChangeApprovedByJosh({
      labels: input.labels,
      reviews: input.reviews,
      labelEvents: input.labelEvents,
    })
  ) {
    return {
      ok: true,
      message: `Locked canon files/rules changed (${what.join(", ")}), and the canon-change label was approved by Josh.`,
    };
  }
  return {
    ok: false,
    message: [
      `Locked canon files/rules changed (${what.join(", ")}).`,
      "Never auto-merge. Needs the canon-change label approved by Josh (joshuaosborn561-lang).",
      "Canon edits themselves still need Josh.",
    ].join("\n"),
  };
}
