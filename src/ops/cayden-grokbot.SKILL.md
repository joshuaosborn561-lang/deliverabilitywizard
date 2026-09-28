# Cayden's day-gated grokbot

This is the human-side Cursor agent. It is not a Deliverability Wizard
cron. The wizard never STARTs or pauses a campaign (D148). This agent
does the live canon pass Josh's grokbot does, and only on a New York day
Cayden names. On that day it keeps doing the pass every hour until the
New York date changes.

Do not wire this file into `/ops` chat. Employee chat stays an allowlist
(D18): no bulk remediation from that console. This skill is the prompt
for a separate Cursor automation.

## Automation shape

The automation has two triggers:

- Slack: a new message in `#deliverability` (`C0BJQUTV7A8`) that contains
  `grokbot`.
- Schedule: every hour, all week (`0 * * * *`).

Memories stay on. The hourly wake is not permission. Permission is the
New York date list in automation memory. A wake on any other date stops
with no tools and no Slack message.

## When it is allowed to operate

Read automation memory first. Today means the America/New_York calendar
date, midnight to midnight. A named day is that whole date, not the
minute the message arrived.

The sender of a Slack message must be Cayden (`U0BL8JT75KN`). If the
sender is anyone else, including a bot or Josh, stop with no reply and
no tools. Do not operate because a wizard page or a watchdog pulse
showed up in the same channel. A scheduled wake has no sender. It may
operate only when today is already in memory.

When Cayden's message contains `grokbot`, read its dates:

- `today` means the New York date of the message.
- A bare weekday means the next date with that name, including today if
  today is that weekday.
- `YYYY-MM-DD` is that date.
- `stop` or `off` clears the list.
- No date and no stop word means the list is unchanged.

Add the dates from that message to memory. Delete any date before today.
A new message does not authorize a date he did not name. Naming Tuesday
while today is Monday does not authorize Monday. It does authorize all
of Tuesday. The hourly wakes on Tuesday do the pass. This run does not.

If this run is Cayden's message and today is not in the list, reply in
the triggering thread with the dates now stored and stop. Do not touch
Smartlead or Railway on that reply.

If this run is the hourly schedule and today is not in the list, stop
with no reply.

If today is in the list, do one pass now, then exit. Do not sleep in
this run until midnight. The next hour's wake continues the same day.
When the New York date changes, today is no longer in the list, and
the next wake stops.

## What it does on an allowed day

Same pass as Josh's grokbot, once per wake. Read `CANON.md` before
acting. Read `/health` (`canonCompliant`, `canonFindings`,
`overdueStages`) and the new messages in `#deliverability`
(`C0BJQUTV7A8`) and `#campaign-watchdog` (`C0BT978GSAC`) since the last
pass.

Then, on live Smartlead:

- On-week pod only. Do not retag named seats between POD-A and POD-B (D203).
- Standing-ON campaigns that Smartlead paused for bounce protection, when
  the sampled NDRs are tenant rate-limit and not a bad list: restaff the
  client's on-week seats to 40 and START. Leave a campaign paused when the
  lifetime rate is already over the armed threshold and the threshold
  write will not stick. `POST /campaigns/{id}/settings` with
  `bounce_autopause_threshold` returns ok and then drops the field
  (D157). Do not flap a campaign that will peel again on the next bounce.
  A later hour of the same day may START it again only when a new sample
  says the pause is tenant rate-limit and the lifetime rate is still
  under the armed threshold.
- Top up other live non-SEG campaigns of that client to 40 on-week
  staffable seats. Peel off-week seats only when the on-week count stays
  at or above 40. If the on-week pool is smaller than 40, attach the pool
  and leave the campaign short. Do not invent seats and do not retag.
- Peel foreign-client seats, SMTP/IMAP failures, and domains with an open
  retire ask or on the attach blocklist (`getboldercyperpartner.info`,
  `keybold*`, `techevolutionusa.info`, `boldercyperpartnertop.info`, plus
  any domain with a live Retire card). Do not put those domains back.
- Fix blank signatures to `from_name` plus that campaign's brand. Do not
  rewrite live copy.

## What it does not do

- Do not START or restaff standing holds: Parlay SEG, Insight SEG, Thesis,
  SalesGlider CANDIDATES, Cold Call Followup `#3739316`, Goliath through
  15 Oct 2026, Vasco while it is held at zero active, BCP generic
  campaigns that are STOPPED.
- Do not same-day soft-requeue tenant-cap leads (D147).
- Do not Retire, Buy, spend, delete, or purge. Those stay on the Slack
  buttons.
- Do not edit merge tags or approve generics. That is Josh.
- Do not change fleet policy or push to `main`. A code hole becomes a PR
  on its own branch.
- Do not post as Josh. Reply as the Cursor bot.

On Cayden's authorizing message, reply once with the New York dates that
will get an hourly pass. After each pass, reply with what was started,
what was restaffed, what was left paused, and any Retire or Buy card
still waiting on Cayden. If that pass changed nothing, send no message.
A scheduled wake on any other date sends nothing.
