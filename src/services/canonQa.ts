/**
 * Canon QA as a wizard stage (non-canon, read-only, no Slack).
 *
 * The Deliverability bot used to run "canon QA" by hand every ~30 minutes:
 * curl /health, compare open findings and overdue stages with the last look,
 * stay silent unless something is NEWLY broken. This does that inside the
 * 15-minute health pass so it needs no bot usage.
 *
 * Output goes to the Supabase queue `claude.bot_wake_queue` (bot
 * 'deliverability', kind 'canon_qa'), never to Slack, and only when something
 * is newly broken. A pass that is clean or unchanged writes nothing. It reads
 * state only: no Smartlead call, no mutation, nothing client-facing, and it
 * never changes WRITE_ENABLED or any campaign.
 */

export interface CanonQaSnapshot {
  at: string;
  /** open findings by kind (living campaigns + generic pool), same numbers as /health canonFindings */
  findings: Record<string, number>;
  overdueStages: string[];
  canaryFleetDown: boolean;
}

export interface CanonQaInput {
  at: string;
  findings: Record<string, number>;
  overdueStages: string[];
  canaryFleetDown: boolean;
}

export interface CanonQaResult {
  /** first look: baseline stored, nothing reported */
  seeded: boolean;
  newlyBroken: string[];
  cleared: string[];
  snapshot: CanonQaSnapshot;
  /** one line for the log / queue headline */
  summary: string;
}

export interface CanonQaQueueItem {
  kind: "canon_qa";
  dedupeKey: string;
  headline: string;
  payload: Record<string, unknown>;
}

export interface CanonQaSink {
  enqueue(item: CanonQaQueueItem): Promise<boolean>;
}

/**
 * Kinds that only move with normal churn and are tracked on the board, not
 * paged: a count that went UP by this much or less is not "newly broken".
 * Everything else pages on any increase. (Zero tolerance keeps it honest.)
 */
export const QA_INCREASE_TOLERANCE: Record<string, number> = {};

export function evaluateCanonQa(
  input: CanonQaInput,
  prev: CanonQaSnapshot | null,
): CanonQaResult {
  const snapshot: CanonQaSnapshot = {
    at: input.at,
    findings: { ...input.findings },
    overdueStages: [...input.overdueStages].sort(),
    canaryFleetDown: input.canaryFleetDown,
  };
  if (!prev) {
    return {
      seeded: true,
      newlyBroken: [],
      cleared: [],
      snapshot,
      summary: "canon QA baseline stored",
    };
  }
  const newlyBroken: string[] = [];
  const cleared: string[] = [];
  const kinds = new Set([
    ...Object.keys(prev.findings),
    ...Object.keys(input.findings),
  ]);
  for (const kind of [...kinds].sort()) {
    const before = prev.findings[kind] ?? 0;
    const now = input.findings[kind] ?? 0;
    const tolerance = QA_INCREASE_TOLERANCE[kind] ?? 0;
    if (now > before + tolerance) {
      newlyBroken.push(`finding ${kind} ${before} -> ${now}`);
    } else if (now < before) {
      cleared.push(`finding ${kind} ${before} -> ${now}`);
    }
  }
  const prevOverdue = new Set(prev.overdueStages);
  for (const name of snapshot.overdueStages) {
    if (!prevOverdue.has(name)) newlyBroken.push(`stage ${name} overdue`);
  }
  for (const name of prev.overdueStages) {
    if (!snapshot.overdueStages.includes(name)) cleared.push(`stage ${name} recovered`);
  }
  if (input.canaryFleetDown && !prev.canaryFleetDown) {
    newlyBroken.push("canary fleet down");
  } else if (!input.canaryFleetDown && prev.canaryFleetDown) {
    cleared.push("canary fleet recovered");
  }
  const summary = newlyBroken.length
    ? `canon QA: ${newlyBroken.length} newly broken: ${newlyBroken.slice(0, 6).join("; ")}`
    : `canon QA: nothing newly broken${cleared.length ? `, ${cleared.length} cleared` : ""}`;
  return { seeded: false, newlyBroken, cleared, snapshot, summary };
}

/** Queue item for a pass that found something newly broken; null when silent. */
export function canonQaQueueItem(
  result: CanonQaResult,
  deploySha: string | null,
): CanonQaQueueItem | null {
  if (result.seeded || result.newlyBroken.length === 0) return null;
  return {
    kind: "canon_qa",
    dedupeKey: `canon-qa:${result.snapshot.at}`,
    headline: result.summary,
    payload: {
      source: "deliverabilitywizard",
      stage: "canon-qa",
      at: result.snapshot.at,
      deploy: deploySha,
      newly_broken: result.newlyBroken,
      cleared: result.cleared,
      open_findings: result.snapshot.findings,
      overdue_stages: result.snapshot.overdueStages,
      canary_fleet_down: result.snapshot.canaryFleetDown,
      note: "Read-only QA from the health pass. Nothing was changed. No Slack post was made.",
    },
  };
}

export class CanonQaService {
  constructor(
    private readonly deps: {
      load: () => CanonQaSnapshot | null;
      save: (snapshot: CanonQaSnapshot) => void;
      sink: CanonQaSink | null;
      deploySha: () => string | null;
      log?: (line: string) => void;
    },
  ) {}

  async run(input: CanonQaInput): Promise<{
    seeded: boolean;
    newlyBroken: number;
    queued: boolean;
    summary: string;
  }> {
    const log = this.deps.log ?? ((line: string) => console.log(`[canon-qa] ${line}`));
    const result = evaluateCanonQa(input, this.deps.load());
    const item = canonQaQueueItem(result, this.deps.deploySha());
    let queued = false;
    if (item) {
      if (this.deps.sink) {
        try {
          queued = await this.deps.sink.enqueue(item);
        } catch (error) {
          // Keep the old baseline so the same breakage is retried next pass.
          log(`queue write failed, will retry next pass: ${(error as Error).message}`);
          return { seeded: false, newlyBroken: result.newlyBroken.length, queued: false, summary: result.summary };
        }
      } else {
        log("no queue configured (WAKE_QUEUE_DATABASE_URL unset); logging only");
      }
    }
    this.deps.save(result.snapshot);
    log(result.summary);
    return { seeded: result.seeded, newlyBroken: result.newlyBroken.length, queued, summary: result.summary };
  }
}
