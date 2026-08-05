/** True when a Smartlead campaign name belongs to the Bolder Cyber Partners fleet. */
export function isBcpCampaignName(name: string): boolean {
  return /\bbcp\b/i.test(name) || /bolder\s*cyper/i.test(name);
}

/** True when a sending domain is a BCP-owned brand domain (not a generic). */
export function isBcpOwnedDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return d.includes("boldercyper");
}
