/**
 * D51/D54/D55 — dedicated unwarmed fleet sends campaign copy in placement
 * tests (off live campaigns) so it can be compared against warmed peers.
 * Not launch canary (D43).
 */

export interface CopyCanarySplit {
  /** True when most unwarmed canaries landed campaign copy (same-ESP). */
  unwarmedLanded: boolean | null;
  /** True when most warmed peers landed campaign copy (same-ESP). */
  warmedLanded: boolean | null;
  unwarmedTested: number;
  warmedTested: number;
  unwarmedInbox: number;
  warmedInbox: number;
}

export function majorityLanded(
  inboxCount: number,
  tested: number,
): boolean | null {
  if (tested <= 0) return null;
  return inboxCount * 2 >= tested;
}

/**
 * Extra isolation reading from campaign copy on purpose-cold boxes.
 * A failed known-good control is still never COPY (caller must keep that).
 */
export function interpretCopyCanary(
  split: CopyCanarySplit,
): { lean: "COPY" | "INFRA" | "WARMUP" | "NONE"; reason: string } {
  if (split.unwarmedLanded == null) {
    return {
      lean: "NONE",
      reason: "No unwarmed campaign-copy reading yet.",
    };
  }
  if (split.unwarmedLanded && split.warmedLanded === false) {
    return {
      lean: "INFRA",
      reason:
        "Unwarmed boxes landed the campaign copy. The copy is not the problem — the warmed inboxes are.",
    };
  }
  if (!split.unwarmedLanded && split.warmedLanded === true) {
    return {
      lean: "WARMUP",
      reason:
        "Cold boxes buried the campaign copy while warmed peers landed it. That is warmup / age, not a word.",
    };
  }
  if (!split.unwarmedLanded && split.warmedLanded === false) {
    return {
      lean: "COPY",
      reason:
        "Warmed and unwarmed both buried the campaign copy. If the known-good email landed, the copy is the problem.",
    };
  }
  return {
    lean: "NONE",
    reason: "Unwarmed campaign-copy reading does not change the call.",
  };
}
