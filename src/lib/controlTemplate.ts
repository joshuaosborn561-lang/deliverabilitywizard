import { createHash } from "node:crypto";

/**
 * Fixed control email. Changing subject or body is a new control_version —
 * historical pod readings are not comparable across versions (D48).
 */

export const DEFAULT_CONTROL_SUBJECT = "Quick check-in";

export const DEFAULT_CONTROL_BODY_TEXT = [
  "Hi {{first_name}},",
  "",
  "I wanted to send a short note and see how things are going on your side this week.",
  "",
  "If now is a bad time, no need to reply.",
  "",
  "Best,",
  "Alex",
  "SalesGlider Growth",
].join("\n");

export interface ControlTemplate {
  controlVersion: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
}

export function controlVersionOf(subject: string, bodyText: string): string {
  const digest = createHash("sha256")
    .update(`${subject}\n${bodyText}`)
    .digest("hex")
    .slice(0, 12);
  return `ctl-${digest}`;
}

export function htmlFromPlain(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line.trim() === "" ? "<div><br></div>" : `<div>${escapeHtml(line)}</div>`,
    )
    .join("");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function defaultControlTemplate(): ControlTemplate {
  return buildControlTemplate(DEFAULT_CONTROL_SUBJECT, DEFAULT_CONTROL_BODY_TEXT);
}

export function buildControlTemplate(
  subject: string,
  bodyText: string,
): ControlTemplate {
  const trimmedSubject = subject.trim();
  const trimmedBody = bodyText.replace(/\r\n/g, "\n").trimEnd();
  return {
    controlVersion: controlVersionOf(trimmedSubject, trimmedBody),
    subject: trimmedSubject,
    bodyText: trimmedBody,
    bodyHtml: htmlFromPlain(trimmedBody),
  };
}

export function controlChanged(
  previous: Pick<ControlTemplate, "controlVersion"> | null | undefined,
  next: Pick<ControlTemplate, "controlVersion">,
): boolean {
  if (!previous) return true;
  return previous.controlVersion !== next.controlVersion;
}
