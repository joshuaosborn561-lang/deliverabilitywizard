/**
 * SOP 5 calling board. One card per client. Queue rows are rolled up.
 * Counts only — the builder drops any field that is not a count, a
 * client label, a last-4, or a fixed reason code.
 */

export const ALLO_QUEUE_TARGET = 300;
export const CALLED_THREE_TIMES = 3;

export type CallingReason =
  | "contact had no email"
  | "router timeout"
  | "router skip"
  | "dnc hook"
  | null;

export interface CallingClientInput {
  clientName: string;
  queueContacts: number;
  queues: number;
  queuesFull: number;
  missingEmail: number;
  queuesCalled3: number;
  voicemailsYesterday: number;
  emailsYesterday: number;
  mismatchReason: CallingReason;
  routerErrors: number;
  dncHookErrors: number | null;
}

export interface CallingNumberInput {
  clientName: string;
  label: string;
  last4: string;
  daysSinceRotation: number | null;
  spamLikely: boolean | null;
}

export interface CallingSuppressionInput {
  dnc: number;
  dncStillQueued: number;
  unsub: number;
  unsubStillQueued: number;
  unsubStillEmailed: number;
}

export interface CallingTagInput {
  voicemailCalls: number;
  voicemailTagged: number;
  untaggedOver30s: number;
}

export interface CallingSnapshot {
  updatedAt: string;
  partial: boolean;
  edgeLogs: "unchecked" | "checked";
  clients: CallingClientInput[];
  numbers: CallingNumberInput[];
  suppression: CallingSuppressionInput;
  tagging: CallingTagInput;
  gabeDialsYesterday: number;
  gabeDialsTarget: number | null;
}

export interface CallingFailure {
  id: string;
  text: string;
}

export interface CallingClientCard {
  clientName: string;
  queueContacts: number;
  queueTarget: number;
  queues: number;
  queuesFull: number;
  missingEmail: number;
  buildNextList: boolean;
  voicemailsYesterday: number;
  emailsYesterday: number;
  mismatchReason: CallingReason;
  routerErrors: number;
  dncHookErrors: number | null;
  bringToJosh: boolean;
  ok: boolean;
  failures: CallingFailure[];
}

export interface CallingBoard {
  updatedAt: string | null;
  queueTarget: number;
  queuesFull: number;
  queuesTracked: number;
  voicemailsYesterday: number;
  emailsYesterday: number;
  routerOrDncErrors: number;
  spamLikely: number;
  gabeDialsYesterday: number | null;
  gabeDialsTarget: number | null;
  tagging: CallingTagInput | null;
  suppression: CallingSuppressionInput | null;
  numbers: CallingNumberInput[];
  edgeLogs: "unchecked" | "checked" | "none";
  clients: CallingClientCard[];
}

const REASONS = new Set<Exclude<CallingReason, null>>([
  "contact had no email",
  "router timeout",
  "router skip",
  "dnc hook",
]);

export function callingClientKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function count(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

function reasonOf(value: unknown): CallingReason {
  if (typeof value !== "string") return null;
  return REASONS.has(value as Exclude<CallingReason, null>)
    ? (value as Exclude<CallingReason, null>)
    : value.trim()
      ? "router skip"
      : null;
}

export function failuresForClient(row: CallingClientInput, edgeLogs: CallingSnapshot["edgeLogs"]): CallingFailure[] {
  const failures: CallingFailure[] = [];
  if (row.missingEmail > 0) {
    failures.push({
      id: "missing-email",
      text: `${row.missingEmail} contacts missing an email`,
    });
  }
  if (row.queuesCalled3 > 0) {
    failures.push({
      id: "build-next-list",
      text: `${row.queuesCalled3} queue${row.queuesCalled3 === 1 ? "" : "s"} called 3× — build next list`,
    });
  }
  if (row.voicemailsYesterday !== row.emailsYesterday) {
    failures.push({
      id: "voicemail-mismatch",
      text: `Yesterday ${row.voicemailsYesterday} voicemails vs ${row.emailsYesterday} emails${
        row.mismatchReason ? ` — ${row.mismatchReason}` : ""
      }`,
    });
  }
  if (row.routerErrors > 0) {
    failures.push({
      id: "router-errors",
      text: `Voicemail router errors: ${row.routerErrors} — bring to Josh`,
    });
  }
  if (row.dncHookErrors == null || edgeLogs === "unchecked") {
    failures.push({
      id: "dnc-unchecked",
      text: "DNC hook edge logs: can't check",
    });
  } else if (row.dncHookErrors > 0) {
    failures.push({
      id: "dnc-errors",
      text: `DNC hook errors: ${row.dncHookErrors} — bring to Josh`,
    });
  }
  return failures;
}

export function buildCallingBoard(input: {
  snapshot?: CallingSnapshot | null;
}): CallingBoard {
  const snapshot = input.snapshot ?? null;
  const edgeLogs = snapshot?.edgeLogs ?? "none";
  const clients = (snapshot?.clients ?? [])
    .map((row) => {
      const failures = failuresForClient(row, snapshot?.edgeLogs ?? "unchecked");
      const bringToJosh =
        row.routerErrors > 0 || (row.dncHookErrors != null && row.dncHookErrors > 0);
      return {
        clientName: row.clientName,
        queueContacts: count(row.queueContacts),
        queueTarget: ALLO_QUEUE_TARGET,
        queues: count(row.queues),
        queuesFull: count(row.queuesFull),
        missingEmail: count(row.missingEmail),
        buildNextList: count(row.queuesCalled3) > 0,
        voicemailsYesterday: count(row.voicemailsYesterday),
        emailsYesterday: count(row.emailsYesterday),
        mismatchReason: reasonOf(row.mismatchReason),
        routerErrors: count(row.routerErrors),
        dncHookErrors: row.dncHookErrors == null ? null : count(row.dncHookErrors),
        bringToJosh,
        ok: failures.length === 0,
        failures,
      };
    })
    .sort((a, b) => a.clientName.localeCompare(b.clientName));

  let queuesFull = 0;
  let queuesTracked = 0;
  let voicemailsYesterday = 0;
  let emailsYesterday = 0;
  let routerOrDncErrors = 0;
  for (const client of clients) {
    queuesFull += client.queuesFull;
    queuesTracked += client.queues;
    voicemailsYesterday += client.voicemailsYesterday;
    emailsYesterday += client.emailsYesterday;
    routerOrDncErrors += client.routerErrors + (client.dncHookErrors ?? 0);
  }

  return {
    updatedAt: snapshot?.updatedAt ?? null,
    queueTarget: ALLO_QUEUE_TARGET,
    queuesFull,
    queuesTracked,
    voicemailsYesterday,
    emailsYesterday,
    routerOrDncErrors,
    spamLikely: (snapshot?.numbers ?? []).filter((row) => row.spamLikely === true).length,
    gabeDialsYesterday: snapshot ? count(snapshot.gabeDialsYesterday) : null,
    gabeDialsTarget: snapshot?.gabeDialsTarget ?? null,
    tagging: snapshot?.tagging ?? null,
    suppression: snapshot?.suppression ?? null,
    numbers: snapshot?.numbers ?? [],
    edgeLogs,
    clients,
  };
}

export function callingLanes(snapshot: CallingSnapshot | null | undefined): Array<{
  clientName: string;
  ok: boolean;
  failures: CallingFailure[];
}> {
  return buildCallingBoard({ snapshot }).clients.map((client) => ({
    clientName: client.clientName,
    ok: client.ok,
    failures: client.failures,
  }));
}
