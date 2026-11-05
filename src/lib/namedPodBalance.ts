/**
 * D316 (B3) / D326 — a client's named seats on POD-A and POD-B stay
 * even and ESP-balanced. Josh, 10/29/2026: "POD A and B named seats
 * must stay within 15% of each other; retag named seats to fix it,
 * overriding never-retag." Josh, 11/4/2026 (D326, supersedes D203
 * never-retag / PR #242): moving named inboxes between POD A and
 * POD B to balance a lopsided client is allowed and preferred over
 * covering the gap with generics. Example: BPLTG 21/59 becomes an
 * even ESP-balanced split. Generics only top each POD up to 40.
 *
 * This is the ONLY lawful A↔B retag of an already-tagged named seat
 * (every other writer still refuses a flip via `mayWritePodTag`).
 * It moves only the off-week POD's named seats, or seats not linked
 * to an ACTIVE campaign, so live sending is never disrupted mid-week.
 * A 24h 5.7.233 / TERRL stop keeps its POD tag (`locked`).
 *
 * D326 fix (Cayden 11/5): count EVERY named seat a client owns — the
 * same population the CANON sweep counts — not only seats on ACTIVE
 * campaigns or the resting list. Excluded from the count: GENERIC /
 * POC (510826), CAYDEN-SG, GABE-VM-RESERVED / caller follow-up,
 * JEREMY-CIOTOLA (533700), canaries, any HOLD-UNTIL-*, dual-tagged and
 * untagged seats. Act only when the total OR a per-ESP (Gmail,
 * Outlook) split is outside 15% (or an approved exception got worse);
 * a client already within tolerance is a no-op, so a good split is
 * never churned. Counting a subset skewed real splits (Nov 4–5: 40
 * seats moved B→A for Nexus, Virtual Pulsar, SalesGlider, EMCOR).
 */

/** D316 floor — a gap at or under this share of the larger POD is "close". */
export const NAMED_POD_MAX_GAP = 0.15;
/** D326 target — even split (odd totals may differ by one). */
export const NAMED_POD_EVEN_MAX_DIFF = 1;
/** Retags per pod-tags pass — enough for a 21/59 → 40/40 in one pass. */
export const NAMED_POD_MAX_MOVES_PER_PASS = 40;

export type NamedPodSide = "A" | "B";
export type NamedPodEsp = "outlook" | "gmail" | "other";

export interface NamedPodSeat {
  accountId: number;
  email: string;
  clientId: number;
  pod: NamedPodSide;
  esp: NamedPodEsp;
  /** True when the seat sits on an ACTIVE campaign. */
  onActiveCampaign: boolean;
  /**
   * True when this seat is on the off-week POD. Off-week named
   * seats may move even if a leftover ACTIVE link remains.
   */
  offWeek?: boolean;
  /**
   * Canary, GABE-VM-RESERVED, caller follow-up, dual-tagged, POC,
   * isolation, CAYDEN-SG, or a 24h 5.7.233 / TERRL stop: never moved.
   */
  locked: boolean;
}

export interface NamedPodMove {
  accountId: number;
  email: string;
  clientId: number;
  from: NamedPodSide;
  to: NamedPodSide;
  esp: NamedPodEsp;
}

export interface NamedPodClientReport {
  clientId: number;
  a: number;
  b: number;
  gap: number;
  moves: NamedPodMove[];
  /** Still uneven after the planned moves (no eligible seat, or capped). */
  remainingGap: number;
  remainingEven: boolean;
  /** Splits that were out of tolerance before the plan (empty = no-op). */
  violations: NamedPodSplitKey[];
  /** Total and per-ESP already within 15% (or an approved exception). */
  withinTolerance: boolean;
  /** Still out of tolerance after the planned moves. */
  remainingViolations: NamedPodSplitKey[];
  /** Hands-off client (e.g. PowerGRYD) — counted, never moved. */
  handsOff: boolean;
}

/** (larger − smaller) / larger; 0 when both are empty. */
export function namedPodGap(a: number, b: number): number {
  const big = Math.max(a, b);
  if (big <= 0) return 0;
  return (big - Math.min(a, b)) / big;
}

