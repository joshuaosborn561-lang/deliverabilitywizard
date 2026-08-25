import { onWeekCohort, type RestCohort } from "./restCohort.js";
import type { SmartleadEmailAccount } from "../types/index.js";

/** Smartlead tags that mark a client mailbox's D43 rest pool (D68). */
export const POD_A_TAG = "POD-A";
export const POD_B_TAG = "POD-B";
export const POD_TAG_COLOR: Record<RestCohort, string> = {
  A: "#43A047",
  B: "#1E88E5",
};

export function podTagName(cohort: RestCohort): string {
  return cohort === "A" ? POD_A_TAG : POD_B_TAG;
}

export function podTagFromNames(tags: string[]): RestCohort | null {
  let found: RestCohort | null = null;
  for (const tag of tags) {
    const upper = tag.trim().toUpperCase();
    if (upper === POD_A_TAG) {
      if (found === "B") return null;
      found = "A";
    } else if (upper === POD_B_TAG) {
      if (found === "A") return null;
      found = "B";
    }
  }
  return found;
}

export function podTagFromAccount(
  account: Pick<SmartleadEmailAccount, "tags">,
): RestCohort | null {
  const names = (account.tags ?? [])
    .map((tag) => String(tag.tag_name ?? tag.name ?? "").trim())
    .filter(Boolean);
  return podTagFromNames(names);
}

/** Which POD-* tag to attach when standing up a campaign this fortnight. */
export function onWeekPodTag(now: Date = new Date()): string {
  return podTagName(onWeekCohort(now));
}

export function isPodTagName(name: string): boolean {
  const upper = name.trim().toUpperCase();
  return upper === POD_A_TAG || upper === POD_B_TAG;
}
