# Onboarding: campaign and mailbox ownership (D331 / D332)

This is for the Onboarding bot and anyone who sets up a client's campaigns
or mailboxes.

## Client spaces are gone. Never set `client_id`.

On 2026-11-11 Josh deleted every Smartlead client space (D331). `GET /client`
returns `[]`, and every campaign and mailbox has `client_id = null`.
**Never create a Smartlead client and never set `client_id`** on a campaign
or mailbox. The space it would point at does not exist. The wizard drops
`client_id` from every Smartlead write anyway (it logs `[ownership] …
recorded in override book`).

Ownership now comes from two places:

| Thing | Owner comes from |
|---|---|
| Campaign | Its Smartlead tag `sg-owner:<slug>`. Exactly one per campaign. |
| Mailbox | The committed seed (`src/data/mailboxOwnerSeed.ts`, 1,590 mailboxes from 2026-11-11), plus the wizard's override book. New mailboxes go into the override book through the API below. |

The valid slugs are the owner catalog in `src/lib/ownership.ts`
(`OWNER_CATALOG`):

`salesglider`, `parlay`, `culture_fits`, `techevo`, `bcp`, `peterson`,
`goliath`, `nutter`, `emcor`, `insight`, `powergryd`, `vector`, `bpltg`,
`nexus`, `virtual_pulsar`, `ciotola`, `cornerstone`, `deeproots`, `nieto`,
`msrs`, `positive`, `vasco`.

`cornerstone`, `deeproots`, `nieto`, `msrs`, `positive` and `vasco` never had
a client space. The wizard treats their campaigns and mailboxes as
unassigned (D331). They are still valid slugs. A new client needs a catalog
entry in a PR before its slug is accepted.

## 1. Tag every new campaign `sg-owner:<slug>`

In Smartlead, add exactly one tag named `sg-owner:<slug>` to the campaign
(for example `sg-owner:bcp`). The wizard reads tags with `include_tags=true`.

- **No tag** means the campaign is unowned. Campaign-check flags it as
  `missing_client_tag`. The wizard never guesses an owner from the campaign
  name.
- **Two different `sg-owner:` tags** make the owner ambiguous, so the
  campaign is unowned. Remove the wrong one.
- **Canary / pod-control / word-hunt shells** are made by the wizard. They
  are attributed to their own `sg-owner` tag, or else to their parent
  campaign's tag, but they never count as client campaigns (D332). You do
  not need to tag them.

## 2. Register new mailboxes

New mailboxes have no tag and no seed row, so register each one's owner
once it exists in Smartlead (you need its Smartlead email-account id).

```bash
curl -sS -X POST "$WIZARD_URL/ownership/mailboxes" \
  -H "content-type: application/json" \
  -H "x-run-token: $RUN_TOKEN" \
  -d '{
    "assignments": [
      { "accountId": 25600001, "email": "jane@bcp-mail.info", "slug": "bcp" },
      { "accountId": 25600002, "email": "joe@bcp-mail.info",  "slug": "bcp" }
    ]
  }'
```

`$RUN_TOKEN` is a placeholder for the wizard's `RUN_TOKEN` (the same token
`/run` and `/status` take). Never paste the real value into chat, a commit,
or a doc.

Rules:

- **Auth.** Without the right `x-run-token` you get `401`. If `RUN_TOKEN`
  is not configured on the server you get `503`.
- **Validation.** The whole batch is checked before anything is written. An
  unknown slug, a bad `accountId`, an `email` that does not match the
  mailbox the wizard knows, or the same `accountId` twice with different
  slugs returns `400` with `errors[]` and `validSlugs[]`. Nothing is written.
  `sg-owner:bcp` is accepted as a slug and means `bcp`. Up to 500 rows per
  request.
- **Idempotent.** Sending the same assignment again returns `unchanged` and
  writes nothing.
- **Per-row result** (`results[].status`):
  - `created`: newly recorded (source `onboarding_api`).
  - `updated`: an earlier onboarding assignment was corrected.
  - `unchanged`: it already had this owner (`via: "seed"` or
    `"override"`).
  - `conflict`: not written. Returned when the mailbox is in the seed
    under another owner, the wizard has moved it (min40, fan-out, …), or
    it is tagged `GENERIC` / `POC` / `CANARY`. Moving a mailbox between
    clients is not onboarding. Ask Josh.
- The response also has `changed`, `created`, `updated`, `unchanged` and
  `conflict` counts. The server logs `[ownership] D332 onboarding_api: …`.
- Assignments persist in the wizard state (`ownershipOverrides`), so they
  survive restarts and deploys.

### Check a mailbox's owner

```bash
curl -sS "$WIZARD_URL/ownership/mailboxes/25600001" -H "x-run-token: $RUN_TOKEN"
curl -sS "$WIZARD_URL/ownership/mailboxes?email=jane@bcp-mail.info" -H "x-run-token: $RUN_TOKEN"
```

The response has `slug`, `clientId` (the legacy numeric id the wizard keys
by), and `source`:

| `source` | Meaning |
|---|---|
| `override` | From the override book. `overrideSource` says who wrote it: `onboarding_api`, `mailbox_client_write` (a wizard move), … |
| `seed` | From the committed 2026-11-11 seed. |
| `campaign_inference` | No seed row and no override, but every tagged campaign the mailbox sends on has the same `sg-owner` slug. This is computed live and **never saved**. POST it if you want it pinned. |
| `none` | Unowned / pool. |

`GET` reads the wizard's last account book (refreshed by the health pass),
so a mailbox created a few minutes ago may show `inInventory: false` until
the next pass. Its override still applies as soon as it is posted.

## Automatic inference (no action needed)

A mailbox with no seed row and no override takes the owner of the campaigns
it sends on **only when** all their `sg-owner` tags agree on one slug.
It never inherits when:

- the mailbox is tagged `GENERIC`, `POC` or `CANARY` (pool and canary seats
  are assigned by min40 / POC fill, not by campaign);
- the campaigns disagree, or none of them is tagged;
- the only campaigns it sends on are shells.

Inference is not written to the override book. It follows the campaigns as
they change. If an owner must not move, register it with the POST above.

## The seed (`scripts/gen-mailbox-owner-seed.ts`)

The seed is the frozen 2026-11-11 snapshot. For a handful of new mailboxes,
use the API, not the seed.

- **Regenerate.** This only works from a `GET /email-accounts` backup taken
  **before** the space deletion, because later backups have no `client_id`.
  The script refuses to write a seed smaller than the current one.

  ```bash
  npx tsx scripts/gen-mailbox-owner-seed.ts /path/to/pre-deletion/email_accounts.json
  ```

- **Append a bulk backfill.** Use this when a batch of owners should live
  in the committed seed instead of the override book:

  ```bash
  # rows.json: [{ "id": 25600001, "from_email": "jane@bcp-mail.info", "slug": "bcp" }, ...]
  npx tsx scripts/gen-mailbox-owner-seed.ts --append rows.json
  ```

  Unknown slugs fail. A row already seeded under the same slug is a no-op.
  A row already seeded under a different slug fails, because the seed is
  never reassigned. The script rewrites `data/mailbox-owner-seed.json` and
  `src/data/mailboxOwnerSeed.ts`. Update the seed-size assertions in
  `src/lib/ownership.test.ts` in the same PR, then run
  `npm run typecheck && npm test`.
