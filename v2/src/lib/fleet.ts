import {
  CONTAMINATED_CANARY_DOMAINS,
  defaultReleasedCanaryEmails,
} from "../canon/constants.js";

export function emailDomain(email: string): string {
  return email.trim().toLowerCase().split("@")[1] ?? "";
}

export function isReleasedCanaryDomain(domain: string): boolean {
  const key = domain.trim().toLowerCase();
  return (CONTAMINATED_CANARY_DOMAINS as readonly string[]).includes(key);
}

export function isReleasedCanaryEmail(
  email: string,
  extraEmails: readonly string[] = [],
): boolean {
  const key = email.trim().toLowerCase();
  if (!key.includes("@")) return false;
  if (isReleasedCanaryDomain(emailDomain(key))) return true;
  if (defaultReleasedCanaryEmails().includes(key)) return true;
  return extraEmails.some((row) => row.toLowerCase() === key);
}

export function isCopyCanaryFleetEmail(
  email: string,
  fleetEmails: readonly string[],
): boolean {
  const key = email.trim().toLowerCase();
  if (isReleasedCanaryEmail(key)) return false;
  return fleetEmails.some((row) => row.toLowerCase() === key);
}

export function livingFleetEmails(
  tagged: readonly string[],
  envEmails: readonly string[],
): string[] {
  const set = new Set<string>();
  for (const email of [...tagged, ...envEmails]) {
    const key = email.trim().toLowerCase();
    if (!key.includes("@")) continue;
    if (isReleasedCanaryEmail(key)) continue;
    set.add(key);
  }
  return [...set];
}
