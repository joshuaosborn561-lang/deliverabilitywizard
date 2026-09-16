/**
 * D195 — strip the decision buttons off a #deliverability ask once it is
 * resolved (Use suggested / Write my own / Not now / Allow generics resolve /
 * Buy resolve). A D133 parent card is often posted as *Deliverability
 * Wizard*, so a `chat.update` with the Watchdog / ai_reply_handler2 token
 * returns `cant_update_message` — only the posting identity or the tap's
 * `response_url` can edit it.
 *
 * Preference order:
 *   1. `response_url` with `replace_original: true` — the native-button tap
 *      hands us a signed URL that edits the exact message regardless of which
 *      identity posted it. Section blocks only; no actions block.
 *   2. `chat.update` with the **posting** bot token, when the ask carries the
 *      `detail.slackChannel` + `detail.slackTs` stamped at post time (the
 *      modal-submit and confirm-page paths, which have no `response_url`).
 */

export type IsolationAskDecision = "approve" | "deny";

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

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
  const resolvedLabel = resolvedAskLabel(input.kind, input.decision);
  const blocks = buildResolvedAskBlocks({
    summary: input.summary,
    resolvedLabel,
    detail: input.detail,
  });
  const text = plainText(input.summary, resolvedLabel);

  if (input.responseUrl) {
    try {
      const res = await doFetch(input.responseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ replace_original: true, text, blocks }),
      });
      if (res.ok) return { ok: true, via: "response_url" };
      // Fall through to chat.update if we have the coordinates.
      if (!(input.channel && input.ts && input.botToken)) {
        return { ok: false, via: "response_url", error: `HTTP ${res.status}` };
      }
    } catch (error) {
      if (!(input.channel && input.ts && input.botToken)) {
        return {
          ok: false,
          via: "response_url",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }

  if (input.channel && input.ts && input.botToken) {
    try {
      const res = await doFetch("https://slack.com/api/chat.update", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.botToken}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          channel: input.channel,
          ts: input.ts,
          text,
          blocks,
        }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (res.ok && body.ok) return { ok: true, via: "chat_update" };
      return {
        ok: false,
        via: "chat_update",
        error: body.error ?? `HTTP ${res.status}`,
      };
    } catch (error) {
      return {
        ok: false,
        via: "chat_update",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return { ok: false, via: "none" };
}