export function namedPodsBalanced(a: number, b: number): boolean {
  // 1e-9: 17 vs 20 is exactly 15% and must pass despite float error.
  return namedPodGap(a, b) <= NAMED_POD_MAX_GAP + 1e-9;
}

/** D326 — even split. 40/40 and 40/39 pass; 21/59 does not. */
export function namedPodsEven(a: number, b: number): boolean {
  return Math.abs(a - b) <= NAMED_POD_EVEN_MAX_DIFF;
}

/** Within 15%, or as even as the count allows (3/2, 1/2 cannot do better). */
export function namedSplitOk(a: number, b: number): boolean {
  return namedPodsBalanced(a, b) || namedPodsEven(a, b);
}

export type NamedPodSplitKey = "total" | "gmail" | "outlook";

/**
 * An approved imbalance: leave this client/split alone unless it gets
 * worse than `a`/`b` (gap ÷ larger). Expires end of `until` (UTC).
 */
export interface NamedPodAcceptedSplit {
  clientId: number;
  split: NamedPodSplitKey;
  a: number;
  b: number;
  until: string;
  note: string;
}

/**
 * Cayden 11/5: "Leave the leftover imbalance until the next rotation"
 * (next on-week flip is Mon 2026-11-09, ISO week 46). Mirrors the
 * CANON sweep's ACCEPTED_ESP list.
 */
export const NAMED_POD_ACCEPTED_SPLITS: readonly NamedPodAcceptedSplit[] = [
  { clientId: 521881, split: "outlook", a: 15, b: 12, until: "2026-11-08", note: "TechEvo — Cayden 11/5 leave until next rotation" },
  { clientId: 566991, split: "gmail", a: 15, b: 12, until: "2026-11-08", note: "Nutter — Cayden 11/5 leave until next rotation" },
  { clientId: 418274, split: "gmail", a: 19, b: 16, until: "2026-11-08", note: "Parlay — accepted in CANON sweep" },
];

/** Hands-off clients: D326 never retags their named seats. */
export const NAMED_POD_HANDS_OFF_CLIENT_IDS: readonly number[] = [
  // PowerGRYD — Cayden: hands-off while senders warm after the trial run.
  592842,
];

export interface NamedPodSplitCounts {
  total: [number, number];
  gmail: [number, number];
  outlook: [number, number];
}

export function namedPodSplitCounts(
  rows: Array<Pick<NamedPodSeat, "pod" | "esp">>,
): NamedPodSplitCounts {
  const out: NamedPodSplitCounts = { total: [0, 0], gmail: [0, 0], outlook: [0, 0] };
  for (const row of rows) {
    const i = row.pod === "A" ? 0 : 1;
    out.total[i] += 1;
    if (row.esp === "gmail") out.gmail[i] += 1;
    if (row.esp === "outlook") out.outlook[i] += 1;
  }
  return out;
}

function acceptedFor(
  clientId: number,
  split: NamedPodSplitKey,
  accepted: readonly NamedPodAcceptedSplit[],
  now: Date,
): NamedPodAcceptedSplit | undefined {
  return accepted.find((row) => {
    if (row.clientId !== clientId || row.split !== split) return false;
    const end = Date.parse(`${row.until}T23:59:59.999Z`);
    return Number.isFinite(end) && end >= now.getTime();
  });
}

/**
 * Splits (total, gmail, outlook) that are out of tolerance. Empty =
 * within tolerance = D326 does nothing for this client.
 */
export function namedPodSplitViolations(
  clientId: number,
  rows: Array<Pick<NamedPodSeat, "pod" | "esp">>,
  opts: { accepted?: readonly NamedPodAcceptedSplit[]; now?: Date } = {},
): NamedPodSplitKey[] {
  const accepted = opts.accepted ?? NAMED_POD_ACCEPTED_SPLITS;
  const now = opts.now ?? new Date();
  const counts = namedPodSplitCounts(rows);
  const out: NamedPodSplitKey[] = [];
  for (const key of ["total", "gmail", "outlook"] as const) {
    const [a, b] = counts[key];
    if (namedSplitOk(a, b)) continue;
    const ok = acceptedFor(clientId, key, accepted, now);
    if (ok && namedPodGap(a, b) <= namedPodGap(ok.a, ok.b) + 1e-9) continue;
    out.push(key);
  }
  return out;
}

