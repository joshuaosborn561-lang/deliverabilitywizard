---
name: smartlead-campaign-settings
description: "Stand up and QA a Smartlead campaign to Josh's standard for SalesGlider Growth: sender staffing floor, warmup age gate, the SmartDelivery placement test gate at 85%, sending schedule (days, hours, timezone, pacing), plain text delivery, tracking disabled, stop-on-reply, AI lead categorization, bounce auto-protection at 7%, mailbox linking, email body HTML formatting, merge tag gate, and the pre-launch QA checklist. Use whenever Josh asks to build a Smartlead campaign, set up a sequence, staff or attach inboxes to a campaign, configure sending rules or a schedule, run a pre-launch placement or seed test, upload copy, or references 'the settings we established' or 'same as my other campaigns'. Also use before setting any campaign ACTIVE. This skill covers campaign setup and pre-launch QA only... ongoing rest cycles, post-launch placement monitoring, and fleet health are the health job's scope, not this skill's. Always use this skill instead of guessing at values or leaving settings unset... these were read from Josh's live campaigns, and skipping them has silently left campaigns on Smartlead defaults before."
---

# Smartlead Campaign Settings

Everything required to stand up a SalesGlider campaign correctly. Values were
read from Josh's live campaigns via the real API, not invented.

Creating a campaign, uploading a sequence, and linking mailboxes is **not
enough**. Several separate calls must all be made explicitly or the campaign
silently runs on Smartlead defaults.

**Do not run rest, hold rebuild, top-up, or fan-out from this skill.** That is
the health job (every 15 minutes). This skill staffs a launch, then gets out
of the way.

**Do not launch canary / partial attachment.** The 85% placement gate replaced
that. Canary is another project.

---

## 1. Fleet staffing

**Floor is 50 staffable senders per campaign**, with at least **~30% Google
and ~30% Microsoft**. Staffable means all of:

- connected SMTP **and** IMAP
- not held (see holds, below)
- not resting (client off-week **or** generic on its send-clock sit)
- warmup age gate cleared

Client inboxes fill first. **Generics fill the remaining gap** up to 50. A
campaign below 50 staffable senders does not launch. Do not buy a third
client-domain set to hit the floor.

Leave these campaigns alone (do not staff, rest, or top-up): Smartlead ids
`3628940`, `3611325`, `3611268` (MSRS / HVAC / Roofers).

### Holds are not rest

A HOLD only counts if same-ESP placement actually failed (under 80%) or bounce
is over 5% with at least 50 sends. A leftover `HOLD-UNTIL-*` tag with no
same-ESP proof is **not** a reason to skip the box. Do not treat the hold pile
as the rotation system. Health rebuilds unproven HOLDs once (D44); after that,
rest is D43.

`WARMUP-GATE-EXEMPT` is a different tag. Do not strip it.

### Client rest (A/B per client)

That client's inboxes are split **evenly A/B** (stable sort by email). 2 weeks
on / 2 weeks off, New York ISO fortnights. Off-week half is **removed from
live campaigns**. Warmup stays on. Parking a box at `MESSAGE_PER_DAY=0` is not
rest — unlink it.

The cycle is run by the health job, not this skill. When standing up a
campaign, **off-week boxes are not attachable and do not count toward the 50.**

Two ways the count goes wrong:

- **A resting box left linked from a previous cycle.** It appears in the
  sender list and inflates the count while sending nothing. Unlink it.
- **A box parked at `MESSAGE_PER_DAY=0`.** Unlink it rather than leaving it
  at zero.

Count staffable senders by reading the attached list back, not by trusting
the campaign's sender count.

### Generic send clock (not the client fortnight)

Generics do **not** sit when clients sit. Each generic sends about **14 days**,
then sits about **14 days**, then is supply again. Clocks are staggered by
when that box started sending. A generic on its sit is not staffable and is
not top-up supply.

Do not drop half the spare tire the morning clients rest. Do not put a
sitting generic on a new campaign.

### Fan-out applies to on-week boxes only

Same-client fan-out: attach the client's **on-week** inboxes across that
client's ACTIVE campaigns. Do not split them by lead volume.

