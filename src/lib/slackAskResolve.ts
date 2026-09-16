/**
 * D195 — after Apply / Not now / Allow-generics resolve / Buy resolve,
 * rewrite the ORIGINAL Slack parent so interactive buttons disappear.
 *
 * Incoming-webhook / username-override parents cannot be updated by a
 * different bot token (cant_update_message). Prefer response_url
 * replace_original (works for the posting identity). Fall back to
 * chat.update with the posting bot token when channel+ts are known.
 */

export type SlackAskResolveStatus =
  | "edit_applied"
  | "not_now"
  | "generics_resolved"
  | "buy_resolved"
  | "resolved";

export function slackAskResolvedLabel(status: SlackAskResolveStatus): string {
  switch (status) {
    case "edit_applied":
      return "Resolved — edit applied";
    case "not_now":
      return "Resolved — not now";
    case "generics_resolved":
      return "Resolved — generics decision recorded";
    case "buy_resolved":
      return "Resolved — buy / retire decision recorded";
    default:
      return "Resolved";
  }
}

export function slackAskResolveStatusFor(
  kind: string | undefined,
  decision: "approve" | "deny",
): SlackAskResolveStatus {
  if (decision === "deny") return "not_now";
  if (kind === "swap_copy" || kind === "add_signature_tag") return "edit_applied";
  if (kind === "generic_backfill") return "generics_resolved";
  if (
    kind === "buy_domains" ||
    kind === "buy_canary_fleet" ||
    kind === "buy_isolation_domain" ||
    kind === "retire_domain"
  ) {
    return "buy_resolved";
  }
  return "resolved";
}

/** Closed parent body: keep a short summary, strip all actions blocks. */
export function closedIsolationAskBlocks(input: {
  title?: string;
  status: SlackAskResolveStatus;
  resultText: string;
}): Array<Record<string, unknown>> {
  const label = slackAskResolvedLabel(input.status);
  const head = input.title?.trim() ? `*${input.title.trim()}*\n${label}` : label;
  const body = [head, "", input.resultText.trim()].filter(Boolean).join("\n");
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: body.slice(0, 2900) },
    },
  ];
}

export async function replaceOriginalViaResponseUrl(input: {
  responseUrl: string;
  text: string;
  blocks: Array<Record<string, unknown>>;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(input.responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replace_original: true,
        text: input.text,
        blocks: input.blocks,
      }),
    });
    const raw = await response.text();
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}: ${raw.slice(0, 200)}` };
    }
    // Slack may return "ok" plain text or JSON.
    if (raw && raw !== "ok") {
      try {
        const parsed = JSON.parse(raw) as { ok?: boolean; error?: string };
        if (parsed.ok === false) {
          return { ok: false, error: parsed.error ?? raw.slice(0, 200) };
        }
      } catch {
        // plain ok / empty
      }
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function chatUpdateStripActions(input: {
  token: string;
  channel: string;
  ts: string;
  text: string;
  blocks: Array<Record<string, unknown>>;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch("https://slack.com/api/chat.update", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: input.channel,
        ts: input.ts,
        text: input.text,
        blocks: input.blocks,
      }),
    });
    const body = (await response.json()) as { ok?: boolean; error?: string };
    if (!response.ok || !body.ok) {
      return { ok: false, error: body.error || `HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Prefer response_url replace_original; else chat.update with the
 * posting bot. Never throws — callers still announce the result.
 */
export async function resolveIsolationAskMessage(input: {
  responseUrl?: string;
  token?: string;
  channel?: string;
  ts?: string;
  title?: string;
  status: SlackAskResolveStatus;
  resultText: string;
}): Promise<{ ok: boolean; via?: "response_url" | "chat.update"; error?: string }> {
  const blocks = closedIsolationAskBlocks({
    title: input.title,
    status: input.status,
    resultText: input.resultText,
  });
  const text = slackAskResolvedLabel(input.status);
  if (input.responseUrl?.trim()) {
    const replaced = await replaceOriginalViaResponseUrl({
      responseUrl: input.responseUrl.trim(),
      text,
      blocks,
    });
    if (replaced.ok) return { ok: true, via: "response_url" };
    // Fall through to chat.update when possible.
    if (!input.token || !input.channel || !input.ts) {
      return { ok: false, error: replaced.error };
    }
  }
  if (input.token?.trim() && input.channel?.trim() && input.ts?.trim()) {
    const updated = await chatUpdateStripActions({
      token: input.token.trim(),
      channel: input.channel.trim(),
      ts: input.ts.trim(),
      text,
      blocks,
    });
    if (updated.ok) return { ok: true, via: "chat.update" };
    return { ok: false, error: updated.error };
  }
  return {
    ok: false,
    error: "No response_url or channel/ts available to strip buttons",
  };
}
