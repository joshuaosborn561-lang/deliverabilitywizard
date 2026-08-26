import type { VariantKind } from "./copyVariants.js";

export type SuppressedTermStatus = "confirmed" | "suspected" | "retired";

export interface SuppressedTerm {
  term: string;
  kind: VariantKind;
  firstSeen: string;
  timesConfirmed: number;
  recoveredPlacementDelta?: number;
  clientScope?: string;
  status: SuppressedTermStatus;
  lastConfirmedAt?: string;
}

const RETIRE_AFTER_MS = 180 * 24 * 60 * 60 * 1000;

export function termKey(term: string, clientScope?: string): string {
  const scope = (clientScope ?? "*").trim().toLowerCase() || "*";
  return `${scope}:${term.trim().toLowerCase()}`;
}

export function confirmSuppressedTerm(
  existing: SuppressedTerm | undefined,
  input: {
    term: string;
    kind: VariantKind;
    at: string;
    recoveredPlacementDelta?: number;
    clientScope?: string;
  },
): SuppressedTerm {
  if (!existing) {
    return {
      term: input.term,
      kind: input.kind,
      firstSeen: input.at,
      timesConfirmed: 1,
      recoveredPlacementDelta: input.recoveredPlacementDelta,
      clientScope: input.clientScope,
      status: "confirmed",
      lastConfirmedAt: input.at,
    };
  }
  return {
    ...existing,
    timesConfirmed: existing.timesConfirmed + 1,
    recoveredPlacementDelta:
      input.recoveredPlacementDelta ?? existing.recoveredPlacementDelta,
    status: "confirmed",
    lastConfirmedAt: input.at,
  };
}

export function retireStaleTerms(
  terms: SuppressedTerm[],
  now = new Date(),
  maxAgeMs = RETIRE_AFTER_MS,
): SuppressedTerm[] {
  return terms.map((term) => {
    const last = Date.parse(term.lastConfirmedAt ?? term.firstSeen);
    if (!Number.isFinite(last)) return term;
    if (now.getTime() - last < maxAgeMs) return term;
    if (term.status === "retired") return term;
    return { ...term, status: "retired" as const };
  });
}

export interface CopyLintHit {
  term: string;
  kind: VariantKind;
  clientScope?: string;
  timesConfirmed: number;
}

/**
 * Warning only — a term that killed one vertical may be fine in another.
 * Never blocks a launch (D48).
 */
export function lintCopyAgainstTerms(
  copy: { subject?: string; body?: string },
  terms: SuppressedTerm[],
  clientScope?: string,
): CopyLintHit[] {
  const blob = `${copy.subject ?? ""}\n${copy.body ?? ""}`.toLowerCase();
  const hits: CopyLintHit[] = [];
  for (const term of terms) {
    if (term.status !== "confirmed") continue;
    if (
      term.clientScope &&
      clientScope &&
      term.clientScope.toLowerCase() !== clientScope.toLowerCase()
    ) {
      continue;
    }
    if (!blob.includes(term.term.toLowerCase())) continue;
    hits.push({
      term: term.term,
      kind: term.kind,
      clientScope: term.clientScope,
      timesConfirmed: term.timesConfirmed,
    });
  }
  return hits;
}