`link_mailboxes` is additive and idempotent. It will **not** remove a box that
has since gone off-week. Unlinking is a separate call.

Health also tops up and fans out every 15 minutes. If a mailbox you expected
is missing, or one you removed comes back, check `[health]` /
`[client-rest]` / `[generic-rest]` before attaching by hand. Manual moves that
fight the job get reverted or doubled.

Never auto-`START` a campaign someone paused or stopped by hand.

### Per-mailbox settings

Every mailbox, without exception:

| Setting | Value |
|---|---|
| Campaign emails per day | **30** (warmup mail not counted) |
| Minimum gap between emails | **10 minutes** |
| Warmup | **ON**, always, including rest weeks |
| Signature | plain `Name` newline `Brand` |

**Real throughput ceiling: 50 senders × 30/day = 1,500 campaign emails per
day.** Campaign-level `max_leads_per_day: 10000` is not a real number.

---

## 2. Warmup age gate

A mailbox may not send live campaign mail until it has served its warmup time.

| Fleet | Wait before live send |
|---|---|
| Fresh, non-prewarmed InboxKit mailboxes | **21 days** |
| crosslaunchco.com / crossscaleco.com / cleartechco.com | **none** — pre-warmed, live immediately |
| Other pool generics (InboxKit import) | **21 days** from import, not from Smartlead's warmup clock |

Pre-warmed fleets skip the 21-day wait. Do not pull them for "under-warmed"
off Smartlead's warmup start date.

**The warmup age gate runs before the placement test, not after.** Testing an
under-age fleet produces a number that means nothing.

**The gate is not waivable from chat.** An under-age box needed to reach 50 is
a signal to add a **pre-warmed or already-warmed generic**, not to start early.

---

## 3. Placement test gate

**Every campaign passes a SmartDelivery placement test before it goes live.**
This replaced launching at partial attachment (canary).

### Setup

One **recurring** SmartDelivery schedule per campaign, `every_days: 1`. Not a
fresh manual test each morning.

**Delivery quota is unlimited.** Do not ration tests. Do not skip the control
test below. (Railway may still have `TOTAL_TEST_QUOTA=120` until that var is
cleared after the health PR merges — if a create is blocked, say so; do not
invent a cap.)

### Two different bars — do not mix them

| When | Bar | Who |
|---|---|---|
| **Pre-launch** (this skill) | **85%** same-ESP, promo tab = miss | You, before ACTIVE |
| **Live pull** (health / remediation) | **80%** same-ESP | Health job after launch |

Launch at 85. After launch, health pulls a sender only if same-ESP is under
80 (or bounce is over 5% with 50 sends). Do not pull at 85. Do not launch at
80.

**Gmail Promotions tab counts as a MISS** on the launch test. Score it
honestly.

### Test the real sender set

Run the test against the **actual mailboxes that will ship**, at full
attachment, after the warmup age gate. Testing a subset and extrapolating
defeats the purpose.

### Below 85: mailboxes or copy?

Do not stall. Diagnose, then relaunch on what survives.

**Variance, not the average.** Clustered failure (40 boxes at 90, 10 at 40) is
infrastructure. Uniform failure is copy or something shared (SPF, DKIM, link
domain).

**Control test:** neutral body, same fleet, no links, no offer.

| Control | Campaign copy | Verdict | Action |
|---|---|---|---|
| High | Low | **Copy** | Link domain, spam words, tracking artifact |
| Low | Low | **Mailboxes** | Pull laggards, retest, launch on survivors |
| Low | High | Noise | Rerun both |

The link domain fails first more often than the words.
Test `book.salesglidergrowth.co` independently.

Passing this gate means infrastructure is sound at rest. Post-launch
monitoring is the health job.

---

## 4. Schedule ... `Smartlead:set_schedule`

```json
{
  "campaign_id": "<id>",
  "schedule": {
    "timezone": "America/Chicago",
    "days_of_the_week": [1, 2, 3, 4],
    "start_hour": "09:00",
    "end_hour": "18:00",
    "min_time_btw_emails": 10,
    "max_leads_per_day": 10000
  }
}
```

