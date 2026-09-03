/**
 * D153 — Slack modal so Josh/Cayden can type their own fleet-wide
 * replacement for a word-hunt find phrase. The modal always shows the
 * exact phrase being replaced before the input.
 */

export const SWAP_EDIT_CALLBACK_ID = "isolation_swap_edit";
export const SWAP_EDIT_ACTION_ID = "isolation_swap_edit";
export const SWAP_EDIT_INPUT_BLOCK_ID = "swap_edit_block";
export const SWAP_EDIT_INPUT_ACTION_ID = "swap_text";

export function swapEditModalView(input: {
  actionId: string;
  element: string;
  suggestedSwap: string;
  campaignName?: string;
}): Record<string, unknown> {
  const element = input.element.trim() || "(missing phrase)";
  const suggested = input.suggestedSwap;
  const campaign = input.campaignName?.trim();
  return {
    type: "modal",
    callback_id: SWAP_EDIT_CALLBACK_ID,
    private_metadata: input.actionId,
    title: { type: "plain_text", text: "Your edit" },
    submit: { type: "plain_text", text: "Apply my edit" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            campaign ? `*Campaign:* ${campaign}` : undefined,
            "*REMOVE this exact text:*",
            `\`\`\`${truncateForSlack(element, 2800)}\`\`\``,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "Whatever you type below replaces that phrase fleet-wide on every ACTIVE campaign that still carries it (D133). Leave blank to delete the phrase.",
          },
        ],
      },
      {
        type: "input",
        block_id: SWAP_EDIT_INPUT_BLOCK_ID,
        optional: true,
        label: { type: "plain_text", text: "REPLACE WITH" },
        element: {
          type: "plain_text_input",
          action_id: SWAP_EDIT_INPUT_ACTION_ID,
          multiline: true,
          initial_value: suggested.slice(0, 3000),
          placeholder: {
            type: "plain_text",
            text: "Type your replacement — or clear to delete",
          },
        },
      },
    ],
  };
}

export function swapTextFromViewSubmission(
  view: {
    state?: {
      values?: Record<
        string,
        Record<string, { value?: string | null } | undefined> | undefined
      >;
    };
  } | null | undefined,
): string {
  const raw =
    view?.state?.values?.[SWAP_EDIT_INPUT_BLOCK_ID]?.[SWAP_EDIT_INPUT_ACTION_ID]
      ?.value ?? "";
  return String(raw);
}

function truncateForSlack(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}
