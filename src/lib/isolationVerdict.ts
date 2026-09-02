import { interpretCopyCanary, type CopyCanarySplit } from "./copyCanary.js";
import { campaignSenderControl, type MailboxControlPlacement } from "./mailboxControlTag.js";

/**
 * Infra-vs-copy branch (D48). A failed control is never a copy finding.
 */

export type IsolationVerdict = "INFRA" | "COPY" | "INCONCLUSIVE" | "HEALTHY";

export interface IsolationVerdictInput {
  /** True when the campaign's own live placement is in spam. */
  campaignInSpam: boolean;
  /** Per-sender control placements for the campaign's actual senders. */
  senderControls: MailboxControlPlacement[];
  /**
   * Optional same-day rig confirm. Only consulted after the pod already
   * said COPY. A failed rig control does not overturn INFRA/COPY from step 1.
   */
  rig?: {
    controlPrimary: boolean | null;
    copyPrimary: boolean | null;
    /** Mailboxes already on the isolation domain. 0 = unarmed. */
    mailboxCount?: number;
  };
  /**
   * D51 — campaign-copy placement on purpose-unwarmed boxes vs warmed peers.
   * Only consulted when the pod already has a control reading.
   */
  copyCanary?: CopyCanarySplit | null;
  /**
   * D93 — known-good email on these sending domains, scored per ESP.
   * true = every scored ESP is at/above threshold; false = an ESP failed;
   * null/omitted = no per-ESP reading (fall back to senderControls).
   */
  knownGoodFineAcrossEsps?: boolean | null;
  /**
   * D96 — unwarmed senders sending this campaign copy, scored per ESP.
   * true = every scored ESP is at/above threshold (copy works cold);
   * false = an ESP failed (copy fails on fresh boxes too);
   * null/omitted = no per-ESP reading yet (use copyCanary.unwarmedLanded).
   */
  unwarmedCopyFineAcrossEsps?: boolean | null;
  /**
   * D158 — bounce loop classified a dominant content_block. Prefer COPY
   * when the canary (or live placement) is also ugly, unless known-good
   * fails an ESP (then INFRA). Lets COPY land even when mailbox control
   * is INSUFFICIENT — AirPods had no standing tag.
   */
  contentBlock?: boolean;
}

export interface IsolationVerdictResult {
  verdict: IsolationVerdict;
  control: "CLEAN" | "FAILING" | "INSUFFICIENT";
  reason: string;
  /** True when Phase 2 (copy teardown) should start without asking. */
  startCopyTeardown: boolean;
  /** True when infra diagnostics should be pulled. */
  pullInfraDiagnostics: boolean;
}

function canaryLean(input: IsolationVerdictInput): {
  lean: "COPY" | "INFRA" | "WARMUP" | "NONE";
  reason: string;
} {
  return input.copyCanary
    ? interpretCopyCanary(input.copyCanary)
    : { lean: "NONE", reason: "" };
}

function unwarmedCopyFailed(
  input: IsolationVerdictInput,
  canary: { lean: string },
): boolean {
  return (
    input.unwarmedCopyFineAcrossEsps === false ||
    canary.lean === "COPY" ||
    input.copyCanary?.unwarmedLanded === false
  );
}

/** Rig has mailboxes (or no snapshot) — start the hunt. Unarmed waits. */
function startTeardownIfRigReady(
  rig?: IsolationVerdictInput["rig"],
): boolean {
  if (!rig) return true;
  if ((rig.mailboxCount ?? 1) > 0) return true;
  return rig.controlPrimary !== false;
}

