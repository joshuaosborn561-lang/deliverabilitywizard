import { INBOX_THRESHOLD, ISOLATION_DEADLINE_MS } from "../canon/constants.js";
import { isCopyCanaryFleetEmail, isReleasedCanaryEmail } from "./fleet.js";
import { campaignIdFromCanaryTestName, isCanaryCopyTestName, matchesAutoPlacementName } from "./names.js";
import type {
  CanaryKind,
  FailureClass,
  IsolationRun,
  IsolationSuspect,
  PlacementScore,
  ProviderSplit,
  SlimCampaign,
  SpamTest,
} from "../types.js";

export function isActiveSendingStatus(status: string | undefined | null): boolean {
  return String(status ?? "").toUpperCase() === "ACTIVE";
}

export function filterReleasedSenderRows(
  senders: Array<{ email: string; inbox?: boolean; provider?: string }>,
): {
  kept: Array<{ email: string; inbox?: boolean; provider?: string }>;
  releasedIgnored: number;
} {
  const kept: Array<{ email: string; inbox?: boolean; provider?: string }> = [];
  let releasedIgnored = 0;
  for (const row of senders) {
    const email = row.email.trim().toLowerCase();
    if (isReleasedCanaryEmail(email)) {
      releasedIgnored += 1;
      continue;
    }
    kept.push(row);
  }
  return { kept, releasedIgnored };
}

/** Living-fleet filter for warmed Auto: tests. Copy-canary scoring uses filterReleasedSenderRows. */
export function filterFleetSenderRows(
  senders: Array<{ email: string; inbox?: boolean; provider?: string }>,
  fleetEmails: readonly string[],
): {
  kept: Array<{ email: string; inbox?: boolean; provider?: string }>;
  releasedIgnored: number;
} {
  const { kept: notReleased, releasedIgnored } = filterReleasedSenderRows(senders);
  if (fleetEmails.length === 0) return { kept: notReleased, releasedIgnored };
  return {
    kept: notReleased.filter((row) => isCopyCanaryFleetEmail(row.email, fleetEmails)),
    releasedIgnored,
  };
}

export function sameEspSplits(
  senders: Array<{ email: string; inbox?: boolean; provider?: string }>,
): ProviderSplit[] {
  const by = new Map<string, { inbox: number; total: number; emails: string[] }>();
  for (const row of senders) {
    const provider = (row.provider ?? "unknown").toLowerCase();
    const bucket = by.get(provider) ?? { inbox: 0, total: 0, emails: [] };
    bucket.total += 1;
    if (row.inbox) bucket.inbox += 1;
    bucket.emails.push(row.email);
    by.set(provider, bucket);
  }
  return [...by.entries()].map(([name, b]) => ({
    name,
    inboxPercent: b.total ? (b.inbox / b.total) * 100 : 0,
    emails: b.emails,
  }));
}

export function minSameEspInbox(providers: ProviderSplit[]): number | null {
  if (!providers.length) return null;
  return Math.min(...providers.map((row) => row.inboxPercent));
}

/** Sender rows first; providerwise splits when the list omitted seeds. */
export function scoreInputsForTest(opts: {
  test: SpamTest;
  source: "canary-copy" | "live-placement";
  fleetEmails: readonly string[];
}): {
  inbox: number;
  senders: Array<{ email: string; inbox?: boolean; provider?: string }>;
  releasedIgnored: number;
} | null {
  const raw = opts.test.senders ?? [];
  if (opts.source === "canary-copy") {
    // D280: unwarmed copy-canary results count even when senders are not living-fleet emails.
    const { kept, releasedIgnored } = filterReleasedSenderRows(raw);
    if (kept.length) {
      const inbox = minSameEspInbox(sameEspSplits(kept));
      if (inbox == null) return null;
      return { inbox, senders: kept, releasedIgnored };
    }
  } else {
    const senders = raw.filter((s) => s.email && !isReleasedCanaryEmail(s.email));
    if (senders.length) {
      const inbox = minSameEspInbox(sameEspSplits(senders));
      if (inbox == null) return null;
      return { inbox, senders, releasedIgnored: 0 };
    }
  }
  const providers = opts.test.providers ?? [];
  if (!providers.length) return null;
  const inbox = minSameEspInbox(providers);
  if (inbox == null) return null;
  return { inbox, senders: [], releasedIgnored: 0 };
}

