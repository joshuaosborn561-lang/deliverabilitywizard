/**
 * D195 / D248 — strip the decision buttons off every #deliverability copy
 * of an ask once it is resolved (human, wizard auto-dismiss, already
 * settled, buy superseded by retire). A D133 parent card is often posted
 * as *Deliverability Wizard*, so a `chat.update` with the Watchdog token
 * returns `cant_update_message` — only the posting identity or the tap's
 * `response_url` can edit it.
 *
 * Preference order:
 *   1. `response_url` with `replace_original: true` — the native-button tap
 *      hands us a signed URL that edits the exact message regardless of which
 *      identity posted it. Section blocks only; no actions block.
 *   2. `chat.update` every stamped copy (`slackMessages` plus legacy
 *      slackChannel + slackTs) with the posting bot token.
 */

import { slackStampsFromDetail, type SlackAskStamp } from "./slackAskStamps.js";

export type IsolationAskDecision = "approve" | "deny";

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** D248 — every settled copy becomes this one-liner with no buttons. */
export function resolvedByLine(resolvedBy: string): string {
  const who = resolvedBy.trim() || "the wizard";
  return `Resolved by ${who}: nothing to do`;
}

/** Canned resolved-summary line by ask kind + decision (D195). */
export function resolvedAskLabel(
  kind: string,
  decision: IsolationAskDecision,
): string {
  if (kind === "swap_copy") {
    return decision === "approve"
      ? ":white_check_mark: Resolved — edit applied."
      : ":white_check_mark: Resolved — not now.";
  }
  if (kind === "generic_backfill") {
    return decision === "approve"
      ? ":white_check_mark: Resolved — generics allowed."
      : ":white_check_mark: Resolved — generics stay off (not now).";
  }
  if (kind === "retire_domain") {
    return decision === "approve"
      ? ":white_check_mark: Resolved — retired; replacement queued."
      : ":white_check_mark: Resolved — not now.";
  }
  if (kind === "buy_domains") {
    return decision === "approve"
      ? ":white_check_mark: Resolved — cover buy queued."
      : ":white_check_mark: Resolved — not now.";
  }
  if (kind === "buy_canary_fleet" || kind === "buy_isolation_domain") {
    return decision === "approve"
      ? ":white_check_mark: Resolved — buy approved."
      : ":white_check_mark: Resolved — not now.";
  }
  return decision === "approve"
    ? ":white_check_mark: Resolved."
    : ":white_check_mark: Resolved — not now.";
}

/**
 * The replacement message: a summary section and a resolved-status section,
 * and (optionally) a context line with the execute result. No actions block,
 * so the buttons are gone.
 */
export function buildResolvedAskBlocks(input: {
  summary: string;
  resolvedLabel: string;
  detail?: string;
}): unknown[] {
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: input.summary } },
    { type: "section", text: { type: "mrkdwn", text: input.resolvedLabel } },
  ];
  const detail = input.detail?.trim();
  if (detail && detail !== input.resolvedLabel.trim()) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: detail }],
    });
  }
  return blocks;
}

function plainText(summary: string, resolvedLabel: string): string {
  return `${summary.replace(/[*_`]/g, "")}\n${resolvedLabel.replace(/:white_check_mark:\s*/, "")}`;
}

export interface ResolveIsolationAskInput {
  /** From a native block_actions tap. Preferred strip path. */
  responseUrl?: string;
  /** Stamped on the ask when notifyIsolationAction posted the card. */
  channel?: string;
  ts?: string;
  /** Every copy ever posted for this ask (D248). */
  stamps?: SlackAskStamp[];
  detailRecord?: Record<string, unknown>;
  /** Who resolved it — human name or "the wizard". */
  resolvedBy?: string;
  /** The identity that posted the card (chat.update fallback). */
  botToken?: string;
  summary: string;
  kind: string;
  decision: IsolationAskDecision;
  /** Optional detail line (e.g. the execute result message). */
  detail?: string;
  fetchImpl?: FetchLike;
}

export type ResolveIsolationAskResult = {
  ok: boolean;
  via: "response_url" | "chat_update" | "none";
  error?: string;
};

/**
 * Best-effort: never throws. Returns which path stripped the card. A UX
 * nicety on top of the decide — a failure here does not fail the decision.
 */
export async function resolveIsolationAskMessage(
  input: ResolveIsolationAskInput,
): Promise<ResolveIsolationAskResult> {
  const doFetch = (input.fetchImpl ?? (fetch as unknown as FetchLike)) as FetchLike;
  const resolvedLabel = input.resolvedBy
    ? resolvedByLine(input.resolvedBy)
    : resolvedAskLabel(input.kind, input.decision);
  const blocks = buildResolvedAskBlocks({
    summary: input.resolvedBy ? resolvedLabel : input.summary,
    resolvedLabel,
    detail: input.resolvedBy ? undefined : input.detail,
  });
  const text = input.resolvedBy
    ? resolvedLabel
    : plainText(input.summary, resolvedLabel);
  const stamps: SlackAskStamp[] = [
    ...(input.stamps ?? slackStampsFromDetail(input.detailRecord)),
  ];
  if (!stamps.length && input.channel && input.ts) {
    stamps.push({ channel: input.channel, ts: input.ts });
  }

  let viaResponse = false;
  if (input.responseUrl) {
    try {
      const res = await doFetch(input.responseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ replace_original: true, text, blocks }),
      });
      if (res.ok) viaResponse = true;
      else if (!stamps.length || !input.botToken) {
        return { ok: false, via: "response_url", error: `HTTP ${res.status}` };
      }
    } catch (error) {
      if (!stamps.length || !input.botToken) {
        return {
          ok: false,
          via: "response_url",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }

  if (viaResponse && stamps.length <= 1) {
    return { ok: true, via: "response_url" };
  }

  if (input.botToken && stamps.length) {
    let updated = 0;
    let lastError: string | undefined;
    for (const stamp of stamps) {
      try {
        const res = await doFetch("https://slack.com/api/chat.update", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${input.botToken}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            channel: stamp.channel,
            ts: stamp.ts,
            text,
            blocks,
          }),
        });
        const body = (await res.json()) as { ok?: boolean; error?: string };
        if (res.ok && body.ok) updated += 1;
        else lastError = body.error ?? `HTTP ${res.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    if (updated > 0) return { ok: true, via: "chat_update" };
    if (viaResponse) return { ok: true, via: "response_url" };
    return {
      ok: false,
      via: "chat_update",
      error: lastError,
    };
  }

  if (viaResponse) return { ok: true, via: "response_url" };
  return { ok: false, via: "none" };
}

export async function clearAskCopies(input: {
  detail: Record<string, unknown>;
  botToken?: string;
  resolvedBy: string;
  fetchImpl?: FetchLike;
}): Promise<ResolveIsolationAskResult> {
  return resolveIsolationAskMessage({
    detailRecord: input.detail,
    botToken: input.botToken,
    resolvedBy: input.resolvedBy,
    summary: resolvedByLine(input.resolvedBy),
    kind: "retire_domain",
    decision: "deny",
    fetchImpl: input.fetchImpl,
  });
}