export function decideIsolationVerdict(
  input: IsolationVerdictInput,
): IsolationVerdictResult {
  const control = campaignSenderControl(input.senderControls);
  const canary = canaryLean(input);
  const unwarmedAlsoFailed = unwarmedCopyFailed(input, canary);

  // D158 — content_block + ugly canary prefers COPY even with no mailbox
  // tag. Known-good failing an ESP is still INFRA.
  if (control === "INSUFFICIENT") {
    if (input.contentBlock && input.knownGoodFineAcrossEsps === false) {
      return {
        verdict: "INFRA",
        control,
        reason:
          "Dominant bounce class is content_block, but the known-good email on those domains is also failing an ESP. That is the domain / inbox, not a word in the copy.",
        startCopyTeardown: false,
        pullInfraDiagnostics: true,
      };
    }
    if (
      input.contentBlock &&
      input.knownGoodFineAcrossEsps !== false &&
      (canary.lean === "COPY" || input.unwarmedCopyFineAcrossEsps === false)
    ) {
      return {
        verdict: "COPY",
        control,
        reason:
          "Dominant bounce class is content_block and the unwarmed canary (or live placement) is under the inbox bar. Prefer the copy path. No standing mailbox-control tag yet.",
        startCopyTeardown: startTeardownIfRigReady(input.rig),
        pullInfraDiagnostics: false,
      };
    }
    return {
      verdict: "INCONCLUSIVE",
      control,
      reason:
        "No standing inbox-test reading for the mailboxes this campaign is sending from.",
      startCopyTeardown: false,
      pullInfraDiagnostics: false,
    };
  }

  if (!input.campaignInSpam && control === "CLEAN") {
    return {
      verdict: "HEALTHY",
      control,
      reason: "Campaign is landing and the standing inbox test for its senders is clean.",
      startCopyTeardown: false,
      pullInfraDiagnostics: false,
    };
  }

  if (!input.campaignInSpam && control === "FAILING") {
    return {
      verdict: "INCONCLUSIVE",
      control,
      reason:
        "The campaign is landing but the standing inbox test for its senders is not. Check the test itself before touching copy or inboxes.",
      startCopyTeardown: false,
      pullInfraDiagnostics: true,
    };
  }

  if (input.campaignInSpam && control === "FAILING") {
    return {
      verdict: "INFRA",
      control,
      reason:
        "The standing inbox test for these senders is also in spam. This is the inboxes, not the copy.",
      startCopyTeardown: false,
      pullInfraDiagnostics: true,
    };
  }

  // D93 — campaign copy is failing an ESP, but known-good on those domains
  // is also failing an ESP. That is infra, not a word hunt.
  if (input.knownGoodFineAcrossEsps === false) {
    return {
      verdict: "INFRA",
      control,
      reason:
        "The campaign copy is not inboxing on an ESP, and the known-good email on those same domains is also failing an ESP. That is the domain / inbox, not a word in the copy.",
      startCopyTeardown: false,
      pullInfraDiagnostics: true,
    };
  }

  // D96 — unwarmed senders landed that campaign copy across ESPs. The
  // copy works on fresh boxes, so this is the live inboxes / domain.
  if (input.unwarmedCopyFineAcrossEsps === true) {
    return {
      verdict: "INFRA",
      control,
      reason:
        "The campaign copy is not inboxing on an ESP, but unwarmed senders with that same copy are landing across ESPs. That is the live inboxes / domain, not a word.",
      startCopyTeardown: false,
      pullInfraDiagnostics: true,
    };
  }

  // campaignInSpam && control === CLEAN → copy only after we have looked
  // at unwarmed senders with that copy (D96).
  if (canary.lean === "INFRA") {
    return {
      verdict: "INFRA",
      control,
      reason: canary.reason,
      startCopyTeardown: false,
      pullInfraDiagnostics: true,
    };
  }
  if (canary.lean === "WARMUP") {
    return {
      verdict: "INCONCLUSIVE",
      control,
      reason: canary.reason,
      startCopyTeardown: false,
      pullInfraDiagnostics: false,
    };
  }

  if (!unwarmedAlsoFailed) {
    return {
      verdict: "INCONCLUSIVE",
      control,
      reason:
        "The campaign copy is not inboxing on an ESP, and known-good on those domains looks fine, but I do not yet have the unwarmed senders with that copy. Not a word hunt until that reading exists.",
      startCopyTeardown: false,
      pullInfraDiagnostics: false,
    };
  }

  const fromPod: IsolationVerdictResult = {
    verdict: "COPY",
    control,
    reason:
      canary.lean === "COPY"
        ? canary.reason
        : "The campaign copy is not inboxing on an ESP. Known-good on those domains is landing across ESPs, and unwarmed senders with that same copy are also failing an ESP. The copy is the problem.",
    startCopyTeardown: startTeardownIfRigReady(input.rig),
    pullInfraDiagnostics: false,
  };

  if (!input.rig) return fromPod;

  if (input.rig.controlPrimary === false) {
    const configured = (input.rig.mailboxCount ?? 1) > 0;
    return {
      verdict: "COPY",
      control,
      reason: configured
        ? `${fromPod.reason} The low-rep test domain failed its own control; the hunt still starts because the rig has mailboxes.`
        : `${fromPod.reason} The low-rep test domain also failed its own control, so the word hunt waits until the rig is armed. The inboxes-vs-copy answer still stands.`,
      startCopyTeardown: configured,
      pullInfraDiagnostics: false,
    };
  }

  if (input.rig.controlPrimary === true && input.rig.copyPrimary === true) {
    return {
      verdict: "INCONCLUSIVE",
      control,
      reason:
        "Inboxes are fine and the copy also lands from a low-rep domain. The problem is upstream of deliverability — list, offer, or targeting.",
      startCopyTeardown: false,
      pullInfraDiagnostics: false,
    };
  }

  if (input.rig.controlPrimary === true && input.rig.copyPrimary === false) {
    return {
      verdict: "COPY",
      control,
      reason:
        "Confirmed: the low-rep domain landed the control and buried the campaign copy. Starting the word hunt.",
      startCopyTeardown: true,
      pullInfraDiagnostics: false,
    };
  }

  return fromPod;
}

/** Guard: a FAILING control must never produce COPY (D48). INSUFFICIENT may COPY on content_block + ugly canary (D158). */
export function failedControlIsNeverCopy(
  result: IsolationVerdictResult,
): boolean {
  if (result.verdict !== "COPY") return true;
  return result.control !== "FAILING";
}
