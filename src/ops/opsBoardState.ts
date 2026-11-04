import type { CallingSnapshot } from "./callingBoard.js";
import type { LinkedInSnapshot } from "./linkedinBoard.js";
import type { WatchdogSnapshot } from "./watchdogBoard.js";

export interface OpsChecklist {
  onScript: boolean;
  opener: boolean;
  caydenFriday: boolean;
}

export interface OpsBoardState {
  watchdog: WatchdogSnapshot | null;
  calling: CallingSnapshot | null;
  linkedin: LinkedInSnapshot | null;
  checklist: OpsChecklist;
}

export const EMPTY_OPS_CHECKLIST: OpsChecklist = {
  onScript: false,
  opener: false,
  caydenFriday: false,
};

export function emptyOpsBoard(): OpsBoardState {
  return {
    watchdog: null,
    calling: null,
    linkedin: null,
    checklist: { ...EMPTY_OPS_CHECKLIST },
  };
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function count(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

function cleanLabel(value: unknown, max = 80): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text || text.includes("@") || /\d{7,}/.test(text)) return "";
  return text.slice(0, max);
}

export function parseOpsBoard(raw: unknown): OpsBoardState {
  const root = record(raw);
  if (!root) return emptyOpsBoard();
  return {
    watchdog: parseWatchdog(root.watchdog),
    calling: parseCalling(root.calling),
    linkedin: parseLinkedin(root.linkedin),
    checklist: {
      onScript: record(root.checklist)?.onScript === true,
      opener: record(root.checklist)?.opener === true,
      caydenFriday: record(root.checklist)?.caydenFriday === true,
    },
  };
}

function parseWatchdog(raw: unknown): WatchdogSnapshot | null {
  const root = record(raw);
  if (!root || typeof root.updatedAt !== "string") return null;
  const clients = Array.isArray(root.clients) ? root.clients : [];
  return {
    updatedAt: root.updatedAt,
    partial: root.partial === true,
    day: cleanLabel(root.day, 10),
    paceTarget: count(root.paceTarget) || 1200,
    source: "campaign-watchdog-analytics",
    clients: clients.flatMap((row) => {
      const item = record(row);
      if (!item) return [];
      const clientName = cleanLabel(item.clientName);
      if (!clientName) return [];
      return [{
        clientId: cleanLabel(item.clientId, 40) || clientName,
        clientName,
        sendsToday: count(item.sendsToday),
        leadsLeft: item.leadsLeft == null ? null : count(item.leadsLeft),
      }];
    }),
  };
}

function parseCalling(raw: unknown): CallingSnapshot | null {
  const root = record(raw);
  if (!root || typeof root.updatedAt !== "string") return null;
  const suppression = record(root.suppression);
  const tagging = record(root.tagging);
  const clients = Array.isArray(root.clients) ? root.clients : [];
  const numbers = Array.isArray(root.numbers) ? root.numbers : [];
  return {
    updatedAt: root.updatedAt,
    partial: root.partial === true,
    edgeLogs: root.edgeLogs === "checked" ? "checked" : "unchecked",
    gabeDialsYesterday: count(root.gabeDialsYesterday),
    gabeDialsTarget:
      root.gabeDialsTarget == null || root.gabeDialsTarget === ""
        ? null
        : count(root.gabeDialsTarget) || null,
    suppression: {
      dnc: count(suppression?.dnc),
      dncStillQueued: count(suppression?.dncStillQueued),
      unsub: count(suppression?.unsub),
      unsubStillQueued: count(suppression?.unsubStillQueued),
      unsubStillEmailed: count(suppression?.unsubStillEmailed),
    },
    tagging: {
      voicemailCalls: count(tagging?.voicemailCalls),
      voicemailTagged: count(tagging?.voicemailTagged),
      untaggedOver30s: count(tagging?.untaggedOver30s),
    },
    clients: clients.flatMap((row) => {
      const item = record(row);
      if (!item) return [];
      const clientName = cleanLabel(item.clientName);
      if (!clientName) return [];
      const reason = cleanLabel(item.mismatchReason, 40);
      const allowed = ["contact had no email", "router timeout", "router skip", "dnc hook"];
      return [{
        clientName,
        queueContacts: count(item.queueContacts),
        queues: count(item.queues),
        queuesFull: count(item.queuesFull),
        missingEmail: count(item.missingEmail),
        queuesCalled3: count(item.queuesCalled3),
        voicemailsYesterday: count(item.voicemailsYesterday),
        emailsYesterday: count(item.emailsYesterday),
        mismatchReason: allowed.includes(reason) ? (reason as CallingSnapshot["clients"][number]["mismatchReason"]) : null,
        routerErrors: count(item.routerErrors),
        dncHookErrors: item.dncHookErrors == null ? null : count(item.dncHookErrors),
      }];
    }),
    numbers: numbers.flatMap((row) => {
      const item = record(row);
      if (!item) return [];
      const clientName = cleanLabel(item.clientName);
      const last4 = String(item.last4 ?? "").replace(/\D/g, "").slice(-4);
      if (!clientName || last4.length !== 4) return [];
      return [{
        clientName,
        label: cleanLabel(item.label) || clientName,
        last4,
        daysSinceRotation: item.daysSinceRotation == null ? null : count(item.daysSinceRotation),
        spamLikely: item.spamLikely === true ? true : item.spamLikely === false ? false : null,
      }];
    }),
  };
}

function parseLinkedin(raw: unknown): LinkedInSnapshot | null {
  const root = record(raw);
  if (!root || typeof root.updatedAt !== "string") return null;
  const clients = Array.isArray(root.clients) ? root.clients : [];
  return {
    updatedAt: root.updatedAt,
    partial: root.partial === true,
    repliesToday: root.repliesToday == null ? null : count(root.repliesToday),
    clients: clients.flatMap((row) => {
      const item = record(row);
      if (!item) return [];
      const clientName = cleanLabel(item.clientName);
      if (!clientName) return [];
      const keyState = item.keyState === "missing" || item.keyState === "invalid" ? item.keyState : "ok";
      const lanes = Array.isArray(item.lanes) ? item.lanes : [];
      return [{
        clientName,
        checked: item.checked === true,
        keyState,
        lanes: lanes.flatMap((lane) => {
          const entry = record(lane);
          if (!entry) return [];
          const label = cleanLabel(entry.label) || "Sender";
          const trend = Array.isArray(entry.trend) ? entry.trend.map(count).slice(-3) : [];
          return [{
            label,
            sentToday: entry.sentToday == null ? null : count(entry.sentToday),
            trend,
            pending: entry.pending == null ? null : count(entry.pending),
            status: cleanLabel(entry.status, 40),
            reason: cleanLabel(entry.reason, 60) as LinkedInSnapshot["clients"][number]["lanes"][number]["reason"],
          }];
        }),
      }];
    }),
  };
}
