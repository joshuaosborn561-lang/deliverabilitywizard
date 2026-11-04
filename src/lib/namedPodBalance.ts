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
 * Plan the fewest retags that bring every client to an even split. Pure.
 * Seats move larger → smaller POD; the seat chosen is from the ESP the
 * larger POD holds the most extra of, so each ESP stays balanced.
 * Only off-week or idle (not on ACTIVE) unlocked seats move.
 */
export function planNamedPodRebalance(
  seats: NamedPodSeat[],
  opts: { maxMoves?: number } = {},
): { clients: NamedPodClientReport[]; moves: NamedPodMove[] } {
  const maxMoves = opts.maxMoves ?? NAMED_POD_MAX_MOVES_PER_PASS;
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
    const size = (pod: NamedPodSide) => rows.filter((r) => podOf.get(r.accountId) === pod).length;
    const espSize = (pod: NamedPodSide, esp: NamedPodEsp) =>
      rows.filter((r) => podOf.get(r.accountId) === pod && r.esp === esp).length;
    const startA = size("A");
    const startB = size("B");
    const moves: NamedPodMove[] = [];
    while (
      !namedPodsEven(size("A"), size("B")) &&
      allMoves.length + moves.length < maxMoves
    ) {
      const from: NamedPodSide = size("A") > size("B") ? "A" : "B";
      const to: NamedPodSide = from === "A" ? "B" : "A";
      const big = Math.max(size("A"), size("B"));
      const small = Math.min(size("A"), size("B"));
      if (namedPodGap(big - 1, small + 1) >= namedPodGap(big, small) - 1e-12) break;
      const candidates = rows.filter(
        (r) =>
          podOf.get(r.accountId) === from &&
          r.pod === from &&
          seatMayMoveForNamedRebalance(r),
      );
      if (!candidates.length) break;
      const excess = (esp: NamedPodEsp) => espSize(from, esp) - espSize(to, esp);
      candidates.sort(
        (x, y) => excess(y.esp) - excess(x.esp) || x.email.localeCompare(y.email),
      );
      const pick = candidates[0]!;
      podOf.set(pick.accountId, to);
      moves.push({
        accountId: pick.accountId,
        email: pick.email,
        clientId,
        from,
        to,
        esp: pick.esp,
      });
    }
    allMoves.push(...moves);
    clients.push({
      clientId,
      a: startA,
      b: startB,
      gap: namedPodGap(startA, startB),
      moves,
      remainingGap: namedPodGap(size("A"), size("B")),
      remainingEven: namedPodsEven(size("A"), size("B")),
    });
  }
  return { clients, moves: allMoves };
}
