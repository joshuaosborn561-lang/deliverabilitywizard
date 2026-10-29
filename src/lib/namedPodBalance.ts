/**
 * D316 (B3) — a client's named seats on POD-A and POD-B stay within 15% of
 * each other. Josh, 10/29/2026: "POD A and B named seats must stay within
 * 15% of each other; retag named seats to fix it, overriding never-retag."
 *
 * This is the ONLY lawful A↔B retag of an already-tagged named seat (it
 * amends D234 — every other writer still refuses a flip via
 * `mayWritePodTag`). It moves only seats that are not on an ACTIVE
 * campaign, so nothing is unlinked from live sending (the 10/3 incident),
 * and it keeps each ESP balanced across the two PODs.
 */

/** Largest allowed gap, as a share of the larger POD's named seats. */
export const NAMED_POD_MAX_GAP = 0.15;
/** Retags per pod-tags pass — an imbalance heals over a few passes, never in one burst. */
export const NAMED_POD_MAX_MOVES_PER_PASS = 10;

export type NamedPodSide = "A" | "B";
export type NamedPodEsp = "outlook" | "gmail" | "other";

export interface NamedPodSeat {
  accountId: number;
  email: string;
  clientId: number;
  pod: NamedPodSide;
  esp: NamedPodEsp;
  /** True when the seat sits on an ACTIVE campaign — never moved. */
  onActiveCampaign: boolean;
  /** Canary, GABE-VM-RESERVED, caller follow-up, dual-tagged, POC, isolation: never moved. */
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
  /** Still outside 15% after the planned moves (no eligible seat, or capped). */
  remainingGap: number;
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

/**
 * Plan the fewest retags that bring every client within 15%. Pure.
 * Seats move larger → smaller POD; the seat chosen is from the ESP the
 * larger POD holds the most extra of, so each ESP stays balanced.
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
      !namedPodsBalanced(size("A"), size("B")) &&
      allMoves.length + moves.length < maxMoves
    ) {
      const from: NamedPodSide = size("A") > size("B") ? "A" : "B";
      const to: NamedPodSide = from === "A" ? "B" : "A";
      // Never trade one imbalance for the mirror image (3/2 → 2/3 is no gain).
      const big = Math.max(size("A"), size("B"));
      const small = Math.min(size("A"), size("B"));
      if (namedPodGap(big - 1, small + 1) >= namedPodGap(big, small) - 1e-12) break;
      const candidates = rows.filter(
        (r) =>
          podOf.get(r.accountId) === from &&
          r.pod === from && // a seat is only ever moved once, and only off its original side
          !r.onActiveCampaign &&
          !r.locked,
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
    });
  }
  return { clients, moves: allMoves };
}