export function prioritizeTestsToHydrate(
  tests: SpamTest[],
  campaigns: SlimCampaign[],
): SpamTest[] {
  const active = campaigns.filter((c) => isActiveSendingStatus(c.status));
  const ids = new Set(active.map((c) => c.id));
  const names = active.map((c) => c.name);
  const rank = (test: SpamTest): number => {
    const fromCanary = campaignIdFromCanaryTestName(test.name);
    if (fromCanary != null && ids.has(fromCanary)) return 0;
    const cid = Number(test.campaignId);
    if (Number.isFinite(cid) && ids.has(cid)) return 1;
    if (names.some((name) => matchesAutoPlacementName(test.name, name))) return 1;
    return 2;
  };
  return [...tests].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
}

export function sameEspInboxUgly(
  providers: ProviderSplit[],
  threshold = INBOX_THRESHOLD,
): boolean {
  return providers.some((row) => row.inboxPercent < threshold);
}

/** Warmed Auto: tests SENDERS. Unwarmed Canary copy: fleet tests COPY. */
export function canaryKindForSource(source: PlacementScore["source"]): CanaryKind {
  return source === "canary-copy" ? "unwarmed" : "warmed";
}

export function classifyCanaryFailure(opts: {
  kind: CanaryKind;
  inboxPercent: number;
  threshold?: number;
}): FailureClass {
  if (opts.inboxPercent >= (opts.threshold ?? INBOX_THRESHOLD)) return "none";
  return opts.kind === "warmed" ? "sender" : "copy";
}

export function liveCampaignForTest(opts: {
  testName?: string;
  campaignId?: string | number;
  campaigns: SlimCampaign[];
}): { campaign: SlimCampaign; source: "canary-copy" | "live-placement" } | undefined {
  const fromCanary = campaignIdFromCanaryTestName(opts.testName);
  if (fromCanary != null) {
    const campaign = opts.campaigns.find((c) => c.id === fromCanary);
    if (campaign && isActiveSendingStatus(campaign.status)) {
      return { campaign, source: "canary-copy" };
    }
    return undefined;
  }
  if (isCanaryCopyTestName(opts.testName)) return undefined;
  const byName = opts.campaigns.find((c) =>
    matchesAutoPlacementName(opts.testName, c.name),
  );
  if (byName && isActiveSendingStatus(byName.status)) {
    return { campaign: byName, source: "live-placement" };
  }
  const fromId = Number(opts.campaignId);
  if (Number.isFinite(fromId) && fromId > 0) {
    const campaign = opts.campaigns.find((c) => c.id === fromId);
    if (campaign && isActiveSendingStatus(campaign.status)) {
      return { campaign, source: "live-placement" };
    }
  }
  return undefined;
}

export function hasOpenIsolation(opts: {
  existing?: IsolationSuspect;
  openRun?: IsolationRun;
}): boolean {
  if (opts.existing && !opts.existing.evaluatedAt) return true;
  if (opts.openRun?.teardownStarted) return true;
  if (opts.openRun?.verdict === "COPY" || opts.openRun?.verdict === "INFRA") {
    return true;
  }
  return false;
}

export function uglyWithoutIsolation(opts: {
  scores: PlacementScore[];
  suspects: IsolationSuspect[];
  latestRun: (campaignId: number) => IsolationRun | undefined;
  threshold?: number;
  keepCampaignId?: (campaignId: number) => boolean;
}): PlacementScore[] {
  const threshold = opts.threshold ?? INBOX_THRESHOLD;
  const suspectById = new Map(opts.suspects.map((row) => [row.campaignId, row]));
  const out: PlacementScore[] = [];
  for (const score of opts.scores) {
    if (opts.keepCampaignId && !opts.keepCampaignId(score.campaignId)) continue;
    if (score.inboxPercent >= threshold) continue;
    if (
      hasOpenIsolation({
        existing: suspectById.get(score.campaignId),
        openRun: opts.latestRun(score.campaignId),
      })
    ) {
      continue;
    }
    out.push(score);
  }
  return out;
}

/** Fresh 0% without a suspect is a QUEUE, not a skip (A8). */
export function shouldQueueUglyScore(opts: {
  score: PlacementScore;
  suspect?: IsolationSuspect;
  run?: IsolationRun;
  threshold?: number;
}): boolean {
  const threshold = opts.threshold ?? INBOX_THRESHOLD;
  if (opts.score.inboxPercent >= threshold) return false;
  return !hasOpenIsolation({ existing: opts.suspect, openRun: opts.run });
}

