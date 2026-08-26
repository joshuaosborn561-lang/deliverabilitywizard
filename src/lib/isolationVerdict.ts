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

export function decideIsolationVerdict(
  input: IsolationVerdictInput,
): IsolationVerdictResult {
  const control = campaignSenderControl(input.senderControls);

  if (control === "INSUFFICIENT") {
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

  // campaignInSpam && control === CLEAN → copy, unless canaries or the rig say otherwise.
  const canary = input.copyCanary
    ? interpretCopyCanary(input.copyCanary)
    : { lean: "NONE" as const, reason: "" };

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

  const fromPod: IsolationVerdictResult = {
    verdict: "COPY",
    control,
    reason:
      canary.lean === "COPY"
        ? canary.reason
        : "The campaign copy is not inboxing on an ESP, and the known-good email on those same domains is landing across ESPs. The copy is the problem.",
    startCopyTeardown: true,
    pullInfraDiagnostics: false,
  };

  if (!input.rig) return fromPod;

  if (input.rig.controlPrimary === false) {
    return {
      verdict: "COPY",
      control,
      reason: `${fromPod.reason} The low-rep test domain also failed its own control, so the word hunt is on hold until that domain is checked. The inboxes-vs-copy answer still stands.`,
      startCopyTeardown: false,
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

/** Guard: a failing/insufficient control must never produce COPY. */
export function failedControlIsNeverCopy(
  result: IsolationVerdictResult,
): boolean {
  if (result.verdict !== "COPY") return true;
  return result.control === "CLEAN";
}
