import type { AppConfig } from "../config.js";
import type { CursorCloudClient } from "../clients/cursorCloud.js";
import type { SlackClient } from "../clients/slack.js";
import {
  classifyFailure,
  type ClassifiedFailure,
} from "../lib/failureClassifier.js";
import type { BugRemediationRecord, StateStore } from "../state/store.js";

export interface BugRemediatorResult {
  observed: number;
  triggered: number;
  skipped: string[];
  agentUrls: string[];
  errors: string[];
}

const ACTOR = "bug-remediator";

/**
 * Turns repeated runtime failures into Cursor Cloud Agent draft PRs so Josh
 * does not have to chase every SmartDelivery validation / stale-endpoint bug.
 *
 * Never spends, deletes, bypasses holds, or pushes to main — D18/D20/D21/D41.
 */
export class BugRemediator {
  private inFlight = false;

  constructor(
    private readonly config: AppConfig,
    private readonly cursor: CursorCloudClient | null,
    private readonly slack: SlackClient,
    private readonly state: StateStore,
  ) {}

  enabled(): boolean {
    return (
      this.config.enableBugRemediator &&
      Boolean(this.cursor) &&
      Boolean(this.config.cursorApiKey)
    );
  }

  /**
   * Record one failure. May launch a Cursor agent when the fingerprint has
   * been seen enough times and is off cooldown.
   */
  async observe(
    source: string,
    error: unknown,
  ): Promise<{ classified: ClassifiedFailure; launched: boolean }> {
    const classified = classifyFailure(source, error);
    if (!this.enabled() || !classified.autoRemediate) {
      return { classified, launched: false };
    }

    const now = new Date();
    const record = this.state.bumpBugRemediation({
      fingerprint: classified.fingerprint,
      failureClass: classified.class,
      summary: classified.summary,
      lastError: classified.raw,
      source,
      at: now.toISOString(),
    });
    await this.state.save();

    if (!this.shouldLaunch(record, now)) {
      return { classified, launched: false };
    }

    try {
      const launched = await this.launch(classified, record);
      return { classified, launched };
    } catch (launchError) {
      const message =
        launchError instanceof Error
          ? launchError.message
          : String(launchError);
      console.error("[bug-remediator] launch failed", message);
      this.state.markBugRemediation(classified.fingerprint, {
        status: "watching",
        lastError: `launch failed: ${message}`,
      });
      await this.state.save();
      return { classified, launched: false };
    }
  }

