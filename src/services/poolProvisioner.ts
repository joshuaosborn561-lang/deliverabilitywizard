import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "../config.js";
import {
  InboxKitClient,
  type InboxKitDomain,
  type InboxKitMailbox,
} from "../clients/inboxkit.js";
import type { SlackClient } from "../clients/slack.js";
import type { SmartleadClient } from "../clients/smartlead.js";
import {
  accountEmail,
  type SmartleadAccountWithCampaigns,
} from "../clients/smartlead.js";
import { GENERIC_POOL_PLAN } from "../data/genericPoolPlan.js";
import { sleep } from "../lib/http.js";
import {
  parsePersonName,
  poolEspFromSmartleadType,
} from "../lib/poolSignature.js";
import type { SpendGateway } from "../lib/spendGateway.js";
import type { StateStore, PoolProvisionPhase } from "../state/store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PLAN_PATH = path.resolve(
  __dirname,
  "../../data/generic-pool-domains.json",
);

export interface PoolDomainPlan {
  workspaceId: string;
  workspaceName?: string;
  mailboxesPerDomain: number;
  warmupDaysBeforeAvailable?: number;
  note?: string;
  smartleadSequencerUid?: string;
  smartleadSequencerName?: string;
  domains: Array<{
    domain: string;
    parent: string;
    platform: "GOOGLE" | "MICROSOFT";
  }>;
}

export interface PoolProvisionResult {
  phase: PoolProvisionPhase;
  previousPhase: PoolProvisionPhase;
  advanced: boolean;
  message: string;
  stats: Record<string, number | string | boolean>;
  errors: string[];
}

const FIRST_NAMES = [
  "Marty",
  "Jo",
  "Alex",
  "Sam",
  "Riley",
  "Casey",
  "Jordan",
  "Taylor",
  "Morgan",
  "Quinn",
  "Avery",
  "Reese",
  "Parker",
  "Drew",
  "Blake",
  "Cameron",
  "Hayden",
  "Rowan",
  "Skyler",
  "Emerson",
];
const LAST_NAMES = [
  "Moen",
  "Shmo",
  "Hayes",
  "Brooks",
  "Coleman",
  "Reed",
  "Foster",
  "Bennett",
  "Griffin",
  "Palmer",
  "Walsh",
  "Nash",
  "Keller",
  "Boone",
  "Pratt",
  "Sloan",
  "Vance",
  "Hale",
  "Croft",
  "Lang",
];

/**
 * Self-advancing generic-pool provisioner.
 * Cron polls each step until the pipeline reaches `ready` — no babysitting.
 *
 * Phases: awaiting_ns → buying → awaiting_mailboxes → awaiting_sequencer
 *         → exporting → awaiting_export → importing_state → warming → ready
 */
export class PoolProvisioner {
  constructor(
    private readonly config: AppConfig,
    private readonly inboxkit: InboxKitClient | null,
    private readonly smartlead: SmartleadClient,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
    private readonly spendGateway: SpendGateway,
    private readonly planPath: string = DEFAULT_PLAN_PATH,
  ) {}