export function isolationOverdue(
  firstUglyAt: string,
  now = Date.now(),
  deadlineMs = ISOLATION_DEADLINE_MS,
): boolean {
  const t = Date.parse(firstUglyAt);
  if (!Number.isFinite(t)) return false;
  return now - t >= deadlineMs;
}

export interface CopyCanarySplit {
  unwarmedLanded: boolean | null;
  warmedLanded: boolean | null;
  unwarmedTested: number;
  warmedTested: number;
}

export function majorityLanded(inboxCount: number, tested: number): boolean | null {
  if (tested <= 0) return null;
  return inboxCount * 2 >= tested;
}

export function interpretCopyCanary(
  split: CopyCanarySplit,
): { lean: "COPY" | "INFRA" | "WARMUP" | "NONE"; reason: string } {
  if (split.unwarmedLanded == null) {
    return { lean: "NONE", reason: "No unwarmed campaign-copy reading yet." };
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
  return { lean: "NONE", reason: "Unwarmed campaign-copy reading does not change the call." };
}

export function decideIsolationVerdict(input: {
  knownGoodFineAcrossEsps?: boolean | null;
  unwarmedCopyFineAcrossEsps?: boolean | null;
  copyCanary?: CopyCanarySplit | null;
  contentBlock?: boolean;
}): { verdict: "INFRA" | "COPY" | "INCONCLUSIVE" | "HEALTHY"; reason: string; startCopyTeardown: boolean } {
  const canary = input.copyCanary
    ? interpretCopyCanary(input.copyCanary)
    : { lean: "NONE" as const, reason: "" };

  if (input.knownGoodFineAcrossEsps === false) {
    return {
      verdict: "INFRA",
      reason: "Known-good email on those domains is failing an ESP.",
      startCopyTeardown: false,
    };
  }
  if (input.contentBlock && canary.lean === "COPY") {
    return {
      verdict: "COPY",
      reason: "Dominant bounce class is content_block and the unwarmed canary is under the inbox bar.",
      startCopyTeardown: true,
    };
  }
  if (canary.lean === "INFRA") {
    return { verdict: "INFRA", reason: canary.reason, startCopyTeardown: false };
  }
  if (canary.lean === "COPY" && input.unwarmedCopyFineAcrossEsps === false) {
    return {
      verdict: "COPY",
      reason: canary.reason,
      startCopyTeardown: true,
    };
  }
  if (canary.lean === "NONE" || canary.lean === "WARMUP") {
    return {
      verdict: "INCONCLUSIVE",
      reason: canary.reason || "Need an unwarmed reading before hunting a word.",
      startCopyTeardown: false,
    };
  }
  return {
    verdict: "INCONCLUSIVE",
    reason: "Not enough same-ESP evidence yet.",
    startCopyTeardown: false,
  };
}

export function duplicateCanaryTests(
  tests: SpamTest[],
  campaignId: number,
): SpamTest[] {
  // D303 — a [variant X] canary is that variant's own test, not a duplicate.
  return tests.filter(
    (t) => campaignIdFromCanaryTestName(t.name) === campaignId && !/\[variant [^\]]+\]/.test(String(t.name ?? "")),
  );
}

export function pickLivingCanaryTest(tests: SpamTest[], campaignId: number): SpamTest | undefined {
  const mine = duplicateCanaryTests(tests, campaignId).filter((t) => {
    const status = String(t.status ?? "").toLowerCase();
    return !/stop|complet|cancel|expir|fail|delet|finish|end/.test(status);
  });
  return mine[0];
}

/** Priority: already-0% first, then never-scored, then the rest. Never skip a 0% because it is "fresh". */
export function prioritizeCampaigns(opts: {
  campaigns: SlimCampaign[];
  scores: PlacementScore[];
  ugly: PlacementScore[];
}): SlimCampaign[] {
  const uglyIds = new Set(opts.ugly.map((s) => s.campaignId));
  const scoredIds = new Set(opts.scores.map((s) => s.campaignId));
  const active = opts.campaigns.filter((c) => isActiveSendingStatus(c.status));
  const rank = (c: SlimCampaign): number => {
    if (uglyIds.has(c.id)) return 0;
    if (!scoredIds.has(c.id)) return 1;
    return 2;
  };
  return [...active].sort((a, b) => rank(a) - rank(b) || a.id - b.id);
}
