import type { AppConfig } from "../config.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import type { SlackClient } from "../clients/slack.js";
import { accountEmail, clientDisplayName } from "../clients/smartlead.js";
import { sleep } from "../lib/http.js";
import { loadPods } from "./podControls.js";
import type { InventoryBook } from "./inventory.js";
import type { StateStore } from "../state/store.js";
import {
  formatDualPodSlack,
  hasDualPodTags,
  isPodRotationSkippedClient,
  podRotationIdleReason,
} from "../lib/podRotation.js";
import { existingPodTag } from "../lib/podTagLock.js";
import {
  NAMED_POD_MAX_MOVES_PER_PASS,
  planNamedPodRebalance,
  type NamedPodSeat,
} from "../lib/namedPodBalance.js";
import { campaignIdsOf } from "../clients/smartlead.js";
import { senderEspBucket } from "../lib/canonStaffable.js";
import { weekendWriterIdleReason } from "../lib/canonOpsHours.js";
import { isGabeVmReserved, isLockedCanarySeat } from "../lib/canaryLock.js";
import {
  callerFollowUpMustSkipPodTags,
  isCaydenSgSeat,
} from "../lib/callerFollowUp.js";
import { pocEngagementClientIds } from "../lib/pocClient.js";
import { accountOnBounceHold } from "../lib/bounceHold.js";
import { onWeekCohort } from "../lib/restCohort.js";
import { hasPoolMarkerTag } from "../lib/markerClients.js";
import { isJeremyCiotolaSeat } from "../lib/ciotolaClient.js";
import { accountTagNames } from "../lib/attachGuard.js";

/** GENERIC pool tag id (name match also covers GENERIC / POC). */
const GENERIC_TAG_ID = 510826;

/**
 * D326 fix — a seat counted in a client's named POD-A/POD-B split,
 * matching the CANON sweep: not GENERIC/POC (510826), CAYDEN-SG,
 * GABE-VM-RESERVED / caller follow-up, JEREMY-CIOTOLA (533700), a
 * canary, any HOLD-UNTIL-*, or dual POD-tagged.
 */
export function isNamedSeatForPodBalance(
  account: Parameters<typeof isLockedCanarySeat>[0] &
    Parameters<typeof isGabeVmReserved>[0],
  email: string,
  state: Parameters<typeof isLockedCanarySeat>[2] = {},
): boolean {
  const tags = account.tags ?? [];
  if (hasPoolMarkerTag({ tags })) return false;
  if ((tags as Array<Record<string, unknown>>).some((t) => Number(t.id ?? t.tag_id) === GENERIC_TAG_ID)) return false;
  if (isCaydenSgSeat(account)) return false;
  if (isGabeVmReserved(account) || callerFollowUpMustSkipPodTags(account as never, email)) return false;
  if (isJeremyCiotolaSeat(account as never)) return false;
  const names = accountTagNames(account as never).map((n) => n.toUpperCase());
  if (names.some((n) => n.startsWith("HOLD-UNTIL"))) return false;
  if (names.some((n) => n.includes("CANARY"))) return false;
  if (email && isLockedCanarySeat(account, email, state)) return false;
  if (email.toLowerCase().includes("canary")) return false;
  if (hasDualPodTags(account.tags as never)) return false;
  return true;
}

export const POD_TAG_A = "POD-A";
export const POD_TAG_B = "POD-B";
/** Smartlead caps tag mapping writes at 25 accounts per call. */
const TAG_BATCH = 25;

export interface PodTagResult {
  assigned: number;
  removed: number;
  dualPodFlagged: number;
  skipped?: boolean;
  reason?: string;
  refused?: number;
  /** D316 / D326 — named seats retagged to even a lopsided client. */
  rebalanced?: number;
}

