# Deliverability Wizard — instability audit

Audit only. No code changes. Snapshot taken **2026-10-15 ~20:18 UTC**
against production `GET /health` on `main@cd89be1` (D272 / #321) plus
`#deliverability` Slack, PRs **#316 #318 #319 #320 #321**, `CANON.md`
(D272), and the repo as of that commit.

Josh’s hypothesis is right: **the wizard is too bloated for one Node
process**, and yield-patches cannot keep the event loop honest at this
fleet size. The five consecutive freeze PRs treated symptoms. D272 is
already live and the machine is still overlapping itself, timing out,
and leaving 0%-inbox campaigns without isolation.

---

## Verdict

The core job (40/POD, isolation + ESP mix, warmup then peel, canaries,
copy QA, lapsed-seat delete, spend to Josh/Cayden) is a **small
number of rules**. The running system is a **62k-line single process**
with **35 watchdog stages, 14 crons, ~40 `/run` modes, a ~110MB JSON
file, and O(campaigns × mailboxes) walks** on every sitting.

At production scale (~360 campaign-check rows, ~1,300–1,425
mailboxes, ~122 pool seats, 229 tested campaigns) that shape does
four things at once:

1. Pins the Node event loop long enough for the freeze watchdog to
   `process.exit(1)` (3× ≥3s stalls in 2 minutes).
2. Burns Smartlead’s **200 req/min** budget (limiter at 150/min,
   concurrency 2) so later stages 429 or hit the **10-minute**
   `raceStep` wall.
3. Restarts Railway (`restartPolicyType = ALWAYS`) before
   `state.json` finishes writing, so findings and prunes come back
   stale.
4. Starves the isolation tail of the 15-minute health chain, so the
   30-minute “ugly → isolate” SLA is fiction.

**D272 does not prove the freeze is over.** Live `/health` after that
deploy still has health and monitor in flight together, 14 overdue
stages, isolation-branch last-ok **~3.5 hours** stale, and the same
five 0% campaigns with no isolation run.

---

## Live production snapshot (this audit)

`GET https://deliverabilitywizard-production.up.railway.app/health`

| Field | Value |
|---|---|
| Deploy | `main@cd89be1` (D272, #321) |
| `canonCompliant` | **false** |
| Campaigns on the board | **31 yes / 43 no** (74 living checks) |
| Open findings | `esp_mix=35`, `understaffed=30`, `generic_idle=14`, `below_launch_bar=4`, `missing_signature_tag=2` |
| `inFlight.health` | `campaign-check-first` since 20:15:00Z |
| `inFlight.monitor` | **`campaign-audit` since 20:06:52Z** (started as health ended; still running when the next health sitting began) |
| Limiter | `exclusiveHealth=true`, `inflight=0`, `maxPerMin=150` |
| Mutation queue | depth **2**, oldest wait **165s** |
| Isolation | scored 79, **ugly 5**, all `uglyWithoutIsolation` |
| Isolation-branch lastOk | **2026-10-15T16:50:44Z**, 2× `timeout after 10m` |
| Campaign-audit lastOk | **2026-10-15T01:16:09Z**, 3× `timeout after 10m` (~19h stale) |
| Test-reconcile lastOk | **2026-10-15T08:12:03Z**, 3× `timeout after 10m` |
| Campaign-check-first last error | `timeout after 20m` |
| Warmup-gate last error | `timeout after 10m` |

Five campaigns at **0% canary-copy inbox** with no covering isolation
run (live `/health.placementIsolation.uglyWithoutIsolation`):

| Campaign | First Slack page | Still ugly at |
|---|---|---|
| #3847940 SG MSP Engagers… Marketing Lane | 2026-10-14 10:25 CDT | 2026-10-15 15:06 CDT + live `/health` |
| #3921850 BCP Healthcare IT (AirPods) | 2026-10-14 10:25 CDT | same |
| #3921852 BCP Logistics IT (AirPods) | (same incident) | same |
| #3921869 BCP Logistics IT (AirPods) SEG | (same incident) | same |
| #4037540 EMCOR A Property \| Scope \| SEG | (same incident) | same |

That is **~29–31 hours** of 0% inbox without isolation, against a
canon target of **one 15-minute health cycle** (D159) and Josh’s
**30-minute** SLA.

`#deliverability` posted a stage-overdue page **about every hour on
Oct 15** (00:02, 01:00, 02:02, 03:01, 04:01, 05:02, 05:54, 06:52,
08:03, 08:51, 09:48, 10:51, 11:51, 13:48, 15:06 CDT). Isolation-branch
and campaign-audit appear on most of them.

---

## (a) Root causes of the instability

### A1. One process owns HTTP, CPU walks, JSON, and Smartlead

`src/index.ts` is **3,677 lines**. It is the Express server, all 14
crons, freeze watchdog, Slack interactivity, `/health`, `/ops`, and
the stage runner. Node has **one event loop**. A 15–50s
`JSON.parse` / stringify / `indexAccountsByCampaign` walk delays
`setInterval` (the freeze watchdog), `/health`, Slack taps, and
in-flight HTTP.

Railway `healthcheckTimeout` is **30s**. A blocked loop that lasts
longer than that 502s `/health` **without exiting**. The watchdog
must actually `process.exit(1)` for ALWAYS-restart to help (D265).
Until it does, the process is a zombie that still holds cron locks.

### A2. Fleet size × nested walks exceeds the 10-minute stage budget

Documented production sizes from D250–D272:

| Walk | Size | Observed stall |
|---|---|---|
| min40 campaign × mailbox | ~1,000 seats × 366 campaigns | freeze after hold-enforcement (D250) |
| min40 pool pick | 800-row pool, 15–36s per attempt | D252 |
| staff loops | **434 × 1,425** | 20–120s pin (D267 / 2026-10-14) |
| short-campaign fill | **416 × 1,338** | D252/D272 test budget |
| `indexAccountsByCampaign` | same book | **14.9s** (D272, 2026-10-15 14:00 CT) |
| `json.stringify:yielding` | `/data/state.json` | **18.7s + 10.9s** overlapping health+audit |
| health-pass wall clock | full chain | **~21.2 min** after D269 (longer than the 15m cadence) |
| inventory page | 100 accounts × embedded `campaigns[]` | **10–50MB**, 16–50s parse before stream/slim |

Default `raceStep` is **10 minutes** (`src/lib/stepTimeout.ts`).
Inventory 5m; campaign-check-first / scan-backfill 20m. A sitting
that spends 21 minutes on health **starts the next 15-minute cron
while the previous pass is still live**. Later stages (isolation-
branch is near the tail) never run, then `skipIfFreshMs` treats a
prefix lastOk as “still inside the cycle.”

### A3. `/data/state.json` is the database, checkpoint, and freeze fuel

`src/state/store.ts` is **3,064 lines**. One `AppState` blob holds
campaign checks, isolation runs/scores/suspects, generic seats, pool
mailboxes, bounce ledgers, TERRL holds, Slack stamps, ops audit, and
more.

- D257: dump grew to **~110MB**; compact stringify froze the loop
  for seconds; load parse much longer; one checkpoint **~100s**,
  once **12+ minutes**.
- Freeze-kill flushes **only** `state.json.stamps.json` (`saveHot`),
  never the full dump (D249/D265).
- Isolation prune and ghost-pool drops lived in RAM; after restart
  the stale dump **resurrected 151 isolation rows** (D262/D267) and
  **~422 ghost pool seats** (D269) every cycle.
- Sidecar overlay **drops gone ids only** — it does not replace
  living score/suspect maps (`overlayIsolationPrune`). A prune that
  did not land in `goneIds` before kill comes back.
- `save()` is coalesced but still walks the whole graph on the
  serving thread (D271/D272 stream to disk; D272 `setTimeout(0)`
  every ~8ms). That is still **CPU on the HTTP process**.

Findings after restart are therefore **whatever last completed dump
survived**, overlaid with lastOk stamps that can look healthy.

### A4. Smartlead payloads and the 200/min ceiling

Every Smartlead **and** SmartDelivery call shares one limiter:
concurrency **2**, min gap 150ms, **150/min** (account cap 200/min)
(D257/D267/D270).

- `GET /email-accounts?fetch_campaigns=true&limit=100` embeds a
  full `campaigns[]` per mailbox. A 100-row page is tens of MB.
- D269 slims to `campaign_ids` off-thread; D270 streams the body to
  disk in 64KB slices. The fetch still **is** the health sitting’s
  first 1–5 minutes.
- Health takes an exclusive limiter lane (D270). Monitor / test-
  reconcile / campaign-audit **wait**. A 21-minute health pass
  means the 6-hour monitor either skips (`health-running`) or, if
  it started first, **keeps walking while the next health starts**.
- Live snapshot: **health exclusive + monitor campaign-audit
  in-flight together**. D270 only skips a *new* monitor tick. D272
  pauses campaign-audit CPU while health is live — a cooperative
  `setTimeout(25ms)` spin, not a process boundary. Isolation-rig
  last error is still **HTTP 429**.

Mutation queue jobs time out at **6 minutes**. Live oldest wait
**165s** with depth 2 — writes are already backing up behind the
walks.

### A5. Loop overlap is structural, not accidental

Default crons (all in **one** process):

| Cron | Default | Lock max |
|---|---|---|
| Health (15+ stages) | `*/15 * * * *` | 45 min |
| Canon-ops (5 stages) | `*/30` Chicago weekdays 08–18 | 30 min |
| Bounce | `*/10 * * * *` | (in-flight flag) |
| Campaign-check hourly | `0 * * * *` | skips if health live |
| Pool provision | `*/30 * * * *` | — |
| Monitor (15+ stages) | `0 */6 * * *` | **3 hours** |
| Scan | `0 9 * * 1,4` | — |
| DeliveryWatch | `0 13 * * *` NY | — |
| EOD briefs | `0 12` + `30 16` NY | — |
| TERRL EOD | `30 17` Chicago | — |
| Spend digest | `0 8 * * 1-5` Chicago | — |
| InboxKit license | `16 8 * * 1-5` Chicago | — |
| Reconnect extra | `0 3 * * *` NY | (also on health) |
| Boot | canary attach at 90s | — |

Overlap math on a weekday:

- Health wants the board **every 15 minutes** and often runs
  **longer than 15 minutes**.
- Canon-ops wants it **every 30 minutes** and skips/retries if
  health is live (D267) — so min40/cleanup **miss the window**
  during a freeze-restart day.
- Monitor lock is **3 hours**. A sitting stuck in campaign-audit
  occupies the limiter and CPU across **twelve** health crons.
- Bounce every 10 minutes still does Smartlead reads during the
  exclusive-health window (bounce is not on the health lane).
- Freeze restart resets **all** cron cycles (D122). A kill at
  minute 14 of a health pass throws away the tail (isolation)
  and the next tick is ~15 minutes later.

The freeze watchdog exits on **3 stalls ≥3s in 2 minutes**. At this
fleet size, **one inventory parse + one stringify + one campaign
index** is already three stalls. Thresholds were **not** widened
(D271/D272). So every remaining main-thread walk is a restart.

### A6. Why #316–#321 failed to stop it

| PR | Decision | What it fixed | What it left |
|---|---|---|---|
| #316 | D267 | Yield staff loops; isolation prune sidecar; 7m inner budget; 150/min; canon-ops retry | Ghost-pool RAM-only; fat `fetch_campaigns` JSON.parse on the loop |
| #318 | D269 | Persist 422 ghost drops; slim pages off-thread | `response.text()` of 10–50MB still 16–25s; leftover resume hid inventory; monitor raced health |
| #319 | D270 | Stream OK bodies; exclusive health lane; don’t skip stale inventory | Buffer/JSON.parse of other lists; stringify joined the blob; unnamed stalls |
| #320 | D271 | Name stalls; stringify-to-file; load off-thread; yield index every 32 seats | `setImmediate` chain **starved `setInterval`**; index didn’t yield inner campaign ids; campaign-audit overlapped health |
| #321 | D272 | Time-slice stringify (`setTimeout(0)` ~8ms); index inner ids; pause audit CPU | **Unproven at audit time — and live `/health` still overlaps + times out** |

Each PR added **hundreds of lines of scheduling code** (yields,
sidecars, lanes, attribution, time-slicers) **on top of the same
single process**. Net: **#316 +619…+1026 lines** of reliability
machinery, zero reduction in work per sitting. The freeze watchdog
then became a **restart loop** instead of a backstop.

Josh: “a lot needs to be stripped out.” The patches did the
opposite.

### A7. Isolation 0% for 30 hours is the same root, not a separate bug

Canon: score → suspect → evaluate on the **15-minute health sweep**
(D159), isolate any 0%-inbox campaign within ~30 minutes.

What actually happens:

1. Isolation-branch is **near the tail** of `runHealth` (after rest,
   one-client, campaign-check-first, warmup-gate, campaign-health,
   scan-backfill, pod-cover, reconnect, mailbox-gap). A 10–21 minute
   prefix **never reaches it**.
2. Outer timeout **10m**, inner budget **7m**, **4** provider-split
   pulls and **3** evaluates per cycle (D267). Five ugly campaigns
   cannot all evaluate in one sitting even when the stage starts.
3. Copy-canary `testId` attach is **boot + 6h monitor**, not the
   15-minute chain. All five live ugly rows are **canary-copy**.
4. `skipIfFreshMs` can skip the whole stage because a previous
   *partial* lastOk is still inside 15 minutes.
5. Freeze restart + RAM prune: scores/suspects resurrect without a
   covering run; `/health` shows uglyWithoutIsolation; Slack pages
   “on-ramp should queue it”; the next sitting times out again.
6. D165: **new** queue is ACTIVE-only. PAUSED ugliness never enters.

#3847940 / #3921850 were first paged **2026-10-14 10:25 CDT** and
were still on `/health` **~29 hours later**. That is ~116 missed
15-minute cycles, not a cap delay.

---

## (b) Inventory — every loop, stage, endpoint, Slack flow

Classification against Josh’s seven core jobs:

1. 40 senders / POD (TechEvo 30), static named A/B; generics only to the floor
2. Isolation + ESP mix (client-exclusive seats, ≥33% minority ESP)
3. Warmup gate, then peel generics → named once named seats are warm
4. Canaries: warmed test senders, unwarmed test copy; 0% inbox isolated ≤30m; word hunt on copy fail
5. Copy / signature / dynamic-field QA on new copy and new leads
6. Delete lapsed seats on cancel date
7. Spend approvals to Josh or Cayden

Campaign status, pause, and leads belong to other systems.

**Runtime cost** is wall-clock / Smartlead pressure observed in
production or encoded in CANON, not a lab benchmark.

### Loops (crons)

| Loop | Cadence | LOC (orch + services) | Runtime cost | Mark |
|---|---|---|---|---|
| **Canon sweep / health** | 15 min | `index.ts` `runHealth` ~310 + inventory 222 + rest/one-client/check/warmup/health/gap/isolation-branch | **21 min observed**; inventory 5m budget; often >15m | **CORE** (too many stages inside) |
| **Canon-ops** | 30 min Chicago weekday | min40 1,574 + cleanup 209 + hold 124 + type-tags 147 + powergryd 226 | 10m min40 budget; skips when health live | **CORE** (min40 + cleanup + hold); powergryd watch **NICE** |
| **Bounce** | 10 min | bounce 1,085 + resurrection 697 | Burst classify + 20 lead-reads/tick | **CORE** (classify + Slack; never pause) |
| **Campaign-check hourly** | hourly | campaignCheck 1,663 | Yields to health; 8m inspect walk | **CORE** (but first-check already on health) |
| **Monitor** | 6 h | ~15 stages, lock 3h | **times out**; campaign-audit lastOk 19h stale | **CUT most**; keep placement pull + canary attach as workers |
| **Scan** | Mon/Thu 09:00 | campaignScanner 593 | Placement backfill; also on health when `no_placement_test` | **CORE** (as backfill, not a second loop) |
| **Pool provision** | 30 min | 1,135 | Spend-gated buy pipeline | **NICE** (keep behind `/approvals`) |
| **DeliveryWatch** | daily 13:00 NY | 144 | Duplicate evaluate; CANON says on-ramp is health | **CUT** |
| **EOD brief** | 12:00 + 16:30 NY | clientDayBrief 344 | Read-only Slack | **NICE** |
| **Needs-you digest** | 08:00 CT weekday | spendDigest 89 + lib 254 | Does not spend | **CORE** (job 7) |
| **InboxKit license** | 08:16 CT weekday | 208 + lib 452 | Delete lapsed | **CORE** (job 6) |
| **TERRL EOD** | 17:30 CT | terlHold 619 | Digest only | **NICE** |
| **Reconnect extra** | 03:00 NY | 330 | Duplicate of health reconnect | **CUT** (keep health path) |
| **Boot canary attach** | 90s after listen | copyCanary 935 + buy 980 | Only Smartlead work at boot (D122) | **CORE** |

### Stages (`STAGE_OVERDUE_WINDOWS_MS` — 47 names)

Health 15m window unless noted.

| Stage | Loop | ~LOC | Runtime | Mark |
|---|---|---|---|---|
| health-pass | health umbrella | — | 21 min observed | CORE (keep as sitting stamp) |
| inventory | health | 222 | 5m budget; 10–50MB pages; 40–50s parse historically | **CORE** |
| client-rest | health | 666 | 10m timeout in prod (D270) | **CORE** (job 1 A/B) |
| generic-rest | health | 291 | Instant no-op (`enableGenericSendRest=false`, D221) | **CUT / DEAD** |
| client-tag | health | 131 | Cheap | NICE (one-client covers ownership) |
| one-client | health | 519 | Peel foreign memberships | **CORE** (job 2 exclusivity) |
| qa-unpause | health | 252 | START PAUSED POC after sig QA | **CUT** (status belongs elsewhere; D40 never auto-START except allo-caller) |
| campaign-check-first | health | 1,663 | **20m timeout in prod**; 8m inspect + 90s enrich | **CORE** (job 5) — must not sit in the same 10m chain as isolation |
| warmup-gate | health | 567 | **10m timeout in prod** | **CORE** (job 3) |
| campaign-health | health | 448 + topUp 1,103 + fanOut 613 | **10m timeout**; orchestrates top-up + fan-out + copy-canary attach | **CORE** but **overlaps min40** |
| scan-backfill | health, event | 593 | 20m; only if `no_placement_test` | **CORE** (job 4 instrumentation) |
| pod-cover | health tick | podControls 655 | Idle most passes; hourly throttle | NICE (known-good coverage) |
| reconnect | health | 330 | SMTP/IMAP re-auth | NICE |
| mailbox-gap | health | 405 | Caps + 10m gap | **CORE** (send hygiene) |
| mailbox-settings-full | health 6h | same 405 | Full sig/warmup converge | NICE (gap already every 15m) |
| isolation-branch | health tail | 876 | **10m timeout, 7m inner, 4/3 caps**; lastOk 3.5h stale | **CORE** (job 4) — **must be its own worker** |
| isolation-buy-resume | health + monitor | isolationBuy 788 | Retry post-pull buy | CORE (job 7 path) |
| generic-pool-canon | health, not watchdog | 201 | Table validate | CORE findings; cheap |
| hold-enforcement | canon-ops | 124 | Only live PAUSE besides shells | CORE (standing holds) |
| min40-topup | canon-ops | **1,574** | 10m; 416×1338 / 434×1425 | **CORE** (jobs 1+3 peel) |
| powergryd-watch | canon-ops | 226 | Alert only | NICE |
| generic-cleanup | canon-ops | 209 + surplus 235 | Same return as min40 | CORE (merge into min40) |
| mailbox-type-tags | canon-ops | 147 | type:google/m365/azure | NICE |
| terl-eod | daily | — | Slack digest | NICE |
| spend-digest | daily | — | Job 7 | CORE |
| inboxkit-license | daily | — | Job 6 | CORE |
| pod-tags | monitor first | 250 | Decoration; weekend idle | NICE |
| monitor-results | monitor | 416 | Placement pulls; queues suspects | **CORE** as isolation input, not 6h dump |
| warmup-gate-monitor | monitor | 567 again | Duplicate of health gate (D247 key split) | **CUT** |
| test-reconcile | monitor | 216 | **10m timeout since Oct 13 21:25Z** (6 straight failures) | NICE |
| dns-audit | monitor | 248 | Read-only; 429 in prod | NICE / logs only (D71) |
| campaign-audit | monitor | 441 | **Read-only duplicate of campaign-check**; 10m timeout; lastOk 19h | **CUT** |
| lead-runout | monitor | 141 | Log only; leads belong elsewhere | **CUT** |
| sending-infra | monitor | 127 | Census from reports | NICE |
| pod-controls | monitor | 655 | Known-good tests | NICE |
| domain-client-audit | monitor | 433 | Confident GENERIC tags + advisories | NICE |
| domain-lifecycle | monitor | 176 | Retire/cover | CORE (job 7) |
| canary-buy-resume | monitor | 980 | Fleet buy | CORE |
| canary-adopt | monitor | same | **10m timeout** | CORE |
| isolation-rig | monitor | 213 | **HTTP 429**; lastOk ~16h | CORE (job 4 hunt) |
| copy-isolation | monitor | 395 | Word hunt | CORE (job 4) |

**Line-count rollup (production TS, excluding tests):** **62,266**.
Tests: **62,522** (`canon.test.ts` alone **17,477**). Services: **53
files**. `index.ts` + `store.ts` + `config.ts` + isolation state =
**7,825** in four files.

### HTTP endpoints

| Endpoint | Auth | Mark |
|---|---|---|
| `GET /health` | public | **CORE** |
| `GET /status` | RUN_TOKEN | dumps **entire AppState** — **CUT** or slim (this is a freeze vector) |
| `GET /approvals` | RUN_TOKEN | NICE (ops owns decisions) |
| `POST /run?mode=…` | RUN_TOKEN | **~40 modes** — keep health, min40, isolation, warmup, inboxkit, spend-digest, mailbox-gap; cut the rest from the hot path |
| `/slack/install`, `/slack/oauth` | — | CORE if Slack stays |
| `GET/POST /slack/action` | signed links | CORE (job 7 + copy tap) |
| Slack interactivity POST | signing secret | CORE (`dlv_*` one-taps) |
| `/ops/*` | session | **NICE** — ~2,000 lines UI (`public/ops`) + 612 router; `OPS_UI_ENABLED` default **false** |

### Slack flows

| Flow | Channel | Mark |
|---|---|---|
| Burned domain Retire/Buy | `#deliverability` | **CORE** (job 7) |
| Copy swap Use suggested / Write own | `#deliverability` | **CORE** (job 4) |
| Needs-you 08:00 CT lumped Approve | `#deliverability` | **CORE** (job 7) |
| Lapsed-seat one-liner after delete | `#deliverability` | **CORE** (job 6) |
| Stage overdue / CANON-miss / 0% inbox | log channel or thread (D248) | **CORE** pager |
| TERRL EOD, short-staffed, canary registered | log / `#deliverability` | NICE |
| Bounce burst receipt | log | CORE |
| `#campaign-watchdog` 5.1.8 tenant page | watchdog | NICE |
| Allow-generics card | — | **DEAD** (D268) |
| Signature *ask* buttons | — | **DEAD** (D97; auto-write) |

---

## (c) Dead or duplicate features

### Dead (code or state still present; CANON retired the behaviour)

| Item | Evidence | Action |
|---|---|---|
| **generic-rest / GenericSendRest** | D221 retired send-clock; flag default **false**; health still `stage("generic-rest")` | Delete stage + service |
| **activeSwaps / recovery-swap** | D130 deleted machinery; store CRUD only; guards forbid revival | Delete state + API |
| **heldInboxes** | No service readers | Drain + delete |
| **bouncePausedCampaigns writes** | D148 never pauses; `markBouncePaused` unused in services; drain-only | Delete after retention empty |
| **Allow-generics Slack** | D268; `genericBackfillApprovals` leftover | Delete card/store; keep floor helper |
| **SendVolume scan types** | `sendVolume.ts` 67 lines; cron drives `clientDayBrief` only | Merge helpers into brief |
| **oldClientTeardown** | D144 deleted | already gone |
| **D178 Insight in-body close** | D255 retired | already gone |
| **bounce_autopause_threshold writes** | D157 UI-only | already gone |

### Duplicate writers (same Smartlead attach/detach)

These all call `addEmailAccountsToCampaign` / `removeEmailAccountsFromCampaign` with the staffable-floor guard:

- `clientRest` (off-week unlink / on-week restore)
- `oneClientMembership` (foreign peel)
- `campaignTopUp` (15m health fill)
- `min40TopUp` (30m floor fill + named-warm peel)
- `genericCleanup` (same peel as min40)
- `clientFanOut` (every ACTIVE of the client)
- `warmupGate` (under-21 pull)
- `copyCanary.attach` (shells only)

**`campaignTopUp` (1,103) + `min40TopUp` (1,574) is the expensive duplicate.** Canon: 15m pass does rest + one-client + fan-out; **canon-ops min40 is the generic floor**. Health top-up still fills shorts. Two O(n×m) attach brains per hour.

**`warmup-gate` + `warmup-gate-monitor`:** same pull, two cadences, two lastOk keys (D247) so they cannot invert each other — that is a symptom of one process.

**`campaignCheck` (1,663, writes findings) vs `campaignAudit` (441, read-only):** `/health` uses check. Audit is a 6h CPU walk that **times out** and duplicates understaffed / test-cover. Cut audit.

**`resultMonitor` + `isolationBranch` + `deliveryWatch`:** three entries into `markCopySuspect` / `evaluate`. Canon on-ramp is isolation-branch. DeliveryWatch is explicitly “not the daily DeliveryWatch.” Monitor should only pull scores.

**`qa-unpause`:** STARTs PAUSED POC campaigns. Josh: campaign status belongs to other systems. Conflicts with D40 in spirit even with the D77/D106 exceptions.

### Nice-to-have that currently sits on the critical path

bugRemediator (283, needs `CURSOR_API_KEY`), `/ops` + Cursor chat, powerGrydWatch, dns-audit, lead-runout, sending-infra, mailbox-type-tags, pod-tags decoration, reconnect extra cron, GET `/status` full dump.

**Guards:** `src/guards/canon.test.ts` is **17k lines** asserting `index.ts` still contains `stage("…")` strings. That file **prevents stripping**. Any cut list needs Josh to supersede the matching decisions in the same PR (D127) or the suite fails on purpose.

---

## (d) Proposed stripped-down target architecture

Keep the **seven jobs**. Drop everything that is not those jobs, Slack
for (7), and `/health`.

```
                    ┌─────────────┐
                    │  Postgres   │  (or SQLite WAL if one writer)
                    │  + object   │  placement payloads / fat JSON
                    └──────┬──────┘
           ┌───────────────┼────────────────┐
           ▼               ▼                ▼
     ┌──────────┐   ┌─────────────┐   ┌─────────────┐
     │ API /    │   │ Staff worker│   │ Isolation   │
     │ Slack    │   │ (jobs 1,2,3,│   │ worker      │
     │ /health  │   │  5,6)       │   │ (job 4)     │
     │ job 7    │   │ 15m + 30m   │   │ own 15m     │
     └──────────┘   └─────────────┘   └─────────────┘
           ▲               │                │
           │               ▼                ▼
           │        Smartlead limiter  SmartDelivery
           │        (shared Redis or   (own budget)
           │         per-worker cap)
           └──────── HTTP stays up if staff or isolation dies
```

### Process split (the actual fix)

| Process | Owns | Must not own |
|---|---|---|
| **api** | Express, `/health`, Slack taps, spend execute, InboxKit delete trigger | Inventory walks, stringify, placement pulls |
| **staff** | Inventory book, rest, one-client, min40+peel, warmup-gate, campaign-check, mailbox-gap, license sweep | Isolation evaluate, SmartDelivery report pagination, campaign-audit |
| **isolation** | Score ugly ACTIVE campaigns, queue, evaluate, copy-canary attach, word hunt, known-good | min40, rest, fan-out |

If **staff** freeze-kills, **isolation still runs** (Josh’s QA
requirement). `/health` is served by **api** from Postgres, so a
stuck worker cannot 502 the Railway healthcheck.

### Storage

Replace `/data/state.json` with:

- **Postgres** (Railway plugin): campaigns, findings, generic_seats,
  isolation_runs/suspects/scores, stage_stamps, spend, holds,
  inboxkit_seat_ends. Row updates, not a 110MB rewrite.
- **Hot stamps** stay a tiny sidecar **or** a `stage_health` table
  with `UPDATE … last_ok_at` per stage (milliseconds, crash-safe).
- Fat Smartlead pages: **never persist**. Slim to `campaign_ids` in
  the worker, keep the book in memory for the sitting, drop it.

SQLite WAL is acceptable **only** if api is the single writer and
workers talk through a queue. Postgres is the safer Railway fit.

### Queue

A small job queue (Postgres `SKIP LOCKED` or Redis):

- `inventory.fetch` (serial, one at a time)
- `staff.health` (15m)
- `staff.min40` (30m weekday)
- `isolation.tick` (15m, **independent**)
- `bounce.tick` (10m)
- `inboxkit.sweep` (weekday)
- `spend.execute` (from Slack, on api)

Jobs time out independently. A 10-minute isolation tick does not
abort min40. Overlap becomes “two processes, two limiters” not
“one loop, two 50s JSON.parse.”

### Smartlead

- **One inventory fetch per 15m**, published to Postgres
  `inventory_accounts` / `inventory_campaigns` (slim rows).
- Staff and isolation **read the book**, never refetch
  `fetch_campaigns`.
- Isolation worker gets its **own** 50–80 req/min slice of the 200
  cap (or runs in the 10 minutes staff is idle). Do not share
  concurrency-2 with min40.
- Stop `GET /email-accounts?fetch_campaigns=true` as a fat page:
  campaigns list + account list + membership ids only.

### What the core codebase should look like

Target **~12–18k production lines** (down from 62k), roughly:

| Module | Jobs | ~LOC |
|---|---|---|
| inventory slim + book | all | 400 |
| rest + one-client + min40/peel | 1,2,3 | 2,500 |
| warmup-gate | 3 | 400 |
| campaign-check (sig, step-2, merge-tag) | 5 | 800 |
| isolation tick + copy-canary + hunt | 4 | 2,000 |
| bounce classify + Slack | (support) | 400 |
| inboxkit sweep | 6 | 300 |
| spend + Slack buttons | 7 | 800 |
| api /health | — | 400 |
| mailbox-gap | hygiene | 200 |

Everything else from the inventory table marked CUT/DEAD/NICE leaves
the hot path. NICE items (EOD brief, DNS, pool provisioner) can stay
as **optional workers** off the 15-minute clock.

### Hosting cost (Railway)

Current (`railway.toml`): **1 replica**, `us-west2`, volume for
`/data`, `restartPolicyType=ALWAYS`, Node 22.

| Shape | Railway | Delta vs today |
|---|---|---|
| Today | 1 Node + volume | baseline (typically tens of USD/mo usage + Pro) |
| Target | **3 Node services** (api small, staff, isolation) + **Postgres** (~1 GB) | **about +$25–50/mo** (second/third replica RAM + Postgres). Isolation RAM can be smaller than staff. Drop the 110MB volume once Postgres is primary (**volume −$**). |
| Cheap bridge | 2 Node (api+isolation combined, staff separate) + Postgres | **+$15–30/mo**; still keeps QA up if staff dies |
| Do not | 1 process + bigger instance | CPU walks still block `/health` and Slack |

No Porkbun/InboxKit spend change. No Smartlead plan change. The
cost is **hosting isolation as its own replica**, which is the
redundancy Josh asked for.

---

## (e) Phased migration (production-safe)

Do **not** merge another yield-only freeze PR onto `main` while this
plan is open. Each `main` merge **restarts cron** (D122) and has been
the restart loop.

### Phase 0 — Stop the bleeding (hours, no behaviour change)

1. **Do not merge** further D273-style stringify patches until Phase 1
   isolation worker exists.
2. Confirm D272 for **2 hours with zero freeze-watchdog exits**
   (D272’s own success metric). At audit time it had **not**.
3. If freezes continue: Railway **replica restart is not a fix**.
   Temporarily **disable monitor cron** (`ENABLE` flags / comment the
   schedule) so campaign-audit cannot overlap health. That is a
   config change, not a canon reversal: campaign-audit is read-only
   duplicate. **Ask Josh** before flipping flags that touch isolation
   (`ENABLE_ISOLATION_BRANCH` stays on).

### Phase 1 — Isolation worker (the 30-minute SLA)

New Railway service, same image, `ROLE=isolation`:

- Own 15-minute cron: list tests → score same-ESP → mark suspect →
  evaluate (priority: 0% first, no 4/3 cap as the only throttle).
- Copy-canary attach on this worker, not boot-only / 6h.
- Postgres **or** a dedicated `isolation.sqlite` on volume first if
  Postgres isn’t ready — but **not** the giant `state.json`.
- Api `/health` reads isolation lastOk from that store.

Staff process **stops running** `isolation-branch` in `runHealth`.
Health sitting can die; ugly campaigns still isolate.

**Canon:** D159 “on-ramp is the 15-minute health sweep” needs a Josh
decision to become “15-minute isolation worker.” Same SLA, different
process. Append D273 (or next free number) in that PR with the guard.

**Host cost:** +1 replica (~+$10–20/mo).

### Phase 2 — Postgres + slim inventory (crash-safe findings)

- Add Railway Postgres. Migrate `stageHealth`, isolation scores/
  suspects/runs, `campaignChecks`, `genericSeats`, spend, holds.
- Dual-write with `state.json` for one deploy; read stamps from
  Postgres; then stop dumping the blob.
- Inventory: campaigns + accounts + `campaign_ids` only; persist
  slim rows; workers query SQL.

This kills resurrect-after-restart (151 isolation rows, 422 ghosts).

**Host cost:** +Postgres ~$5–15/mo; can drop volume later.

### Phase 3 — Staff worker + cut list (bloat)

Move rest / one-client / min40 / warmup / campaign-check off api.
Then delete in **one Josh-authorized decision PR** (D127: code
deleted in the same PR, CANON updated, guards updated):

**Cut now (safe vs seven jobs):**

- `generic-rest` stage + service
- `deliveryWatch` evaluate path
- `campaignAudit` 6h walk
- `warmup-gate-monitor`
- extra 03:00 reconnect cron
- `lead-runout` (leads belong elsewhere)
- `GET /status` full state dump
- `activeSwaps`, `heldInboxes` state
- Allow-generics leftovers
- `/run` modes that aren’t health/min40/isolation/warmup/inboxkit/spend

**Fold:** `genericCleanup` into min40; `campaignTopUp` health fill
into min40 (health only rest + fan-out + one-client).

**Move off hot path:** dns-audit, sending-infra, pod-tags,
mailbox-type-tags, powerGrydWatch, bugRemediator, `/ops`.

**qa-unpause / campaign START:** Josh said status belongs elsewhere.
Ask before deleting D77/D106.

Each cut shrinks `canon.test.ts` in the **same** PR or the suite
fails closed (correct).

### Phase 4 — Prove the SLA

Success, all required:

- No freeze-watchdog `process.exit` for **24h**
- Isolation-branch (worker) lastOk **≤20 minutes**
- `uglyWithoutIsolation` **empty** for ACTIVE senders, or queued
  `<30 min` from first 0% score
- Health `/health` **200** even when staff is restarting
- `canonCompliant` judged on the seven jobs only (esp_mix /
  understaffed still real; campaign-audit holes gone)

---

## Mapping the seven jobs onto the stripped system

| Job | Today | Target |
|---|---|---|
| 1. 40/POD, static A/B, generics to floor | client-rest + min40 + top-up + fan-out + cleanup | **staff:** rest + min40 (cleanup folded) |
| 2. Exclusive seats + 33% ESP | one-client + esp_mix in campaign-check | **staff:** one-client + check |
| 3. Warmup then peel | warmup-gate + min40 named-warm swap | **staff:** gate + min40 swap |
| 4. Canaries + 30m isolation + word hunt | health tail + 6h monitor + DeliveryWatch | **isolation worker only** |
| 5. Copy / sig / merge-tag QA | campaign-check-first (20m timeout) | **staff:** check, own budget, not blocking isolation |
| 6. Lapsed delete | 08:16 CT sweep | **staff or api weekday job** |
| 7. Spend to Josh/Cayden | Slack + isolationExecute + digest | **api** (never on staff CPU) |

---

## What not to do

- Widen freeze-watchdog thresholds (explicitly rejected D271/D272).
- Another sidecar field for the next RAM-only prune.
- Keep adding `yieldEventLoop()` to O(n×m) walks instead of not
  doing those walks on the HTTP process.
- Boot-kick health/monitor (D122).
- Treat `#321` as the fix without the 2-hour / 24-hour success bar.
- Cut warmup-gate, min40, isolation, or spend without Josh.

---

## Sources

- Production `GET /health` 2026-10-15 ~20:18 UTC, deploy `cd89be1`
- `#deliverability` overdue + 0% pages 2026-10-14–15 (bot U0BS2EUFJEA)
- PRs #316 (D267), #318 (D269), #319 (D270), #320 (D271), #321 (D272)
- `CANON.md` D272, `src/index.ts`, `src/state/store.ts`,
  `src/lib/{freezeWatchdog,stepTimeout,smartleadLimiter,stringifyYielding,stageWindows,stateRetention}.ts`
- Repo: 62,266 production TS lines, 53 services, 35 `stage("` calls,
  14 `cron.schedule` sites
