# v2 omitted features — Josh review list

v2 implements the **seven canon jobs** from the audit. Everything below
is **left out of this parallel build on purpose**. The old wizard on
`main` still runs all of it. Nothing here deletes v1 code.

Each row is a live or historical canon decision. Status in
`src/canon/catalog.ts` is `omitted`. Josh can promote any row into v2
before cutover.

## Not one of the seven jobs (NICE / elsewhere)

| Decision | Feature | Why v2 skipped it |
|---|---|---|
| D21 | Auto bug remediator / Cursor API | Not a staffing, isolation, QA, lapsed, or spend job |
| D52 | Lead-runout watch | Leads belong to other systems |
| D53 | Sending-IP census | Advisory; does not spend |
| D56 / D89 | Known-good pod-control shell + coverage | Isolation uses `Auto: <name>` warmed tests instead |
| D64 | EOD staffing Slack | Shadow logs intended Slack; no EOD worker yet |
| D77 / D106 | QA-unpause START after sigs / 85% bar | Campaign status belongs elsewhere; D40 never auto-START |
| D94 | SMTP/IMAP reconnect | NICE; not a seven-job |
| D136 | Domain→client advisory audit | NICE |
| D147 | Bounce resurrection / resend | Support loop; v2 classifies and never pauses |
| D182 | Send-window converge Mon–Thu ET | Hand-set windows must not be overwritten |
| D205 / D246 | Hold-enforcement PAUSE list / Insight SEG | v2 does not PAUSE live campaigns |
| D223 / D236 / D254 | POC engagement 60-seat fill | Thin floor is 40 (TechEvo 30); POC is a name-list extra |
| D212 / D213 / D218 / D219 (TERRL swap) | 24h 5.7.233 substitute + EOD digest | Caps are in v2; the 24h swap worker is NICE |
| D260 | Domain-lifecycle continue-past-refusal | NICE retire/cover worker |

## Cutover-only (decided, but no live write in SHADOW)

These rules stay in the catalog as omitted **execute** paths. v2 already
**intends** the matching attach/detach/test/spend/slack. The write
payload at `WRITE_ENABLED` must honour them.

| Decision | Feature | Honour at cutover |
|---|---|---|
| D20 | Cayden cannot spend / purge / deploy | Keep old Slack auth until cutover |
| D60 / D137 / D150 / D161 / D174 / D175 / D179 / D181 | Canary/isolation/domain buy + retire | `intendSpend` only; Porkbun/InboxKit buy is NICE |
| D87 | Bulk signature approve | v2 auto-intends `signature_write` (D92) |
| D101 / D103 / D104 / D110 | `sequencesForWrite` allowlist | No sequence POST until the allowlist lands |
| D102 / D112 / D114 / D115 / D117 / D118 / D119 / D120 / D131 | Canary shell seed + PAUSED shell | `test_create` intended; execute on the shell, never the live campaign |
| D133 / D151 / D152 / D153 / D168 / D170 / D171 | Word-hunt Slack tap + gift-bait substitutes | COPY intends teardown; the tap UI is cutover |
| D134 / D190 / D194 / D195 / D220 / D248 / D266 | Slack buttons, Cayden CTA, Needs-you digest | Job 7 UI; shadow logs `slack` / `spend` |
| D135 | POD first-tag on untagged seats | Decoration; D234 lock is already coded (never A↔B) |
| D172 | Reserved attach budget | Process leftover |

## v1 process machinery v2 does not need

| Decision | Feature | Why |
|---|---|---|
| D211 / D214 / D215 | Health-chain leftover resume | Workers are independent 15m ticks |
| D247 / D252 / D265 / D271 / D272 | Freeze watchdog, yielding stringify, pause audit CPU | No 110MB `state.json`; api does not walk inventory |
| D253 | Dockerfile mirror | Railway nixpacks from `v2/` |
| D257 | Process-wide 150/min limiter | Split staff vs isolation budgets; add a limiter before cutover |

## Dead v1 features (retired — must not return)

Already `retired` in the catalog, listed here so a review does not
revive them in v2:

| Decision | Feature |
|---|---|
| D6 / D39 / D51 / D59 / D128 / D130 | Recovery holds, held-tests, placement/bounce pulls, recovery-swap |
| D28 / D36 | Provider-split copy classifier as a driver |
| D29 / D78 / D80 / D88 / D90 / D91 / D124 / D155 / D157 | Bounce pause / autostop / lifetime-rate |
| D44 / D61 / D107 / D111 / D144 | One-shot rebuilds / wipes / old-client teardown |
| D97 | Signature *ask* buttons (auto-write instead) |
| D178 / D184 / D189 / D200 | Insight in-body close, exclusive-blank staff, rest-sticky, exclusive extras peel |
| D221 (send-clock) | `generic-rest` / GenericSendRest |
| D268 | Allow-generics Slack card |

## Audit CUT list (v1 stages/loops) mapped to decisions

| v1 thing | Decision | v2 |
|---|---|---|
| `generic-rest` stage | D221 | absent |
| `deliveryWatch` evaluate | D159 | absent (on-ramp is isolation worker) |
| `campaignAudit` 6h | D81/D132 | absent (staff check is the writer) |
| `warmup-gate-monitor` | D247 | absent (one gate on staff) |
| Extra 03:00 reconnect cron | D94 | absent |
| `lead-runout` | D52 | absent |
| `GET /status` full dump | D167 | absent |
| `activeSwaps` / `heldInboxes` | D130 | absent |
| Allow-generics leftovers | D268 | absent |
| `/ops` UI | — | absent |
| `qa-unpause` | D77/D40 | absent |
| `bugRemediator` | D21 | absent |
| `powerGrydWatch` | D237 | PowerGRYD is a normal named client in min40 |
| `dns-audit` | D136 | absent |
| `mailbox-type-tags` converge | D183/D219 | caps used; tag-converge NICE |
| `pod-tags` decoration | D135/D234 | lock coded; first-tag NICE |
| `campaignTopUp` duplicate of min40 | D203/D268 | one fillFloor |
| `genericCleanup` duplicate of min40 | D225 | folded into staff |
| Boot canary attach at 90s | D122 | **no boot Smartlead**; isolation cron intends `test_create` |

Promote a row by changing its catalog status to `implemented` in the
same PR that lands the code (D127).
