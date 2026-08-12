import { humanizeAlertError, isRateLimitNoise } from "./alertNoise.js";

/**
 * Exec briefing for Slack — high-level Done / Needs attention / Quiet.
 * Rules must not fail silently: errors and coverage gaps always surface here.
 */

export interface BriefingBullet {
  text: string;
  /** When true, bullet belongs under Needs attention. */
  attention?: boolean;
}

export interface ExecBriefingInput {
  title: string;
  /** Actions that completed successfully. */
  done?: string[];
  /** Problems Josh should act on or watch. */
  attention?: string[];
  /** Subsystems that ran clean with nothing to do (so silence is intentional). */
  quiet?: string[];
}

export function formatExecBriefing(input: ExecBriefingInput): string {
  const done = (input.done ?? []).filter(Boolean);
  const attention = (input.attention ?? []).filter(Boolean);
  const quiet = (input.quiet ?? []).filter(Boolean);

  const lines = [`*Ops briefing — ${input.title}*`];

  if (done.length) {
    lines.push("*Done*");
    for (const item of done.slice(0, 12)) lines.push(`• ${item}`);
  }

  lines.push("*Needs attention*");
  if (attention.length) {
    for (const item of attention.slice(0, 15)) lines.push(`• ${item}`);
  } else {
    lines.push("• None");
  }

  if (quiet.length) {
    lines.push("*Quiet (ran, nothing to fix)*");
    for (const item of quiet.slice(0, 10)) lines.push(`• ${item}`);
  }

  return lines.join("\n");
}

