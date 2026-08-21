/**
 * D44 — a hold only stands if same-ESP placement actually failed (D32).
 * No score, blended-only, or a passing same-ESP rate is not proof.
 */
export function holdHasSameEspProof(
  record: {
    scoredSameEsp?: boolean | null;
    inboxRateSameEsp?: number;
    inboxRate?: number;
  },
  threshold: number,
): boolean {
  if (record.scoredSameEsp !== true) return false;
  const rate =
    typeof record.inboxRateSameEsp === "number"
      ? record.inboxRateSameEsp
      : record.inboxRate;
  return typeof rate === "number" && Number.isFinite(rate) && rate < threshold;
}
