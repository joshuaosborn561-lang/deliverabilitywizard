/**
 * Audit InboxKit workspaces vs Smartlead / SalesGlider client_id (D66).
 *
 *   npx tsx scripts/audit-client-ownership.ts
 *   npx tsx scripts/audit-client-ownership.ts --apply
 *
 * Without --apply this is a dry run. Workspace mismatches are reported
 * only — the script does not move InboxKit nameservers.
 */
import { loadConfig } from "../src/config.js";
import { InboxKitClient } from "../src/clients/inboxkit.js";
import { SlackClient } from "../src/clients/slack.js";
import { SmartleadClient } from "../src/clients/smartlead.js";
import { ClientOwnershipService } from "../src/services/clientOwnershipAudit.js";
import { StateStore } from "../src/state/store.js";

const apply = process.argv.includes("--apply");

const config = loadConfig({
  ...process.env,
  DRY_RUN: apply ? "false" : "true",
} as NodeJS.ProcessEnv);

const state = new StateStore(config.stateFilePath);
await state.load();

const smartlead = new SmartleadClient(config.smartleadApiKey || "missing");
const inboxkit = config.inboxkitApiKey
  ? new InboxKitClient(
      config.inboxkitApiKey,
      config.inboxkitWorkspaceId || config.genericPoolWorkspaceId || undefined,
      config.genericPoolWorkspaceId || undefined,
    )
  : null;
const slack = new SlackClient({
  webhookUrl: config.slackWebhookUrl,
  botToken: config.slackBotToken,
  botTokenFile: config.slackBotTokenFile,
  channelId: config.slackChannelId,
  channelLabel: config.slackChannel,
});

const service = new ClientOwnershipService(
  config,
  smartlead,
  inboxkit,
  slack,
  state,
);

const result = await service.auditInboxKit({ dryRun: !apply });
console.log(
  JSON.stringify(
    {
      dryRun: result.dryRun,
      examinedAccounts: result.examinedAccounts,
      examinedDomains: result.examinedDomains,
      applied: result.applied,
      workspaceFindings: result.workspaceFindings,
      missingInSmartlead: result.missingInSmartlead,
      skippedSample: result.skipped.slice(0, 20),
      skippedCount: result.skipped.length,
      errors: result.errors,
    },
    null,
    2,
  ),
);
