import type { AppConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import { sleep } from "../lib/http.js";
import { tagNames } from "./warmupGate.js";
import { loadPods } from "./podControls.js";
import type { InventoryBook } from "./inventory.js";
import type { StateStore } from "../state/store.js";

export const POD_TAG_A = "POD-A";
export const POD_TAG_B = "POD-B";
/** Smartlead caps tag mapping writes at 25 accounts per call. */
const TAG_BATCH = 25;

export interface PodTagResult {
  assigned: number;
  removed: number;
}

/**
 * D135 — the A/B rest split is visible in Smartlead, not only in state.
 * Every client mailbox sitting in a rest pod carries a POD-A or POD-B tag,
 * converged drift-only on the monitor pass: assign the missing tag, drop
 * the opposite one. Mailboxes outside a client pod (generics, canaries,
 * idle inboxes) are left alone — an idle inbox keeps its last pod tag
 * until it staffs again, which avoids tag churn every time staffing
 * breathes. Tags are decoration for humans; nothing reads them back.
 */
export class PodTagService {
  constructor(
    private readonly config: AppConfig,
    private readonly smartlead: Pick<
      SmartleadClient,
      "ensureTag" | "assignTags" | "removeTags"
    >,
    private readonly state: StateStore,
    private readonly book: InventoryBook,
    /** Space between tag writes — the first fleet-wide burst 429'd (D135). */
    private readonly pause: () => Promise<void> = () => sleep(1000),
  ) {}

  async run(): Promise<PodTagResult> {
    const pods = await loadPods({
      config: this.config,
      state: this.state,
      book: this.book,
    });
    const desired = new Map<number, "A" | "B">();
    for (const pod of pods) {
      if (pod.pool !== "A" && pod.pool !== "B") continue;
      for (const mailbox of pod.mailboxes) {
        desired.set(mailbox.accountId, pod.pool);
      }
    }

    const { accounts } = await this.book.get();
    const assignA: number[] = [];
    const assignB: number[] = [];
    const dropA: number[] = [];
    const dropB: number[] = [];
    for (const account of accounts) {
      const want = desired.get(account.id);
      if (!want) continue;
      const tags = tagNames(account).map((tag) => tag.toUpperCase());
      const hasA = tags.includes(POD_TAG_A);
      const hasB = tags.includes(POD_TAG_B);
      if (want === "A") {
        if (!hasA) assignA.push(account.id);
        if (hasB) dropB.push(account.id);
      } else {
        if (!hasB) assignB.push(account.id);
        if (hasA) dropA.push(account.id);
      }
    }

    if (!assignA.length && !assignB.length && !dropA.length && !dropB.length) {
      return { assigned: 0, removed: 0 };
    }

    const tagA = await this.smartlead.ensureTag(POD_TAG_A, "#4FC3F7");
    const tagB = await this.smartlead.ensureTag(POD_TAG_B, "#9575CD");
    let assigned = 0;
    let removed = 0;
    if (!this.config.dryRun) {
      for (const batch of chunk(assignA, TAG_BATCH)) {
        await this.smartlead.assignTags(batch, [tagA.id]);
        assigned += batch.length;
        await this.pause();
      }
      for (const batch of chunk(assignB, TAG_BATCH)) {
        await this.smartlead.assignTags(batch, [tagB.id]);
        assigned += batch.length;
        await this.pause();
      }
      for (const batch of chunk(dropA, TAG_BATCH)) {
        await this.smartlead.removeTags(batch, [tagA.id]);
        removed += batch.length;
        await this.pause();
      }
      for (const batch of chunk(dropB, TAG_BATCH)) {
        await this.smartlead.removeTags(batch, [tagB.id]);
        removed += batch.length;
        await this.pause();
      }
    }
    console.log(
      `[pod-tags] converged POD-A/POD-B on client mailboxes: assigned=${assigned} removed=${removed}${this.config.dryRun ? " (dry-run: no writes)" : ""}`,
    );
    return { assigned, removed };
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