export function seriousErrors(errors: unknown): string[] {
  if (!Array.isArray(errors)) return [];
  return errors
    .map((e) => (typeof e === "string" ? e : String(e)))
    .filter((e) => e && !isRateLimitNoise(e))
    .map(humanizeAlertError);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Build a monitor-cycle exec briefing from the run bundle. */
export function briefingFromMonitorBundle(bundle: {
  monitor?: unknown;
  remediation?: unknown;
  warmupGate?: unknown;
  testReconcile?: unknown;
  dnsAudit?: unknown;
  campaignAudit?: unknown;
  bounceInvestigate?: unknown;
}): ExecBriefingInput {
  const done: string[] = [];
  const attention: string[] = [];
  const quiet: string[] = [];

  const monitor = asRecord(bundle.monitor);
  if (monitor) {
    const checked = num(monitor.testsChecked);
    const blacklist = num(monitor.blacklistAlerts);
    const low = num(monitor.lowDeliverabilityAlerts);
    if (blacklist || low) {
      done.push(
        `Placement monitor: ${checked} test(s) checked — ${blacklist} blacklist alert(s), ${low} low-inbox alert(s)`,
      );
    } else if (checked > 0) {
      quiet.push(`Placement monitor: ${checked} test(s) checked, no alerts`);
    }
    for (const err of seriousErrors(monitor.errors)) {
      attention.push(`Monitor error: ${err}`);
    }
  } else {
    attention.push("Placement monitor did not return a result");
  }

  const rem = asRecord(bundle.remediation);
  if (rem) {
    const deleted = Array.isArray(rem.deletedSmartleadAccounts)
      ? rem.deletedSmartleadAccounts.length
      : 0;
    const recovered = Array.isArray(rem.recoveredInboxes)
      ? rem.recoveredInboxes.length
      : 0;
    if (deleted || recovered) {
      done.push(
        `Remediation: deleted ${deleted} blacklisted account(s), recovered/held ${recovered}`,
      );
    } else {
      quiet.push("Remediation: nothing to delete/recover");
    }
    for (const err of seriousErrors(rem.errors)) {
      attention.push(`Remediation error: ${err}`);
    }
  }

  const warmup = asRecord(bundle.warmupGate);
  if (warmup) {
    const removed = num(warmup.removed);
    if (removed > 0) {
      done.push(`Warmup gate: pulled ${removed} under-warmed/held sender(s)`);
    } else {
      quiet.push("Warmup gate: no pulls");
    }
    for (const err of seriousErrors(warmup.errors)) {
      attention.push(`Warmup gate error: ${err}`);
    }
  }

  const reconcile = asRecord(bundle.testReconcile);
  if (reconcile) {
    const stopped = Array.isArray(reconcile.stopped)
      ? reconcile.stopped.length
      : 0;
    const deleted = Array.isArray(reconcile.deleted)
      ? reconcile.deleted.length
      : 0;
    const orphaned = Array.isArray(reconcile.orphaned)
      ? reconcile.orphaned.length
      : 0;
    if (stopped || deleted) {
      done.push(
        `Test reconciler: stopped ${stopped}, deleted ${deleted} inactive-campaign test(s)`,
      );
    } else {
      quiet.push("Test reconciler: no stops/deletes");
    }
    if (orphaned > 0) {
      attention.push(
        `Test reconciler: ${orphaned} orphaned test(s) still need manual check`,
      );
    }
    for (const err of seriousErrors(reconcile.errors)) {
      attention.push(`Test reconciler error: ${err}`);
    }
  }

  const dns = asRecord(bundle.dnsAudit);
  if (dns) {
    const failing = Array.isArray(dns.failing) ? dns.failing.length : num(dns.alerts);
    if (failing > 0) {
      attention.push(`DNS audit: ${failing} domain(s) failing SPF/DKIM/DMARC`);
    } else {
      quiet.push("DNS audit: no zone faults");
    }
    for (const err of seriousErrors(dns.errors)) {
      attention.push(`DNS audit error: ${err}`);
    }
  }

  const audit = asRecord(bundle.campaignAudit);
  if (audit) {
    const untested = Array.isArray(audit.untested) ? audit.untested : [];
    const understaffed = Array.isArray(audit.understaffed)
      ? audit.understaffed
      : [];
    if (untested.length) {
      const names = untested
        .slice(0, 5)
        .map((r) => {
          const row = asRecord(r);
          return row
            ? `#${row.id} ${String(row.name ?? "").slice(0, 40)}`
            : "?";
        })
        .join("; ");
      attention.push(
        `ACTIVE campaigns without a living placement test (${untested.length}): ${names}${untested.length > 5 ? "…" : ""}`,
      );
    } else {
      quiet.push("Campaign audit: every ACTIVE campaign has placement coverage");
    }
    if (understaffed.length) {
      const names = understaffed
        .slice(0, 5)
        .map((r) => {
          const row = asRecord(r);
          return row
            ? `#${row.id} short ${row.shortBy}`
            : "?";
        })
        .join("; ");
      attention.push(
        `Understaffed ACTIVE campaigns (${understaffed.length}, shortfall ${num(audit.totalShortfall)}): ${names}${understaffed.length > 5 ? "…" : ""}`,
      );
    } else {
      quiet.push("Campaign audit: no understaffed ACTIVE campaigns");
    }
  }

  const bounce = asRecord(bundle.bounceInvestigate);
  if (bounce) {
    const findings = Array.isArray(bounce.findings) ? bounce.findings.length : 0;
    if (findings) {
      done.push(
        `Bounce investigate: ${findings} paused high-bounce campaign(s) reviewed`,
      );
    } else {
      quiet.push("Bounce investigate: nothing triggered");
    }
    for (const err of seriousErrors(bounce.errors)) {
      attention.push(`Bounce investigate error: ${err}`);
    }
  }

  return {
    title: "monitor",
    done,
    attention,
    quiet,
  };
}

/** Build a health-cycle briefing; caller posts only when attention is non-empty or force. */
export function briefingFromHealthBundle(bundle: {
  health?: unknown;
  reconnect?: unknown;
  mailboxGap?: unknown;
  mailboxSettings?: unknown;
}): ExecBriefingInput {
  const done: string[] = [];
  const attention: string[] = [];
  const quiet: string[] = [];

  const health = asRecord(bundle.health);
  if (health) {
    const topUp = asRecord(health.topUp);
    const assigned = Array.isArray(topUp?.assigned) ? topUp!.assigned.length : 0;
    const resumed = Array.isArray(health.resumed) ? health.resumed.length : 0;
    const stillShort = Array.isArray(health.stillShort)
      ? health.stillShort
      : [];
    if (assigned || resumed) {
      done.push(
        `Campaign health: topped up ${assigned} sender(s), resumed ${resumed} campaign(s)`,
      );
    } else {
      quiet.push("Campaign health: no top-ups/resumes");
    }
    if (stillShort.length) {
      const names = stillShort
        .slice(0, 6)
        .map((r) => {
          const row = asRecord(r);
          return row
            ? `#${row.campaignId} ${String(row.name ?? "").slice(0, 36)} short ${row.shortBy}`
            : "?";
        })
        .join("; ");
      attention.push(
        `Still not staffed to floor (${stillShort.length}): ${names}${stillShort.length > 6 ? "…" : ""}`,
      );
    }
    for (const err of seriousErrors(health.errors)) {
      attention.push(`Health error: ${err}`);
    }
  } else {
    attention.push("Campaign health did not return a result");
  }

  const reconnect = asRecord(bundle.reconnect);
  if (reconnect) {
    const reconnected = num(reconnect.reconnected);
    const failed = num(reconnect.failed);
    const disconnected = num(reconnect.disconnected);
    if (reconnected > 0) {
      done.push(`Reconnect: restored ${reconnected} of ${disconnected} disconnected`);
    } else if (disconnected === 0) {
      quiet.push("Reconnect: no disconnected accounts");
    }
    if (failed > 0) {
      attention.push(
        `Reconnect: ${failed} still need manual OAuth in Smartlead`,
      );
    }
    for (const err of seriousErrors(reconnect.errors)) {
      attention.push(`Reconnect error: ${err}`);
    }
  }

  const gap = asRecord(bundle.mailboxGap);
  if (gap) {
    const minGapSet = num(gap.minGapSet);
    const sendLimitSet = num(gap.sendLimitSet);
    if (minGapSet > 0) {
      attention.push(
        `Mailbox min-gap drift: fixed ${minGapSet} mailbox(es) back to 10 minutes (D30)`,
      );
    } else {
      quiet.push("Mailbox gap: all at 10 minutes");
    }
    if (sendLimitSet > 0) {
      done.push(`Mailbox volume: reset ${sendLimitSet} to 30/day`);
    }
    for (const err of seriousErrors(gap.errors)) {
      attention.push(`Mailbox gap error: ${err}`);
    }
  }

  const settings = asRecord(bundle.mailboxSettings);
  if (settings) {
    const sig = num(settings.signatureSet);
    const warm = num(settings.warmupEnabled);
    if (sig || warm) {
      done.push(
        `Mailbox full converge: ${sig} signature(s), ${warm} warmup(s)`,
      );
    }
    for (const err of seriousErrors(settings.errors)) {
      attention.push(`Mailbox settings error: ${err}`);
    }
  }

  return {
    title: "health",
    done,
    attention,
    quiet,
  };
}

export function briefingNeedsPost(
  briefing: ExecBriefingInput,
  opts: { force?: boolean } = {},
): boolean {
  if (opts.force) return true;
  return (briefing.attention ?? []).length > 0 || (briefing.done ?? []).length > 0;
}
