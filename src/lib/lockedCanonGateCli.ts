/**
 * D322 — CI entry for the locked-canon job.
 *
 * Compares the PR head to the base. Canon-consistent PRs exit 0 without
 * calling GitHub. Locked edits exit 0 only when the canon-change label
 * was approved by Josh; otherwise they exit 1 (never auto-merge).
 *
 * Env: BASE_REF, PR_NUMBER, REPOSITORY, GH_TOKEN / GITHUB_TOKEN.
 * Never prints the token.
 *
 * Importing this module does nothing. The locked-canon job runs it
 * directly (`tsx src/lib/lockedCanonGateCli.ts`).
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  CANON_CHANGE_LABEL,
  LOCKED_DEFINITION_FILES,
  evaluateLockedCanonGate,
  lockedDefinitionDrift,
  type LabelEvent,
  type Review,
} from "./lockedCanonGate.js";

function gitShow(rev: string, path: string): string | null {
  try {
    return execFileSync("git", ["show", `${rev}:${path}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

function readHead(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function nextLink(response: Response): string | null {
  const link = response.headers.get("link");
  if (!link) return null;
  for (const part of link.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

async function github(url: string, token: string): Promise<Response> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "locked-canon-gate",
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GitHub ${response.status} ${url.split("?")[0]}: ${body.slice(0, 200)}`,
    );
  }
  return response;
}

async function githubPages<T>(start: string, token: string): Promise<T[]> {
  const items: T[] = [];
  let url: string | null = start;
  for (let page = 0; url && page < 10; page += 1) {
    const response = await github(url, token);
    const body = (await response.json()) as T[];
    items.push(...body);
    url = nextLink(response);
  }
  return items;
}

function failClosed(message: string): never {
  console.error(message);
  console.error(
    "Never auto-merge. Needs the canon-change label approved by Josh (joshuaosborn561-lang).",
  );
  process.exit(1);
}

export async function runLockedCanonGate(): Promise<void> {
  const baseRef = process.env.BASE_REF || process.env.GITHUB_BASE_REF || "";
  if (!baseRef) failClosed("No base ref; treating this as a locked-canon change.");

  const baseRev = `origin/${baseRef}`;
  const drift = lockedDefinitionDrift({
    baseCanon: gitShow(baseRev, "CANON.md"),
    headCanon: readHead("CANON.md") ?? "",
    files: LOCKED_DEFINITION_FILES.map((path) => ({
      path,
      base: gitShow(baseRev, path),
      head: readHead(path),
    })),
  });

  const changed =
    drift.lockedSectionChanged || drift.definitionFilesChanged.length > 0;
  let labels: string[] = [];
  let reviews: Review[] = [];
  let labelEvents: LabelEvent[] = [];

  if (changed) {
    const pr = process.env.PR_NUMBER || process.env.GITHUB_PR_NUMBER || "";
    const repo = process.env.REPOSITORY || process.env.GITHUB_REPOSITORY || "";
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
    if (!pr || !repo || !token) {
      failClosed(
        "Locked canon changed, but the PR number, repository, or token is missing.",
      );
    }
    const root = `https://api.github.com/repos/${repo}`;
    const pullResponse = await github(`${root}/pulls/${pr}`, token);
    const pull = (await pullResponse.json()) as {
      labels?: { name?: string }[];
    };
    labels = (pull.labels ?? [])
      .map((label) => label.name ?? "")
      .filter(Boolean);
    if (labels.includes(CANON_CHANGE_LABEL)) {
      const reviewList = await githubPages<{
        user?: { login?: string };
        state?: string;
      }>(`${root}/pulls/${pr}/reviews?per_page=100`, token);
      reviews = reviewList.map((review) => ({
        login: review.user?.login ?? "",
        state: review.state ?? "",
      }));
      const events = await githubPages<{
        event?: string;
        label?: { name?: string };
        actor?: { login?: string };
      }>(`${root}/issues/${pr}/events?per_page=100`, token);
      labelEvents = events.map((event) => ({
        event: event.event ?? "",
        label: event.label?.name,
        actor: event.actor?.login,
      }));
    }
  }

  const result = evaluateLockedCanonGate({
    ...drift,
    labels,
    reviews,
    labelEvents,
  });
  if (result.ok) {
    console.log(result.message);
    return;
  }
  console.error(result.message);
  process.exit(1);
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  runLockedCanonGate().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    console.error(
      "Never auto-merge. Locked-canon gate could not verify Josh's approval.",
    );
    process.exit(1);
  });
}
