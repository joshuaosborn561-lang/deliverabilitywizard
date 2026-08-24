import type { SmartleadClientRecord } from "../clients/smartlead.js";

export type OwnershipKind = "client" | "generic" | "canary" | "wiped" | "agency";

export interface ClientWorkspaceRule {
  key: string;
  kind: OwnershipKind;
  workspaceName: RegExp;
  clientName: RegExp | null;
  domains: RegExp[];
}

/**
 * InboxKit workspace ↔ Smartlead client. Match by name / domain, not a
 * hardcoded workspace UUID — those move if a workspace is recreated.
 */
export const CLIENT_WORKSPACE_RULES: ClientWorkspaceRule[] = [
  {
    key: "bcp",
    kind: "client",
    workspaceName: /bolder\s*cyber|boldercyper/i,
    clientName: /trpkosh|bolder\s*cyber/i,
    domains: [/boldercyper/i],
  },
  {
    key: "parlay",
    kind: "client",
    workspaceName: /parlay/i,
    clientName: /parlay/i,
    domains: [/parlay/i],
  },
  {
    key: "culturefits",
    kind: "client",
    workspaceName: /culture\s*fits?/i,
    clientName: /culture\s*fits?/i,
    domains: [/culturefits?/i],
  },
  {
    key: "peterson",
    kind: "client",
    workspaceName: /peterson|roofs/i,
    clientName: /peterson/i,
    domains: [/peterson/i],
  },
  {
    key: "vasco",
    kind: "client",
    workspaceName: /vasco/i,
    clientName: /vasco/i,
    domains: [/vasco/i],
  },
  {
    key: "goliath",
    kind: "client",
    workspaceName: /goliath/i,
    clientName: /goliath/i,
    domains: [/goliath/i],
  },
  {
    key: "techevolution",
    kind: "client",
    workspaceName: /tech\s*evolution/i,
    clientName: /tech\s*evolution/i,
    domains: [/techevolution/i],
  },
  {
    key: "cornerstone",
    kind: "client",
    workspaceName: /cornerstone/i,
    clientName: /cornerstone/i,
    domains: [/cornerstone/i],
  },
  {
    key: "macrocheetah",
    kind: "client",
    workspaceName: /macro\s*cheetah/i,
    clientName: /macro\s*cheetah|\bcheetah\b/i,
    domains: [/macrocheetah|cheetah/i],
  },
  {
    key: "nutter",
    kind: "client",
    workspaceName: /nutter/i,
    clientName: /nutter/i,
    domains: [/nutter/i],
  },
  {
    key: "insight",
    kind: "client",
    workspaceName: /insight|joshua\s*osborn/i,
    clientName: /insight/i,
    domains: [/insight/i],
  },
  {
    key: "generic",
    kind: "generic",
    workspaceName: /generic\s*pool/i,
    clientName: null,
    domains: [],
  },
  {
    key: "agency",
    kind: "agency",
    workspaceName: /salesglider/i,
    clientName: null,
    domains: [],
  },
  {
    key: "wiped",
    kind: "wiped",
    workspaceName: /nieto|\bmsrs\b|\bgxa\b/i,
    clientName: /nieto|\bmsrs\b|\bgxa\b/i,
    domains: [/nieto|\bmsrs\b|\bgxa\b/i],
  },
];

export function matchRuleByDomain(domain: string): ClientWorkspaceRule | undefined {
  const d = domain.trim().toLowerCase();
  if (!d) return undefined;
  return CLIENT_WORKSPACE_RULES.find((rule) =>
    rule.domains.some((pattern) => pattern.test(d)),
  );
}

export function matchRuleByWorkspaceName(
  name: string | undefined,
): ClientWorkspaceRule | undefined {
  if (!name) return undefined;
  return CLIENT_WORKSPACE_RULES.find((rule) => rule.workspaceName.test(name));
}

export function matchSmartleadClient(
  clients: SmartleadClientRecord[],
  pattern: RegExp | null,
): SmartleadClientRecord | undefined {
  if (!pattern) return undefined;
  return clients.find((client) => pattern.test(client.name ?? ""));
}

export function expectedClientForDomain(
  domain: string,
  clients: SmartleadClientRecord[],
): SmartleadClientRecord | undefined {
  const rule = matchRuleByDomain(domain);
  if (!rule || rule.kind !== "client") return undefined;
  return matchSmartleadClient(clients, rule.clientName);
}