- Monday–Thursday only. No Friday, no weekends.
- 9:00–18:00 America/Chicago.
- `min_time_btw_emails: 10`. Do not use 13 or 20.
- `max_leads_per_day: 10000` is uncapped at campaign level. Real bound is
  **1,500/day**.
- Raw endpoint wants `max_new_leads_per_day`. `set_schedule` translates.
  `smartlead_request` does not.

## 5. General settings ... `POST /campaigns/{id}/settings`

```json
{
  "send_as_plain_text": true,
  "track_settings": ["DONT_TRACK_EMAIL_OPEN", "DONT_TRACK_LINK_CLICK"],
  "stop_lead_settings": "REPLY_TO_AN_EMAIL",
  "enable_ai_esp_matching": true,
  "follow_up_percentage": 100,
  "unsubscribe_text": ""
}
```

- `send_as_plain_text: true` is delivery-layer. Bodies are still the `<div>`
  HTML below.
- Tracking fully off.
- Reply to any step exits the sequence.
- GET echoes `DONT_EMAIL_OPEN` / `DONT_LINK_CLICK`. Posting those back 400s.
  Always write `DONT_TRACK_*`.

## 6. AI categorization and bounce protection

Use `Smartlead:update_campaign_ai_bounce_settings` (or the batch tool).

**Pass every field explicitly. Do not use `use_bcp_defaults: true`.**

| Setting | API field | Value |
|---|---|---|
| Bounce auto-pause threshold | `bounce_autopause_threshold` | `"100"` (off — D80) |
| Active AI categories | `ai_categorisation_options` | `[6, 1, 3]` |
| Restart OOO when lead returns | `out_of_office_detection_settings.autoCategorizeOOO` | `true` |
| Ignore OOO from reply % | `ignoreOOOasReply` | **`true`** |
| Re-activate OOO after delay (deprecated) | `autoReactivateOOO` | `false` |
| | `reactivateOOOwithDelay` | `null` |

`[6, 1, 3]` = Out Of Office, Interested, Not Interested.

`ignoreOOOasReply: true` on every campaign. Filter category 6 out before
quoting reply counts to a client.

Copy field names exactly (British s / American z, snake / camel).
`ai_categorization_enabled` is not a real field.

`autoCategorizeOOO` and `autoReactivateOOO` are mutually exclusive.

Smartlead bounce auto-pause stays **off** (`100`). The wizard pauses
campaigns itself after 100 sends (20% until 500, then 7%). **Do not
auto-START** a bounce pause. Health may investigate (D29) but will not
resume a bounce pause or a manual pause (D40).

## 7. Mailbox setup ... `Smartlead:link_mailboxes`

Attach **all on-week staffable client inboxes**, plus **non-sitting**
generics to reach 50 with ~30% each ESP.

Every mailbox needs a signature. Before linking:

```
signature = f"{from_name}\n{client_company_name}"
```

`from_name` is on the mailbox. Company comes from the Smartlead client
`logo` (e.g. "Vasco Warranty") or the name Josh gave. Write with
`update_email_account` **before** `link_mailboxes`.

If `from_name` is missing or not a person, flag Josh. Do not guess.

**Set `client_id` on every mailbox in the pool**, not just the campaign.
Read one back after a bulk reassignment. SalesGlider-style boxes with no
`client_id` still rest if the campaign has a client — assign the client
anyway so fan-out and signatures work.

---

## Email body formatting

One sentence per `<div>`, separated by `<div><br></div>`. Never a bare
`<br>` between divs.

```html
<div>{Hey|Hi} {{first_name}},</div><div><br></div><div>I've got a {couple|pair of} {{Local_Sports_Team}} tickets {on me|yours if you want them}.</div><div><br></div><div>%signature%</div>
```

`%signature%` is its own final div. PS after signature, each on its own line.

Use the native `variants` array on `upload_sequence`. Never concatenate
whole bodies with `|` as manual spintax.

Variants split evenly. A segment-gated variant needs a **separate campaign**.

### Merge tags: the hard gate

**System fields:** `email`, `first_name`, `last_name`, `company_name`,
`phone_number`, `website`, `location`, `linkedin_profile`, `company_url`.