  async run(): Promise<PoolProvisionResult> {
    const errors: string[] = [];
    const provision = this.state.getPoolProvision();
    const previousPhase = provision.phase;

    // Independent of the .info pipeline — hand-bought generics should be
    // swap-ready even when the plan file is missing or the pipeline is stalled.
    try {
      const extra = await this.registerExtraGenerics();
      errors.push(...extra.errors);
      if (extra.unmatched.length) {
        errors.push(
          `extra generics not found in Smartlead: ${extra.unmatched.join(", ")}`,
        );
      }
    } catch (error) {
      errors.push(
        `extra generics: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!this.config.enablePoolProvisioner) {
      return {
        phase: previousPhase,
        previousPhase,
        advanced: false,
        message: "Pool provisioner disabled (ENABLE_POOL_PROVISIONER=false)",
        stats: {},
        errors,
      };
    }

    if (previousPhase === "ready") {
      // Still refresh availability so swaps unlock after warmup days,
      // and re-assert warmup so UI toggles / late imports stay covered.
      const flipped = this.state.refreshPoolAvailability(
        this.config.poolWarmupDays,
      );
      let forced = 0;
      try {
        const plan = await this.loadPlan();
        const planDomains = new Set(
          plan.domains.map((d) => d.domain.toLowerCase()),
        );
        const accounts = await this.smartlead.listAllEmailAccounts({
          fetchCampaigns: false,
        });
        for (const account of accounts) {
          const email = accountEmail(account)?.toLowerCase();
          if (!email) continue;
          const domain = email.split("@")[1] ?? "";
          if (!planDomains.has(domain)) continue;
          try {
            await this.smartlead.configureWarmup(account.id, {
              warmup_enabled: true,
              total_warmup_per_day: this.config.warmupTotalPerDay,
              daily_rampup: this.config.warmupDailyRampup,
              reply_rate_percentage: this.config.warmupReplyRatePercentage,
            });
            forced += 1;
            await sleep(120);
          } catch {
            // non-fatal on ready refresh
          }
        }
      } catch (error) {
        console.warn("[pool-provision] ready warmup refresh failed", error);
      }
      await this.state.save();
      return {
        phase: "ready",
        previousPhase,
        advanced: false,
        message: `Pool ready (${flipped} newly available; warmup refreshed on ${forced})`,
        stats: { flippedAvailable: flipped, warmupForced: forced },
        errors,
      };
    }

    if (!this.inboxkit) {
      errors.push("INBOXKIT_API_KEY not configured");
      return this.finish(previousPhase, previousPhase, false, "missing InboxKit", {}, errors);
    }

    const plan = await this.loadPlan();

    const workspaceId =
      this.config.genericPoolWorkspaceId || plan.workspaceId;
    const targetCount = plan.domains.length * (plan.mailboxesPerDomain || 3);

    let phase: PoolProvisionPhase =
      previousPhase === "idle" ? "awaiting_ns" : previousPhase;

    const stats: Record<string, number | string | boolean> = {
      targetMailboxes: targetCount,
      workspaceId,
    };

    try {
      // --- NS ---
      if (phase === "awaiting_ns" || phase === "buying") {
        const domains = await this.inboxkit.listDomains(workspaceId, {
          limit: 100,
        });
        const byName = new Map(
          domains.map((d) => [(d.name || d.domain || "").toLowerCase(), d]),
        );
        let matched = 0;
        const missing: string[] = [];
        for (const row of plan.domains) {
          const d = byName.get(row.domain.toLowerCase());
          if (d && InboxKitClient.nameserversReady(d)) matched += 1;
          else missing.push(row.domain);
        }
        stats.nsMatched = matched;
        stats.nsTotal = plan.domains.length;
        if (matched < plan.domains.length) {
          phase = "awaiting_ns";
          this.state.setPoolProvision({
            phase,
            lastMessage: `NS ${matched}/${plan.domains.length} matched`,
            nsMatched: matched,
            nsTotal: plan.domains.length,
          });
          return this.finish(
            phase,
            previousPhase,
            phase !== previousPhase,
            `Waiting on nameservers (${matched}/${plan.domains.length}). Sample pending: ${missing.slice(0, 5).join(", ")}`,
            stats,
            errors,
          );
        }
        phase = "buying";
      }

      // --- Buy ---
      if (phase === "buying") {
        if (this.config.dryRun) {
          stats.dryRun = true;
          phase = "awaiting_mailboxes";
        } else {
          const mailboxes = await this.listAllMailboxes(workspaceId);
          const byDomain = countByDomain(mailboxes);
          stats.mailboxCount = mailboxes.length;
          const perDomain = plan.mailboxesPerDomain || 3;
          let seed = mailboxes.length;
          let pendingApprovals = 0;
          for (const row of plan.domains) {
            const have = byDomain.get(row.domain.toLowerCase()) ?? 0;
            const need = Math.max(0, perDomain - have);
            if (need <= 0) continue;
            const batch = [];
            for (let i = 0; i < need; i++) {
              batch.push({
                ...pickName(seed++),
                platform: row.platform,
                domain_name: row.domain,
              });
            }
            const spendKey = `pool-auto-${row.domain}-${row.platform}-n${need}-v3`;
            const decision = await this.spendGateway.authorize({
              key: spendKey,
              kind: "inboxkit_mailbox_purchase",
              description: `Buy ${need} ${row.platform} mailbox(es) on ${row.domain} using InboxKit wallet balance (generic recovery pool).`,
              detail: { domain: row.domain, platform: row.platform, count: need, workspaceId },
            });
            if (!decision.approved) {
              pendingApprovals += 1;
              continue;
            }
            try {
              await this.inboxkit.buyMailboxes(batch, {
                workspaceId,
                useWalletBalance: true,
                idempotencyKey: spendKey,
              });
              stats[`bought:${row.domain}`] = need;
              await sleep(1200);
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              // Already ordered / processing is fine
              if (!/already|duplicate|exist|limit/i.test(message)) {
                errors.push(`buy ${row.domain}: ${message}`);
              }
            }
          }
          stats.pendingSpendApprovals = pendingApprovals;
          if (pendingApprovals > 0) {
            return this.finish(
              "buying",
              previousPhase,
              previousPhase !== "buying",
              `Waiting on spend approval for ${pendingApprovals} domain(s) — see GET /approvals`,
              stats,
              errors,
            );
          }
          phase = "awaiting_mailboxes";
        }
      }

      // --- Wait mailboxes active ---
      if (phase === "awaiting_mailboxes") {
        const mailboxes = await this.listAllMailboxes(workspaceId);
        const active = mailboxes.filter((m) =>
          ["active", "ready"].includes(String(m.status ?? "").toLowerCase()),
        );
        stats.mailboxCount = mailboxes.length;
        stats.activeMailboxes = active.length;
        this.state.setPoolProvision({
          phase,
          mailboxOrdered: mailboxes.length,
          mailboxActive: active.length,
          lastMessage: `Mailboxes ${active.length}/${targetCount} active`,
        });
        if (mailboxes.length < targetCount * 0.9) {
          // Still short — go back to buying next tick
          phase = "buying";
          return this.finish(
            phase,
            previousPhase,
            true,
            `Only ${mailboxes.length}/${targetCount} mailboxes ordered — will retry buy`,
            stats,
            errors,
          );
        }
        if (active.length < targetCount) {
          return this.finish(
            phase,
            previousPhase,
            phase !== previousPhase,
            `Waiting mailbox processing ${active.length}/${targetCount} active (often 6–8h)`,
            stats,
            errors,
          );
        }
        phase = "awaiting_sequencer";
      }

      // --- Sequencer ---
      if (phase === "awaiting_sequencer") {
        const seq = await this.ensureSmartleadSequencer(
          workspaceId,
          errors,
          plan.smartleadSequencerUid,
        );
        stats.hasSequencer = Boolean(seq);
        if (!seq) {
          await this.notifyOnce(
            "pool-need-smartlead-login",
            [
              "*Generic pool — action needed (one-time)*",
              "NS synced and mailboxes are active. To auto-export into Smartlead, either:",
              "1. Set Railway vars `SMARTLEAD_LOGIN_EMAIL` + `SMARTLEAD_LOGIN_PASSWORD` (InboxKit sequencer login), or",
              "2. In InboxKit → DW Generic Pool → Sequencers → connect Smartlead once.",
              "Cron will detect it and finish export + 14-day warmup without further babysitting.",
            ].join("\n"),
          );
          this.state.setPoolProvision({
            phase,
            lastMessage: "Waiting for Smartlead sequencer connection",
          });
          return this.finish(
            phase,
            previousPhase,
            phase !== previousPhase,
            "Waiting for Smartlead sequencer (login env or InboxKit UI)",
            stats,
            errors,
          );
        }
        this.state.setPoolProvision({
          phase: "exporting",
          sequencerUid: seq,
        });
        phase = "exporting";
      }

      // --- Export ---
      if (phase === "exporting") {
        const seq =
          this.state.getPoolProvision().sequencerUid ||
          (await this.ensureSmartleadSequencer(
            workspaceId,
            errors,
            plan.smartleadSequencerUid,
          ));
        if (!seq) {
          phase = "awaiting_sequencer";
          return this.finish(phase, previousPhase, true, "sequencer lost", stats, errors);
        }
        const mailboxes = await this.listAllMailboxes(workspaceId);
        const uids = mailboxes
          .map((m) => m.uid || m.id)
          .filter((x): x is string => Boolean(x));
        // Export in chunks of 20
        for (const chunk of chunkArray(uids, 20)) {
          try {
            await this.inboxkit.exportMailboxesToSequencer(seq, chunk, workspaceId);
            await sleep(800);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            if (!/duplicate|already|skip/i.test(message)) {
              errors.push(`export chunk: ${message}`);
            }
          }
        }
        phase = "awaiting_export";
        this.state.setPoolProvision({
          phase,
          sequencerUid: seq,
          lastMessage: `Export queued for ${uids.length} mailboxes`,
        });
      }

      // --- Await export + appear in Smartlead ---
      if (phase === "awaiting_export" || phase === "importing_state") {
        const planDomains = new Set(
          plan.domains.map((d) => d.domain.toLowerCase()),
        );
        const platformByDomain = new Map(
          plan.domains.map((d) => [d.domain.toLowerCase(), d.platform] as const),
        );
        let accounts: SmartleadAccountWithCampaigns[] = [];
        try {
          accounts = await this.smartlead.listAllEmailAccounts({
            fetchCampaigns: false,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          errors.push(`list Smartlead accounts: ${message}`);
          return this.finish(
            "awaiting_export",
            previousPhase,
            false,
            "Smartlead list failed",
            stats,
            errors,
          );
        }

        const poolAccounts = accounts.filter((a) => {
          const email = accountEmail(a)?.toLowerCase();
          if (!email) return false;
          const domain = email.split("@")[1] ?? "";
          return planDomains.has(domain);
        });
        stats.smartleadPoolAccounts = poolAccounts.length;
        stats.targetMailboxes = targetCount;

        // Always re-export any InboxKit actives still missing from Smartlead
        try {
          const seq =
            this.state.getPoolProvision().sequencerUid ||
            plan.smartleadSequencerUid;
          if (seq) {
            const ikMailboxes = await this.listAllMailboxes(workspaceId);
            const inSmartlead = new Set(
              poolAccounts
                .map((a) => accountEmail(a)?.toLowerCase())
                .filter((x): x is string => Boolean(x)),
            );
            const missingUids = ikMailboxes
              .filter((m) => {
                const email =
                  `${m.username ?? ""}@${m.domain_name ?? m.domain ?? ""}`.toLowerCase();
                return (
                  String(m.status ?? "").toLowerCase() === "active" &&
                  Boolean(m.uid || m.id) &&
                  email.includes("@") &&
                  !inSmartlead.has(email)
                );
              })
              .map((m) => m.uid || m.id)
              .filter((x): x is string => Boolean(x));
            if (missingUids.length) {
              for (const chunk of chunkArray(missingUids, 20)) {
                await this.inboxkit!.exportMailboxesToSequencer(
                  seq,
                  chunk,
                  workspaceId,
                );
                await sleep(800);
              }
              stats.reexportedMissing = missingUids.length;
            }
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          errors.push(`re-export missing: ${message}`);
        }

        if (poolAccounts.length < targetCount * 0.9) {
          // Check export status if possible
          try {
            const seq = this.state.getPoolProvision().sequencerUid;
            if (seq) {
              const status = await this.inboxkit.getExportStatus(workspaceId, {
                sequencerUid: seq,
              });
              stats.exportStatusSample = JSON.stringify(status).slice(0, 200);
            }
          } catch {
            // non-fatal
          }
          phase = "awaiting_export";
          this.state.setPoolProvision({
            phase,
            lastMessage: `Smartlead has ${poolAccounts.length}/${targetCount} pool accounts`,
          });
          return this.finish(
            phase,
            previousPhase,
            phase !== previousPhase,
            `Waiting Smartlead import ${poolAccounts.length}/${targetCount}`,
            stats,
            errors,
          );
        }

        // Warmup + register in state (no campaigns). Re-apply every tick so
        // late-imported mailboxes never sit without warmup.
        const warmedAt = new Date().toISOString();
        let warmed = 0;
        for (const account of poolAccounts) {
          const email = accountEmail(account)!.toLowerCase();
          const domain = email.split("@")[1]!;
          const platform = platformByDomain.get(domain) ?? "GOOGLE";
          const existing = this.state.getPoolMailbox(email);
          try {
            await this.smartlead.configureWarmup(account.id, {
              warmup_enabled: true,
              total_warmup_per_day: this.config.warmupTotalPerDay,
              daily_rampup: this.config.warmupDailyRampup,
              reply_rate_percentage: this.config.warmupReplyRatePercentage,
            });
            warmed += 1;
            await sleep(150);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            errors.push(`warmup ${email}: ${message}`);
          }
          if (existing?.status === "available" || existing?.status === "assigned") {
            // Keep status; just ensure smartlead id is current
            this.state.upsertPoolMailbox({
              ...existing,
              smartleadAccountId: account.id,
            });
            continue;
          }
          const nameParts = (account.from_name || email.split("@")[0] || "Pool User")
            .trim()
            .split(/\s+/);
          this.state.upsertPoolMailbox({
            email,
            domain,
            platform,
            smartleadAccountId: account.id,
            firstName: nameParts[0] || "Pool",
            lastName: nameParts.slice(1).join(" ") || "User",
            status: "warming",
            warmedAt: existing?.warmedAt || warmedAt,
          });
        }
        stats.warmed = warmed;
        phase = "warming";
        this.state.setPoolProvision({
          phase,
          warmupStartedAt: warmedAt,
          lastMessage: `Warmup started for ${poolAccounts.length} accounts`,
        });
        await this.notifyOnce(
          "pool-warmup-started",
          [
            `*Generic pool — warmup started*`,
            `${poolAccounts.length} mailboxes in Smartlead, warmup on, no campaigns.`,
            `Cron will mark them available after ${this.config.poolWarmupDays} days, then recovery swaps can run.`,
          ].join("\n"),
        );
      }

      // --- Warming: keep forcing warmup so late imports never sit cold ---
      // (ready returns early above, so only warming reaches here for refresh)
      if (previousPhase === "warming" || phase === "warming") {
        // Keep forcing warmup on every tick for any newly imported pool accounts
        try {
          const planDomains = new Set(
            plan.domains.map((d) => d.domain.toLowerCase()),
          );
          const accounts = await this.smartlead.listAllEmailAccounts({
            fetchCampaigns: false,
          });
          let forced = 0;
          for (const account of accounts) {
            const email = accountEmail(account)?.toLowerCase();
            if (!email) continue;
            const domain = email.split("@")[1] ?? "";
            if (!planDomains.has(domain)) continue;
            try {
              await this.smartlead.configureWarmup(account.id, {
                warmup_enabled: true,
                total_warmup_per_day: this.config.warmupTotalPerDay,
                daily_rampup: this.config.warmupDailyRampup,
                reply_rate_percentage: this.config.warmupReplyRatePercentage,
              });
              forced += 1;
              await sleep(120);
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              errors.push(`warmup-refresh ${email}: ${message}`);
            }
          }
          stats.warmupForced = forced;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          errors.push(`warmup-refresh list: ${message}`);
        }
      }

      if (phase === "warming") {
        const flipped = this.state.refreshPoolAvailability(
          this.config.poolWarmupDays,
        );
        const all = this.state.listPoolMailboxes();
        const available = all.filter((m) => m.status === "available").length;
        stats.poolRegistered = all.length;
        stats.available = available;
        stats.flipped = flipped;
        if (
          all.length >= targetCount * 0.9 &&
          available >= all.length * 0.9
        ) {
          phase = "ready";
          this.state.setPoolProvision({
            phase,
            lastMessage: "Pool ready for recovery swaps",
            completedAt: new Date().toISOString(),
          });
          await this.notifyOnce(
            "pool-ready",
            [
              `*Generic pool READY*`,
              `${available} generics available for ESP-matched recovery swaps.`,
              `Set \`ENABLE_RECOVERY_POOL=true\` if not already — cron handles the rest.`,
            ].join("\n"),
          );
        } else {
          this.state.setPoolProvision({
            phase: "warming",
            lastMessage: `Warming ${available}/${all.length} available`,
          });
          return this.finish(
            "warming",
            previousPhase,
            flipped > 0 || previousPhase !== "warming",
            `Warming in progress (${available}/${all.length} available)`,
            stats,
            errors,
          );
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message);
      this.state.setPoolProvision({
        phase,
        lastError: message,
        lastMessage: message,
      });
      return this.finish(phase, previousPhase, false, message, stats, errors);
    }

    this.state.setPoolProvision({ phase, lastError: undefined });
    return this.finish(
      phase,
      previousPhase,
      phase !== previousPhase,
      `Phase → ${phase}`,
      stats,
      errors,
    );
  }

  /**
   * The plan ships compiled into dist/ so it is present under every builder.
   * A readable file at planPath still wins, so the pool can be changed on disk
   * without a rebuild; a missing file is normal, not an error.
   */
  private async loadPlan(): Promise<PoolDomainPlan> {
    try {
      const raw = await readFile(this.planPath, "utf8");
      const parsed = JSON.parse(raw) as PoolDomainPlan;
      if (Array.isArray(parsed?.domains) && parsed.domains.length) {
        return parsed;
      }
      console.warn(
        `[pool-provision] ${this.planPath} has no domains — using embedded plan`,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        console.warn(
          `[pool-provision] could not read ${this.planPath} (${error instanceof Error ? error.message : String(error)}) — using embedded plan`,
        );
      }
    }
    return GENERIC_POOL_PLAN;
  }

  /**
   * Register generic mailboxes that live outside the .info pool plan (e.g.
   * ones bought by hand). Matched against Smartlead by email or from_name so
   * they become available for ESP-matched recovery swaps like any other generic.
   */
  async registerExtraGenerics(): Promise<{
    registered: string[];
    unmatched: string[];
    errors: string[];
  }> {
    const out = { registered: [] as string[], unmatched: [] as string[], errors: [] as string[] };
    const wanted = this.config.extraGenericMailboxes;
    if (!wanted.length) return out;

    let accounts: SmartleadAccountWithCampaigns[];
    try {
      accounts = await this.smartlead.listAllEmailAccounts({
        fetchCampaigns: false,
      });
    } catch (error) {
      out.errors.push(
        `list accounts: ${error instanceof Error ? error.message : String(error)}`,
      );
      return out;
    }

    for (const want of wanted) {
      const match = accounts.find((account) => {
        const email = accountEmail(account)?.toLowerCase() ?? "";
        const fromName = String(account.from_name ?? "").trim().toLowerCase();
        return email === want || fromName === want;
      });

      if (!match) {
        out.unmatched.push(want);
        continue;
      }

      const email = accountEmail(match)?.toLowerCase();
      if (!email) {
        out.unmatched.push(want);
        continue;
      }

      const existing = this.state.getPoolMailbox(email);
      if (existing) {
        this.state.upsertPoolMailbox({
          ...existing,
          smartleadAccountId: match.id,
          // Pre-warmed: never leave one parked in "warming" waiting out a
          // warmup clock it already served.
          status: existing.status === "warming" ? "available" : existing.status,
          ...(existing.status === "warming"
            ? { availableAt: new Date().toISOString() }
            : {}),
        });
        continue;
      }

      const platform = poolEspFromSmartleadType(match.type);
      if (!platform) {
        out.errors.push(
          `${want}: unknown ESP type (${match.type ?? "n/a"}) — cannot ESP-match swaps`,
        );
        continue;
      }

      const { firstName, lastName } = parsePersonName(
        match.from_name || email.split("@")[0],
      );
      this.state.upsertPoolMailbox({
        email,
        domain: email.split("@")[1] ?? "",
        platform,
        smartleadAccountId: match.id,
        firstName,
        lastName,
        // Already-live mailboxes are warm; make them usable immediately.
        status: "available",
        warmedAt: new Date().toISOString(),
        availableAt: new Date().toISOString(),
      });
      out.registered.push(email);
    }

    if (out.registered.length || out.unmatched.length) {
      console.log("[pool-provision] extra generics", out);
      await this.state.save();
    }
    return out;
  }

  private async listAllMailboxes(
    workspaceId: string,
  ): Promise<InboxKitMailbox[]> {
    const rows = await this.inboxkit!.listMailboxes({
      workspaceId,
      limit: 250,
    });
    return rows;
  }

  private async ensureSmartleadSequencer(
    workspaceId: string,
    errors: string[],
    planSequencerUid?: string,
  ): Promise<string | null> {
    try {
      if (planSequencerUid) {
        this.state.setPoolProvision({ sequencerUid: planSequencerUid });
        return planSequencerUid;
      }
      const listed = await this.inboxkit!.listSequencers(workspaceId);
      const existing = listed.find((s) =>
        /smartlead/i.test(String(s.platform ?? s.name ?? "")),
      );
      const uid = existing?.uid || existing?.id;
      if (uid) return String(uid);

      const login = this.config.smartleadLoginEmail;
      const password = this.config.smartleadLoginPassword;
      if (!login || !password) return null;

      const created = await this.inboxkit!.addSequencer(
        {
          name: "Smartlead (DW Generic Pool)",
          platform: "smartlead",
          sequencer_login: login,
          sequencer_password: password,
          api_key: this.config.smartleadApiKey || undefined,
          enable_warmup: true,
          warmup_limit: this.config.warmupTotalPerDay,
          warmup_replyrate: this.config.warmupReplyRatePercentage,
          warmup_increment: String(this.config.warmupDailyRampup),
          auto_reconnect_mailboxes: true,
        },
        workspaceId,
      );
      return created;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`sequencer: ${message}`);
      return null;
    }
  }

  private async notifyOnce(key: string, text: string): Promise<void> {
    if (this.state.hasAlert(`pool-provision:${key}`)) return;
    try {
      await this.slack.send(text);
      this.state.markAlert(`pool-provision:${key}`);
    } catch (error) {
      console.error("[pool-provision] Slack failed", error);
    }
  }

  private async finish(
    phase: PoolProvisionPhase,
    previousPhase: PoolProvisionPhase,
    advanced: boolean,
    message: string,
    stats: Record<string, number | string | boolean>,
    errors: string[],
  ): Promise<PoolProvisionResult> {
    this.state.setPoolProvision({
      phase,
      lastMessage: message,
      lastCheckedAt: new Date().toISOString(),
      ...(errors.length ? { lastError: errors[0] } : {}),
    });
    await this.state.save();
    console.log("[pool-provision]", {
      phase,
      previousPhase,
      advanced,
      message,
      stats,
      errors: errors.length,
    });
    return { phase, previousPhase, advanced, message, stats, errors };
  }
}

function pickName(seed: number): {
  first_name: string;
  last_name: string;
  username: string;
} {
  const first = FIRST_NAMES[seed % FIRST_NAMES.length]!;
  const last =
    LAST_NAMES[Math.floor(seed / FIRST_NAMES.length) % LAST_NAMES.length]!;
  const username = `${first}${last}`.toLowerCase().replace(/[^a-z0-9]/g, "");
  return { first_name: first, last_name: last, username };
}

function countByDomain(mailboxes: InboxKitMailbox[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const m of mailboxes) {
    const email = (m.email || m.address || "").toLowerCase();
    const domain = (
      (m as { domain_name?: string }).domain_name ||
      m.domain ||
      (email.includes("@") ? email.split("@")[1] : "") ||
      ""
    ).toLowerCase();
    if (!domain) continue;
    map.set(domain, (map.get(domain) ?? 0) + 1);
  }
  return map;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// silence unused type import in case of strip
export type { InboxKitDomain };