/**
 * D135 — the A/B rest split is visible in Smartlead, not only in state.
 * Every client mailbox sitting in a rest pod carries a POD-A or POD-B tag.
 * D234 — only an *untagged* seat may receive a first POD tag. An
 * already-tagged seat is immutable (never A→B or B→A). Mailboxes
 * outside a client pod (generics, canaries, idle inboxes) are left
 * alone — D230 locks a generic to the POD it was stamped with. An
 * idle inbox keeps its last pod tag. Named tags are decoration for
 * humans; assigned generic POD tags are the D230 lock. Weekend
 * writers idle Sat/Sun except Josh-live `/run`.
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

  async run(opts: { now?: Date; joshLive?: boolean } = {}): Promise<PodTagResult> {
    const result = await this.runFirstTag(opts);
    if (result.skipped || !this.config.enableNamedPodRebalance) return result;
    try {
      const moved = await this.rebalanceNamedSeats(opts.now);
      if (moved > 0) result.rebalanced = moved;
    } catch (error) {
      console.warn("[pod-tags] D326 named-seat rebalance failed", error);
    }
    return result;
  }

  /**
   * D326 — Josh 11/4: move named inboxes A↔B to balance a lopsided
   * client, preferred over covering the gap with generics. Only the
   * off-week POD's named seats, or seats not linked to ACTIVE
   * campaigns, may move. A 24h 5.7.233 / TERRL stop keeps its POD
   * tag. Canaries, reserved, dual-tagged, POC, isolation and
   * CAYDEN-SG never move. ESP stay balanced. At most N per pass.
   */
  async rebalanceNamedSeats(now: Date = new Date()): Promise<number> {
    const pods = await loadPods({
      config: this.config,
      state: this.state,
      book: this.book,
    });
    const { campaigns, accounts, clients } = await this.book.get();
    const active = new Set(
      campaigns
        .filter((c) => String(c.status ?? "").toUpperCase() === "ACTIVE")
        .map((c) => c.id),
    );
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const pocSkipIds = pocEngagementClientIds(
      clients ?? [],
      this.config.pocClientNamePatterns,
      this.state.listEndedPocClientIds(),
    );
    const onWeek = onWeekCohort(now);
    // D326 fix (Cayden 11/5) — count EVERY named seat of a rotating
    // client, the same population the CANON sweep counts. The pod list
    // only holds seats on ACTIVE campaigns or the resting list, so it
    // skewed the real split (Nov 4–5: 40 seats moved B→A). Pods only
    // decide which clients rotate; the seats come from the full book.
    const rotating = new Set<number>();
    for (const pod of pods) {
      if ((pod.pool !== "A" && pod.pool !== "B") || pod.clientId == null) continue;
      if (isPodRotationSkippedClient(pod.clientId, pocSkipIds)) continue;
      rotating.add(pod.clientId);
    }
    const seats: NamedPodSeat[] = [];
    for (const account of accounts) {
      const clientId = account.client_id;
      if (typeof clientId !== "number" || !rotating.has(clientId)) continue;
      const email = accountEmail(account) || "";
      if (!isNamedSeatForPodBalance(account, email, this.state)) continue;
      const pod = existingPodTag(account.tags);
      if (pod !== "A" && pod !== "B") continue;
      // Counted, never moved: a 24h 5.7.233 / TERRL stop keeps its POD tag.
      const locked = accountOnBounceHold(account, this.state, now);
      seats.push({
        accountId: account.id,
        email,
        clientId,
        pod,
        esp: senderEspBucket(account),
        onActiveCampaign: campaignIdsOf(account).some((id) => active.has(id)),
        offWeek: pod !== onWeek,
        locked: Boolean(locked),
      });
    }
    const plan = planNamedPodRebalance(seats, {
      maxMoves: NAMED_POD_MAX_MOVES_PER_PASS,
      now,
    });
    for (const client of plan.clients) {
      if (client.violations.length) {
        console.log(
          `[pod-tags] D326 client ${client.clientId} named A=${client.a} B=${client.b} gap=${(client.gap * 100).toFixed(0)}% out of 15% on ${client.violations.join("+")} → ${client.moves.length} retag(s)${client.remainingViolations.length ? `, still out on ${client.remainingViolations.join("+")} (on-week ACTIVE / locked seats stay)` : ""}`,
        );
      }
    }
    if (!plan.moves.length) return 0;
    const toA = plan.moves.filter((m) => m.to === "A");
    const toB = plan.moves.filter((m) => m.to === "B");
    if (this.config.dryRun) {
      console.log(
        `[pod-tags] D326 (dry-run: no writes) would retag ${plan.moves.map((m) => `${m.email} POD-${m.from}→POD-${m.to}`).join(", ")}`,
      );
      return 0;
    }
    const tagA = await this.smartlead.ensureTag(POD_TAG_A, "#4FC3F7");
    const tagB = await this.smartlead.ensureTag(POD_TAG_B, "#9575CD");
    let moved = 0;
    for (const [group, newTag, oldTag] of [
      [toA, tagA, tagB],
      [toB, tagB, tagA],
    ] as const) {
      for (const batch of chunk(group, TAG_BATCH)) {
        const ids = batch.map((m) => m.accountId);
        await this.smartlead.removeTags(ids, [oldTag.id]);
        await this.smartlead.assignTags(ids, [newTag.id]);
        moved += ids.length;
        await this.pause();
      }
    }
    console.log(
      `[pod-tags] D326 retagged ${moved} named seat(s) to even POD-A/POD-B: ${plan.moves.map((m) => `${m.email} POD-${m.from}→POD-${m.to}`).join(", ")}`,
    );
    return moved;
  }

  private async runFirstTag(
    opts: { now?: Date; joshLive?: boolean } = {},
  ): Promise<PodTagResult> {
    const weekendIdle = weekendWriterIdleReason({
      now: opts.now,
      joshLive: opts.joshLive,
    });
    if (weekendIdle) {
      console.log(`[pod-tags] ${weekendIdle}`);
      return {
        assigned: 0,
        removed: 0,
        dualPodFlagged: 0,
        refused: 0,
        skipped: true,
        reason: weekendIdle,
      };
    }

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
    const pocSkipIds = pocEngagementClientIds(
      clients ?? [],
      this.config.pocClientNamePatterns,
      this.state.listEndedPocClientIds(),
    );
    const assignA: number[] = [];
    const assignB: number[] = [];
    const firstTagEmails: string[] = [];
    const refusedEmails: string[] = [];
    const stripReserved: number[] = [];
    const stripEmails: string[] = [];
    for (const account of accounts) {
      const lockEmail = accountEmail(account) || "";
      if (lockEmail && isLockedCanarySeat(account, lockEmail, this.state)) {
        continue;
      }
      if (
        callerFollowUpMustSkipPodTags(account, lockEmail) ||
        isGabeVmReserved(account)
      ) {
        if (existingPodTag(account.tags) && typeof account.id === "number") {
          stripReserved.push(account.id);
          stripEmails.push(lockEmail || String(account.id));
        }
        continue;
      }
      const want = desired.get(account.id);
      if (!want) continue;
      if (hasDualPodTags(account.tags)) continue;
      if (
        typeof account.client_id === "number" &&
        isPodRotationSkippedClient(account.client_id, pocSkipIds)
      ) {
        continue;
      }
      const existing = existingPodTag(account.tags);
      const email = lockEmail || String(account.id);
      if (existing) {
        if (existing !== want) {
          refusedEmails.push(`${email} has POD-${existing} want POD-${want}`);
        }
        continue;
      }
      if (want === "A") assignA.push(account.id);
      else assignB.push(account.id);
      firstTagEmails.push(`${email}→POD-${want}`);
    }

    if (refusedEmails.length) {
      console.log(
        `[pod-tags] D234 lock refused retag (${refusedEmails.length}): ${refusedEmails.join(", ")}`,
      );
    }

    if (!assignA.length && !assignB.length && !stripReserved.length) {
      const dualPodFlagged = await this.flagDualPod(
        accounts,
        clients ?? [],
        opts.now,
        pocSkipIds,
      );
      return {
        assigned: 0,
        removed: 0,
        dualPodFlagged,
        refused: refusedEmails.length,
      };
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
      for (const batch of chunk(stripReserved, TAG_BATCH)) {
        await this.smartlead.removeTags(batch, [tagA.id, tagB.id]);
        removed += batch.length;
        await this.pause();
      }
    } else {
      removed = stripReserved.length;
    }
    console.log(
      `[pod-tags] first-tag POD-A/POD-B on untagged client mailboxes: assigned=${assigned} removed=${removed} refused=${refusedEmails.length}${this.config.dryRun ? " (dry-run: no writes)" : ""} emails=${firstTagEmails.join(",") || "none"}${stripEmails.length ? ` stripped-reserved=${stripEmails.join(",")}` : ""}`,
    );
    const dualPodFlagged = await this.flagDualPod(
      accounts,
      clients ?? [],
      opts.now,
      pocSkipIds,
    );
    return { assigned, removed, dualPodFlagged, refused: refusedEmails.length };
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
    extraSkipIds: Iterable<number> = [],
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
      if (isPodRotationSkippedClient(clientId, extraSkipIds)) continue;
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
