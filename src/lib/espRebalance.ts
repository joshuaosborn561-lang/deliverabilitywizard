/**
 * D303 — auto-rebalance an off-target on-week POD to the client's
 * InboxKit Microsoft share (D301 target). Uses only swaps canon already
 * allows: warm mailboxes only, same client only, generics only from the
 * Generics Ledger free pool. Every swap is 1-for-1, so POD-40 never drops.
 * Insight never receives generics; generics never cross clients.
 */

export type EspBucket = "outlook" | "gmail";

export interface PodSeat {
  email: string;
  esp: EspBucket;
  generic: boolean;
}

export interface SpareSeat {
  email: string;
  esp: EspBucket;
  generic: boolean;
  warm: boolean;
  /** Owning client for branded; null for a free ledger generic. */
  clientId: number | null;
}

export interface EspSwap {
  out: PodSeat;
  in: SpareSeat;
}

export function microsoftTarget(podSize: number, share: number): number {
  return Math.round(podSize * share);
}

export function microsoftTolerance(podSize: number): number {
  return Math.max(2, Math.floor(podSize * 0.1));
}

export function planEspRebalance(input: {
  clientId: number;
  insight: boolean;
  microsoftShare: number | undefined;
  pod: PodSeat[];
  spares: SpareSeat[];
}): { swaps: EspSwap[]; reason: string } {
  const share = input.microsoftShare;
  if (typeof share !== "number" || !Number.isFinite(share)) {
    return { swaps: [], reason: "no InboxKit split for this client" };
  }
  const size = input.pod.length;
  const target = microsoftTarget(size, share);
  const tol = microsoftTolerance(size);
  const ms = input.pod.filter((s) => s.esp === "outlook").length;
  if (Math.abs(ms - target) <= tol) return { swaps: [], reason: "within tolerance" };

  const tooManyMs = ms > target;
  const outEsp: EspBucket = tooManyMs ? "outlook" : "gmail";
  const inEsp: EspBucket = tooManyMs ? "gmail" : "outlook";
  const need = Math.abs(ms - target);

  // Generics leave first (branded is preferred), then branded.
  const outs = input.pod
    .filter((s) => s.esp === outEsp)
    .sort((a, b) => Number(b.generic) - Number(a.generic));
  const ins = input.spares
    .filter((s) => s.warm && s.esp === inEsp)
    .filter((s) =>
      s.generic
        ? !input.insight && s.clientId === null
        : s.clientId === input.clientId,
    )
    // Same-client branded first, then free ledger generics.
    .sort((a, b) => Number(a.generic) - Number(b.generic));

  const swaps: EspSwap[] = [];
  for (let i = 0; i < need && i < outs.length && i < ins.length; i += 1) {
    swaps.push({ out: outs[i]!, in: ins[i]! });
  }
  return {
    swaps,
    reason: swaps.length < need ? `short ${need - swaps.length} warm ${inEsp} seat(s)` : "ok",
  };
}
