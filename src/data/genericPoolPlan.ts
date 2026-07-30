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
  "mailboxesPerDomain": 5,
  "warmupDaysBeforeAvailable": 14,
  "targetMailboxes": 200,
  "googleShare": "60%",
  "microsoftShare": "40%",
  "note": "24 Google + 16 Microsoft domains × 5 = 200. Existing .info kept; subset of new .com retained after cut from 240.",
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
    },
    {
      "domain": "meetconnectnow.com",
      "parent": "meet-connect.com",
      "platform": "GOOGLE"
    },
    {
      "domain": "meetconnectgo.com",
      "parent": "meet-connect.com",
      "platform": "GOOGLE"
    },
    {
      "domain": "nowoutreachdesk.com",
      "parent": "theoutreachdesk.com",
      "platform": "GOOGLE"
    },
    {
      "domain": "outreachdesknow.com",
      "parent": "theoutreachdesk.com",
      "platform": "GOOGLE"
    },
    {
      "domain": "appmeetconnect.com",
      "parent": "meet-connect.com",
      "platform": "GOOGLE"
    },
    {
      "domain": "appoutreachdesk.com",
      "parent": "theoutreachdesk.com",
      "platform": "GOOGLE"
    },
    {
      "domain": "meetconnectapp.com",
      "parent": "meet-connect.com",
      "platform": "GOOGLE"
    },
    {
      "domain": "outreachdeskapp.com",
      "parent": "theoutreachdesk.com",
      "platform": "GOOGLE"
    },
    {
      "domain": "hubmeetconnect.com",
      "parent": "meet-connect.com",
      "platform": "GOOGLE"
    },
    {
      "domain": "huboutreachdesk.com",
      "parent": "theoutreachdesk.com",
      "platform": "GOOGLE"
    },
    {
      "domain": "meetconnecthub.com",
      "parent": "meet-connect.com",
      "platform": "GOOGLE"
    },
    {
      "domain": "getintroducednow.com",
      "parent": "getintroduced.io",
      "platform": "MICROSOFT"
    },
    {
      "domain": "nowgetintroduced.com",
      "parent": "getintroduced.io",
      "platform": "MICROSOFT"
    },
    {
      "domain": "nowquickconnectsales.com",
      "parent": "quickconnectsales.com",
      "platform": "MICROSOFT"
    },
    {
      "domain": "quickconnectsalesnow.com",
      "parent": "quickconnectsales.com",
      "platform": "MICROSOFT"
    }
  ],
  "smartleadSequencerUid": "232f4cac-a2a7-4b44-ae86-6b0d98cafb5e",
  "smartleadSequencerName": "SmartLead Account",
  "expansion": {
    "requestedAt": "2026-07-24T00:37:20.526Z",
    "readyByApprox": "2026-07-24T18:20:00Z",
    "newDomains": [
      {
        "domain": "meetconnectnow.com",
        "parent": "meet-connect.com",
        "platform": "GOOGLE",
        "affix": "now"
      },
      {
        "domain": "meetconnectgo.com",
        "parent": "meet-connect.com",
        "platform": "GOOGLE",
        "affix": "now"
      },
      {
        "domain": "nowoutreachdesk.com",
        "parent": "theoutreachdesk.com",
        "platform": "GOOGLE",
        "affix": "now"
      },
      {
        "domain": "outreachdesknow.com",
        "parent": "theoutreachdesk.com",
        "platform": "GOOGLE",
        "affix": "now"
      },
      {
        "domain": "appmeetconnect.com",
        "parent": "meet-connect.com",
        "platform": "GOOGLE",
        "affix": "app"
      },
      {
        "domain": "appoutreachdesk.com",
        "parent": "theoutreachdesk.com",
        "platform": "GOOGLE",
        "affix": "app"
      },
      {
        "domain": "meetconnectapp.com",
        "parent": "meet-connect.com",
        "platform": "GOOGLE",
        "affix": "app"
      },
      {
        "domain": "outreachdeskapp.com",
        "parent": "theoutreachdesk.com",
        "platform": "GOOGLE",
        "affix": "app"
      },
      {
        "domain": "hubmeetconnect.com",
        "parent": "meet-connect.com",
        "platform": "GOOGLE",
        "affix": "hub"
      },
      {
        "domain": "huboutreachdesk.com",
        "parent": "theoutreachdesk.com",
        "platform": "GOOGLE",
        "affix": "hub"
      },
      {
        "domain": "meetconnecthub.com",
        "parent": "meet-connect.com",
        "platform": "GOOGLE",
        "affix": "hub"
      },
      {
        "domain": "getintroducednow.com",
        "parent": "getintroduced.io",
        "platform": "MICROSOFT",
        "affix": "now"
      },
      {
        "domain": "nowgetintroduced.com",
        "parent": "getintroduced.io",
        "platform": "MICROSOFT",
        "affix": "now"
      },
      {
        "domain": "nowquickconnectsales.com",
        "parent": "quickconnectsales.com",
        "platform": "MICROSOFT",
        "affix": "now"
      },
      {
        "domain": "quickconnectsalesnow.com",
        "parent": "quickconnectsales.com",
        "platform": "MICROSOFT",
        "affix": "now"
      }
    ],
    "newDomainTld": "com",
    "reasonNewTld": "Porkbun API create rate limit (50/day) exhausted for ~19h; InboxKit domain register supports .com/.net/.org/.shop only",
    "topUpExistingFrom": 3,
    "topUpExistingTo": 5,
    "topUpOrderedAt": "2026-07-24T00:37:20.526Z",
    "updatedAt": "2026-07-24T03:43:12Z",
    "replacedUnavailable": {
      "from": "nowmeetconnect.com",
      "to": "meetconnectgo.com",
      "at": "2026-07-24T00:41:12.929Z"
    },
    "domainsRegisteredAt": "2026-07-24T00:44:00Z",
    "mailboxesOrderedAt": "2026-07-24T00:46:31Z",
    "targetMailboxes": 200,
    "orderedMailboxes": 200,
    "note": "Retargeted from 240→200 (dropped 5 Google + 3 Microsoft .com domains). 120G/80M.",
    "cutFrom": 240,
    "cutAt": "2026-07-24T00:50:32.283Z",
    "droppedDomains": [
      "outreachdeskbox.com",
      "meetconnectbox.com",
      "boxoutreachdesk.com",
      "boxmeetconnect.com",
      "outreachdeskhub.com",
      "getintroducedapp.com",
      "appquickconnectsales.com",
      "appgetintroduced.com"
    ],
    "pendingAllInfoMigration": {
      "reason": "Porkbun 50 creates/24h rate limit",
      "comDomains": [
        "meetconnectnow.com",
        "meetconnectgo.com",
        "nowoutreachdesk.com",
        "outreachdesknow.com",
        "appmeetconnect.com",
        "appoutreachdesk.com",
        "meetconnectapp.com",
        "outreachdeskapp.com",
        "hubmeetconnect.com",
        "huboutreachdesk.com",
        "meetconnecthub.com",
        "getintroducednow.com",
        "nowgetintroduced.com",
        "nowquickconnectsales.com",
        "quickconnectsalesnow.com"
      ],
      "infoTargets": [
        "meetconnectnow.info",
        "meetconnectgo.info",
        "nowoutreachdesk.info",
        "outreachdesknow.info",
        "appmeetconnect.info",
        "appoutreachdesk.info",
        "meetconnectapp.info",
        "outreachdeskapp.info",
        "hubmeetconnect.info",
        "huboutreachdesk.info",
        "meetconnecthub.info",
        "getintroducednow.info",
        "nowgetintroduced.info",
        "nowquickconnectsales.info",
        "quickconnectsalesnow.info"
      ],
      "etaApprox": "2026-07-24T19:43:12Z",
      "script": "scripts/migrate-pool-com-to-info.ts --wait"
    }
  }
};