**Everything else is custom**, including `job_title`. Names are stored
exactly as typed. `{{gift}}` will not match `Gift`.

Read keys from `list_campaign_leads` → `custom_fields`. Never assume.

Two bugs, two checks: wrong tag name (`{{company}}`, `{{firstname}}`) vs
field absent on leads. Sample several offsets, not just 0.

```
GET /campaigns/{id}/sequences                     -> sequences.json
Smartlead:list_campaign_leads (several offsets)   -> leads.json
python3 scripts/check_merge_tags.py sequences.json leads.json
```

The script lives in this repo (`scripts/check_merge_tags.py`). Exit 1 means
do not upload. Never hand-transcribe JSON. If the script is missing, do the
same comparison from the two files: every `{{tag}}` must be a system field
or a `custom_fields` key present on enough sampled leads — not just offset 0.

---

## Import rules

- `import_leads` updates custom fields on existing leads rather than
  duplicating.
- Chunk 200–220 leads per call.
- Never hand-transcribe JSON. Verify `upload_count` equals submitted.
- `upload_count` and `already_added_to_campaign` overlap; they do not sum.
- Never concurrent imports against one campaign from two sessions.

---

## Pre-launch QA gate

Nothing goes ACTIVE until every line passes.

**Infrastructure**

1. **50 or more staffable senders**, ~30% Google and ~30% Microsoft, after
   excluding held (proven-weak only), client off-week rest, and generic sit.
2. **Zero resting mailboxes attached.** Read back. No `MESSAGE_PER_DAY=0`.
3. **Every attached mailbox clears warmup** (21 days from InboxKit import;
   pre-warmed fleets waived).
4. **Recurring SmartDelivery schedule** at `every_days: 1`.
5. **Launch placement ≥85% same-ESP, promo = miss**, full real sender set,
   after warmup. Failed test is diagnosed and relaunched on survivors, not
   waived.
6. Signatures set to Name / **this campaign's** brand; 30/day, 10 minute gap, warmup on. A leftover brand from another client is a hard fail.

**Campaign**

7. Merge tag gate passed (`check_merge_tags.py` exit 0, multi-offset sample).
8. `%signature%` on every variant and every step. No other client's brand hardcoded in the body.
9. `client_id` on the **campaign** and on the mailboxes.
10. Suppression and domain block list applied, scoped to that `client_id`.
11. Cross-campaign dedupe verified against full exports.
12. Schedule applied and verified by read-back.
13. AI categorization on, `ignoreOOOasReply: true`, bounce threshold `"7"`.
14. No off-ICP leads (retail, student orgs, school districts).
15. Every proof claim in the copy is client-approved.

**Suppression is a hard gate.** Never load a campaign before the client's
existing-customer list is applied. An AP/billing export is not a domain
block list — resolve company names to domains yourself.

---

## Verifying settings actually landed

`set_schedule` and `update_campaign_settings` both return `{"ok": true}`
with no echo. `GET /campaigns/{campaign_id}` and check
`send_as_plain_text`, `min_time_btwn_emails`, `stop_lead_settings`, and
`scheduler_cron_value`.

A success response is not verification. Read it back.

## Source of truth

Schedule and general settings: campaign 3479011 (Parlay Sports Offer), live
API. AI / bounce fields: Josh, after the MCP tools landed.

Fleet staffing, rest, warmup, and the two placement bars: D43 / D44 / D46
(Aug 2026). Client A/B rest and the generic 14-day send clock are the
rotation system. HOLDs are only for proven-weak senders. Canary is out of
this loop. Placement-test quota is unlimited (D45).

Health owns rest execution, hold rebuild, top-up, fan-out, live 80% / 5%
pulls, and pause handling. Do not duplicate those here.

## Isolation (D48)

Standing per-pod control tests (fixed control email) answer inboxes vs copy.
If copy, the wizard starts a same-day one-variable teardown from the
low-rep isolation domain — tests are unlimited, do not wait for seed
approval. **Recommend the change. Do not edit the live sequence.** Isolation
mailboxes never attach to a campaign. A confirmed trigger is a pre-send
lint warning, not a launch block.

If Josh changes a standard, **update this skill** rather than relying on a
future session remembering the old number.