  /** Observe many errors from a scan/monitor result.errors array. */
  async observeMany(
    source: string,
    errors: string[],
  ): Promise<BugRemediatorResult> {
    const result: BugRemediatorResult = {
      observed: 0,
      triggered: 0,
      skipped: [],
      agentUrls: [],
      errors: [],
    };
    if (!errors.length) return result;

    for (const err of errors.slice(0, 25)) {
      result.observed += 1;
      try {
        const { classified, launched } = await this.observe(source, err);
        if (launched) {
          result.triggered += 1;
          const row = this.state.getBugRemediation(classified.fingerprint);
          if (row?.agentUrl) result.agentUrls.push(row.agentUrl);
        } else if (!classified.autoRemediate) {
          result.skipped.push(classified.fingerprint);
        }
      } catch (error) {
        result.errors.push(
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return result;
  }

  private shouldLaunch(record: BugRemediationRecord, now: Date): boolean {
    if (record.status === "ignored") return false;
    if (this.inFlight) return false;

    const minHits = this.config.bugRemediatorMinHits;
    if (record.count < minHits) return false;

    if (record.lastTriggeredAt) {
      const last = Date.parse(record.lastTriggeredAt);
      const cooldownMs = this.config.bugRemediatorCooldownHours * 3600_000;
      if (Number.isFinite(last) && now.getTime() - last < cooldownMs) {
        return false;
      }
    }

    // Don't re-launch if a PR is already open for this fingerprint.
    if (record.status === "pr_open" && record.prUrl) return false;

    return true;
  }

  private async launch(
    classified: ClassifiedFailure,
    record: BugRemediationRecord,
  ): Promise<boolean> {
    if (!this.cursor) return false;
    this.inFlight = true;
    try {
      const prompt = buildRemediatorPrompt(classified, record, this.config);
      const existingId = this.state.getOpsCursorAgentId(ACTOR);

      let agentId: string;
      let agentUrl: string;
      let runId: string;

      if (existingId) {
        try {
          const agent = await this.cursor.getAgent(existingId);
          const created = await this.cursor.createRun(existingId, {
            prompt,
            mode: "agent",
          });
          agentId = existingId;
          agentUrl = agent.url || `https://cursor.com/agents/${existingId}`;
          runId = created.run.id;
        } catch {
          this.state.clearOpsCursorAgentId(ACTOR);
          const created = await this.cursor.createAgent({
            prompt,
            model: {
              id: this.config.cursorAgentModelId,
              params: this.config.cursorAgentModelParams,
            },
            repositoryUrl: this.config.cursorAgentRepositoryUrl,
            startingRef: this.config.cursorAgentStartingRef,
            name: "Bug remediator",
            mode: "agent",
            autoCreatePR: true,
          });
          agentId = created.agent.id;
          agentUrl =
            created.agent.url || `https://cursor.com/agents/${agentId}`;
          runId = created.run.id;
          this.state.setOpsCursorAgentId(ACTOR, agentId);
        }
      } else {
        const created = await this.cursor.createAgent({
          prompt,
          model: {
            id: this.config.cursorAgentModelId,
            params: this.config.cursorAgentModelParams,
          },
          repositoryUrl: this.config.cursorAgentRepositoryUrl,
          startingRef: this.config.cursorAgentStartingRef,
          name: "Bug remediator",
          mode: "agent",
          autoCreatePR: true,
        });
        agentId = created.agent.id;
        agentUrl = created.agent.url || `https://cursor.com/agents/${agentId}`;
        runId = created.run.id;
        this.state.setOpsCursorAgentId(ACTOR, agentId);
      }

      this.state.markBugRemediation(classified.fingerprint, {
        status: "triggered",
        lastTriggeredAt: new Date().toISOString(),
        agentId,
        agentUrl,
        runId,
      });
      await this.state.save();

      await this.slack.send(
        [
          `*Auto bug remediator*`,
          classified.summary,
          `Fingerprint: \`${classified.fingerprint}\` (${record.count} hits)`,
          `Cursor is opening a fix PR — no spend/delete/deploy.`,
          agentUrl,
        ].join("\n"),
      );

      console.log(
        `[bug-remediator] Launched Cursor agent for ${classified.fingerprint}: ${agentUrl}`,
      );
      return true;
    } finally {
      this.inFlight = false;
    }
  }
}

export function buildRemediatorPrompt(
  classified: ClassifiedFailure,
  record: BugRemediationRecord,
  config: AppConfig,
): string {
  const autoMerge = config.bugRemediatorAutoMerge
    ? [
        "After CI is green, merge the PR into main yourself (gh pr merge or the",
        "repo's merge tooling) so Railway deploys without waiting for Josh.",
        "If you cannot merge (permissions/branch protection), leave the PR ready",
        "for review and say so clearly in Slack/PR body.",
      ].join("\n")
    : [
        "Open a ready-for-review PR. Do NOT merge — this Cursor identity cannot",
        "merge to main (D41). Josh merges after review.",
      ].join("\n");

  return [
    "You are the Deliverability Wizard **auto bug remediator**.",
    "Production hit a repeated failure. Fix it with a focused PR.",
    "",
    "Hard rules (do not violate):",
    "- Never buy domains/mailboxes or spend money.",
    "- Never delete/purge domains or mailboxes.",
    "- Never bypass warmup, recovery holds, or spend-approval gates.",
    "- Never reverse DECISIONS.md without Josh.",
    "- Never force-push. Prefer branch `cursor/auto-<short-name>-2606`.",
    "- Do not expand scope beyond this failure.",
    "",
    "Failure:",
    `- Class: ${classified.class}`,
    `- Fingerprint: ${classified.fingerprint}`,
    `- Summary: ${classified.summary}`,
    `- Hits: ${record.count}`,
    `- Source: ${record.source}`,
    `- Last error:`,
    "```",
    classified.raw.slice(0, 1500),
    "```",
    "",
    "Tasks:",
    "1. Reproduce from the error text against the current main code.",
    "2. Implement the smallest correct fix with tests.",
    "3. Run `npm test` and `npm run typecheck`.",
    "4. Open a PR (autoCreatePR is on).",
    autoMerge,
    "5. Keep the PR body plain English: what broke, why, how you fixed it.",
  ].join("\n");
}
