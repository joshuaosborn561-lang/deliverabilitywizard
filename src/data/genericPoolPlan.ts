// AUTO-GENERATED from data/generic-pool-domains.json — do not edit by hand.
//
// The plan is embedded as a module rather than read from disk because the
// production builder (Railpack/Nixpacks, not the Dockerfile) does not reliably
// ship data/ into the runtime image, which left the pool provisioner dead with
// "plan load failed". Compiled into dist/, this is always present.
//
// To change the pool, edit data/generic-pool-domains.json and re-run:
//   npm run gen:pool-plan
import type { PoolDomainPlan } from '../services/poolProvisioner.js';

export const GENERIC_POOL_PLAN: PoolDomainPlan = {
  "workspaceId": "81e7f800-4203-4892-a40d-18648b89b90c",
  "workspaceName": "DW Generic Pool",
  "mailboxesPerDomain": 3,
  "warmupDaysBeforeAvailable": 14,
  "note": "Cannot mix GOOGLE and MICROSOFT on the same domain. 13 Google + 12 Microsoft domains = 75 mailboxes.",
  "domains": [
    {
      "domain": "getmeetconnect.info",
      "parent": "meet-connect.com",
      "platform": "GOOGLE"
    },
    {
      "domain": "trymeetconnect.info",
      "parent": "meet-connect.com",
      "platform": "GOOGLE"
    },
    {
      "domain": "gomeetconnect.info",
      "parent": "meet-connect.com",
      "platform": "GOOGLE"
    },
    {
      "domain": "usemeetconnect.info",
      "parent": "meet-connect.com",
      "platform": "GOOGLE"
    },
    {
      "domain": "mymeetconnect.info",
      "parent": "meet-connect.com",
      "platform": "GOOGLE"
    },
    {
      "domain": "meetconnectlab.info",
      "parent": "meet-connect.com",
      "platform": "GOOGLE"
    },
    {
      "domain": "meetconnectpro.info",
      "parent": "meet-connect.com",
      "platform": "GOOGLE"
    },
    {
      "domain": "getoutreachdesk.info",
      "parent": "theoutreachdesk.com",
      "platform": "GOOGLE"
    },
    {
      "domain": "gooutreachdesk.info",
      "parent": "theoutreachdesk.com",
      "platform": "GOOGLE"
    },
    {
      "domain": "myoutreachdesk.info",
      "parent": "theoutreachdesk.com",
      "platform": "GOOGLE"
    },
    {
      "domain": "outreachdesklab.info",
      "parent": "theoutreachdesk.com",
      "platform": "GOOGLE"
    },
    {
      "domain": "outreachdeskpro.info",
      "parent": "theoutreachdesk.com",
      "platform": "GOOGLE"
    },
    {
      "domain": "outreachdeskhq.info",
      "parent": "theoutreachdesk.com",
      "platform": "GOOGLE"
    },
    {
      "domain": "trygetintroduced.info",
      "parent": "getintroduced.io",
      "platform": "MICROSOFT"
    },
    {
      "domain": "gogetintroduced.info",
      "parent": "getintroduced.io",
      "platform": "MICROSOFT"
    },
    {
      "domain": "usegetintroduced.info",
      "parent": "getintroduced.io",
      "platform": "MICROSOFT"
    },
    {
      "domain": "mygetintroduced.info",
      "parent": "getintroduced.io",
      "platform": "MICROSOFT"
    },
    {
      "domain": "getintroducedlab.info",
      "parent": "getintroduced.io",
      "platform": "MICROSOFT"
    },
    {
      "domain": "getintroducedpro.info",
      "parent": "getintroduced.io",
      "platform": "MICROSOFT"
    },
    {
      "domain": "getintroducedhq.info",
      "parent": "getintroduced.io",
      "platform": "MICROSOFT"
    },
    {
      "domain": "getquickconnectsales.info",
      "parent": "quickconnectsales.com",
      "platform": "MICROSOFT"
    },
    {
      "domain": "tryquickconnectsales.info",
      "parent": "quickconnectsales.com",
      "platform": "MICROSOFT"
    },
    {
      "domain": "goquickconnectsales.info",
      "parent": "quickconnectsales.com",
      "platform": "MICROSOFT"
    },
    {
      "domain": "usequickconnectsales.info",
      "parent": "quickconnectsales.com",
      "platform": "MICROSOFT"
    },
    {
      "domain": "myquickconnectsales.info",
      "parent": "quickconnectsales.com",
      "platform": "MICROSOFT"
    }
  ],
  "smartleadSequencerUid": "232f4cac-a2a7-4b44-ae86-6b0d98cafb5e",
  "smartleadSequencerName": "SmartLead Account"
};