export function seatMayMoveForNamedRebalance(seat: NamedPodSeat): boolean {
  if (seat.locked) return false;
  if (!seat.onActiveCampaign) return true;
  return seat.offWeek === true;
}

export function projectNamedPods(input: {
  namedA: number;
  namedB: number;
  movableA: number;
  movableB: number;
  maxMoves?: number;
}): { a: number; b: number; moves: number } {
  let a = Math.max(0, input.namedA);
  let b = Math.max(0, input.namedB);
  let movableA = Math.max(0, input.movableA);
  let movableB = Math.max(0, input.movableB);
  const maxMoves = input.maxMoves ?? NAMED_POD_MAX_MOVES_PER_PASS;
  let moves = 0;
  // D326 fix — within 15% is left alone (pod-tags will not move it either).
  if (namedSplitOk(a, b)) return { a, b, moves };
  while (!namedPodsEven(a, b) && moves < maxMoves) {
    if (a === b) break;
    const fromA = a > b;
    if (fromA) {
      if (movableA <= 0) break;
      if (namedPodGap(a - 1, b + 1) >= namedPodGap(a, b) - 1e-12) break;
      a -= 1;
      b += 1;
      movableA -= 1;
    } else {
      if (movableB <= 0) break;
      if (namedPodGap(a + 1, b - 1) >= namedPodGap(a, b) - 1e-12) break;
      b -= 1;
      a += 1;
      movableB -= 1;
    }
    moves += 1;
  }
  return { a, b, moves };
}

/**
 * Generic need per POD after a lawful named rebalance. Surplus named
 * on the other POD cover a short POD instead of pool generics.
 * Generics only top each POD up to `floor` (default 40).
 */
export function genericNeedAfterNamedRebalance(input: {
  namedA: number;
  namedB: number;
  movableA: number;
  movableB: number;
  genericsA?: number;
  genericsB?: number;
  floor?: number;
  maxMoves?: number;
}): { needA: number; needB: number; projectedA: number; projectedB: number } {
  const floor = input.floor ?? 40;
  const projected = projectNamedPods(input);
  return {
    projectedA: projected.a,
    projectedB: projected.b,
    needA: Math.max(0, floor - projected.a - Math.max(0, input.genericsA ?? 0)),
    needB: Math.max(0, floor - projected.b - Math.max(0, input.genericsB ?? 0)),
  };
}

/**
 * Plan the fewest retags that fix every out-of-tolerance client. Pure.
 *
 * `seats` must be EVERY named seat the client owns (see the header for
 * what is excluded) — locked and on-week-live seats included, so the
 * count is the real split; they are counted but never moved.
 *
 * A client whose total and per-ESP (Gmail, Outlook) splits are all
 * within 15% — or not worse than an approved exception — is a no-op.
 * Otherwise: seats move larger → smaller POD until the total is even,
 * taking the ESP the larger POD holds the most extra of; an ESP still
 * outside 15% with an even total is fixed by a same-size swap (one
 * seat of that ESP one way, one of another ESP back). Only off-week or
 * idle (not on ACTIVE) unlocked seats move, and each seat at most once.
 */
