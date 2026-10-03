import type { AppConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { SlackClient } from "../clients/slack.js";
import { clientDisplayName } from "../clients/smartlead.js";
import { sleep } from "../lib/http.js";
import { tagNames } from "./warmupGate.js";
import { loadPods } from "./podControls.js";
import type { InventoryBook } from "./inventory.js";
import type { StateStore } from "../state/store.js";
import {
  formatDualPodSlack,
  hasDualPodTags,
  isPodRotationSkippedClient,
  podRotationIdleReason,
} from "../lib/podRotation.js";

export const POD_TAG_A = "POD-A";
export const POD_TAG_B = "POD-B";
/** Smartlead caps tag mapping writes at 25 accounts per call. */
const TAG_BATCH = 25;

export interface PodTagResult {
  assigned: number;
  removed: number;
  dualPodFlagged: number;
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
    private readonly slack?: Pick<SlackClient, "notifyDeliverabilityNote">,
  ) {}

  async run(opts: { now?: Date } = {}): Promise<PodTagResult> {
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

    const { accounts, clients } = await this.book.get();
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
      const dualPodFlagged = await this.flagDualPod(
        accounts,
        clients ?? [],
        opts.now,
      );
      return { assigned: 0, removed: 0, dualPodFlagged };
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
    const dualPodFlagged = await this.flagDualPod(
      accounts,
      clients ?? [],
      opts.now,
    );
    return { assigned, removed, dualPodFlagged };
  }

  private async flagDualPod(
    accounts: Array<{
      id?: number;
      from_email?: string;
      email?: string;
      client_id?: number | null;
      tags?: Array<{ tag_name?: unknown; name?: unknown }> | string[];
    }>,
    clients: Array<{ id: number; name?: string; logo?: string | null }>,
    now?: Date,
  ): Promise<number> {
    if (podRotationIdleReason(now)) return 0;
    const nameById = new Map(
      clients.map((client) => [client.id, clientDisplayName(client)]),
    );
    const rows: Array<{
      email: string;
      clientName: string;
      clientId: number | null;
    }> = [];
    for (const account of accounts) {
      const clientId =
        typeof account.client_id === "number" ? account.client_id : null;
      if (isPodRotationSkippedClient(clientId)) continue;
      if (!hasDualPodTags(account.tags)) continue;
      const email = String(account.from_email || account.email || "")
        .trim()
        .toLowerCase();
      if (!email) continue;
      rows.push({
        email,
        clientId,
        clientName:
          (clientId != null ? nameById.get(clientId) : undefined) ||
          (clientId != null ? `Client ${clientId}` : "Unassigned"),
      });
    }
    const text = formatDualPodSlack(rows);
    if (text && !this.config.dryRun && this.slack) {
      await this.slack.notifyDeliverabilityNote(text);
    }
    if (rows.length) {
      console.log(`[pod-tags] dual-POD flag ${rows.length} seat(s) (D223)`);
    }
    return rows.length;
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
