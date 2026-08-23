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

  // campaignInSpam && control === CLEAN → copy, unless the rig contradicts.
  const fromPod: IsolationVerdictResult = {
    verdict: "COPY",
    control,
    reason:
      "The standing inbox test for these senders landed in the inbox. The campaign copy is the problem.",
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