export function planNamedPodRebalance(
  seats: NamedPodSeat[],
  opts: {
    maxMoves?: number;
    accepted?: readonly NamedPodAcceptedSplit[];
    handsOffClientIds?: readonly number[];
    now?: Date;
  } = {},
): { clients: NamedPodClientReport[]; moves: NamedPodMove[] } {
  const maxMoves = opts.maxMoves ?? NAMED_POD_MAX_MOVES_PER_PASS;
  const handsOff = new Set(opts.handsOffClientIds ?? NAMED_POD_HANDS_OFF_CLIENT_IDS);
  const byClient = new Map<number, NamedPodSeat[]>();
  for (const seat of seats) {
    const list = byClient.get(seat.clientId) ?? [];
    list.push(seat);
    byClient.set(seat.clientId, list);
  }
  const clients: NamedPodClientReport[] = [];
  const allMoves: NamedPodMove[] = [];
  for (const [clientId, rows] of [...byClient.entries()].sort((x, y) => x[0] - y[0])) {
    const podOf = new Map<number, NamedPodSide>(rows.map((r) => [r.accountId, r.pod]));
    const current = () => rows.map((r) => ({ pod: podOf.get(r.accountId)!, esp: r.esp }));
    const size = (pod: NamedPodSide) => rows.filter((r) => podOf.get(r.accountId) === pod).length;
    const espSize = (pod: NamedPodSide, esp: NamedPodEsp) =>
      rows.filter((r) => podOf.get(r.accountId) === pod && r.esp === esp).length;
    const startA = size("A");
    const startB = size("B");
    const violations = handsOff.has(clientId)
      ? []
      : namedPodSplitViolations(clientId, rows, { accepted: opts.accepted, now: opts.now });
    const moves: NamedPodMove[] = [];
    const movable = (from: NamedPodSide, esp?: NamedPodEsp) =>
      rows.filter(
        (r) =>
          podOf.get(r.accountId) === from &&
          r.pod === from &&
          (esp == null || r.esp === esp) &&
          seatMayMoveForNamedRebalance(r),
      );
    const move = (pick: NamedPodSeat, from: NamedPodSide, to: NamedPodSide) => {
      podOf.set(pick.accountId, to);
      moves.push({ accountId: pick.accountId, email: pick.email, clientId, from, to, esp: pick.esp });
    };
    const budget = () => maxMoves - allMoves.length - moves.length;
    const espBad = (): NamedPodEsp | null => {
      for (const esp of ["gmail", "outlook"] as const) {
        if (!namedSplitOk(espSize("A", esp), espSize("B", esp))) return esp;
      }
      return null;
    };
    if (violations.length) {
      // Bounded: every move retires one seat (moved at most once).
      for (let guard = 0; guard <= rows.length && budget() > 0; guard += 1) {
        const a = size("A");
        const b = size("B");
        if (!namedPodsEven(a, b)) {
          const from: NamedPodSide = a > b ? "A" : "B";
          const to: NamedPodSide = from === "A" ? "B" : "A";
          const big = Math.max(a, b);
          const small = Math.min(a, b);
          if (namedPodGap(big - 1, small + 1) >= namedPodGap(big, small) - 1e-12) break;
          const candidates = movable(from);
          if (!candidates.length) break;
          const excess = (esp: NamedPodEsp) => espSize(from, esp) - espSize(to, esp);
          candidates.sort(
            (x, y) => excess(y.esp) - excess(x.esp) || x.email.localeCompare(y.email),
          );
          move(candidates[0]!, from, to);
          continue;
        }
        const esp = espBad();
        if (!esp || budget() < 2) break;
        const from: NamedPodSide = espSize("A", esp) > espSize("B", esp) ? "A" : "B";
        const to: NamedPodSide = from === "A" ? "B" : "A";
        const out = movable(from, esp).sort((x, y) => x.email.localeCompare(y.email))[0];
        const excessTo = (e: NamedPodEsp) => espSize(to, e) - espSize(from, e);
        const back = movable(to)
          .filter((r) => r.esp !== esp)
          .sort((x, y) => excessTo(y.esp) - excessTo(x.esp) || x.email.localeCompare(y.email))[0];
        if (!out || !back) break;
        const before = namedPodGap(espSize("A", esp), espSize("B", esp));
        const afterEsp = namedPodGap(espSize(from, esp) - 1, espSize(to, esp) + 1);
        if (afterEsp >= before - 1e-12) break;
        move(out, from, to);
        move(back, to, from);
      }
    }
    allMoves.push(...moves);
    const after = current();
    clients.push({
      clientId,
      a: startA,
      b: startB,
      gap: namedPodGap(startA, startB),
      moves,
      remainingGap: namedPodGap(size("A"), size("B")),
      remainingEven: namedPodsEven(size("A"), size("B")),
      violations,
      withinTolerance: violations.length === 0,
      remainingViolations: violations.length
        ? namedPodSplitViolations(clientId, after, { accepted: opts.accepted, now: opts.now })
        : [],
      handsOff: handsOff.has(clientId),
    });
  }
  return { clients, moves: allMoves };
}
