# LOCKED canon (Josh-only)

This file mirrors the LOCKED section of `CANON.md`. Do not edit one
without the other. Locked canon changes require Josh's explicit
approval, and such PRs must never auto-merge.

## LOCKED — Josh-only changes

Changes to this section require Josh's explicit approval. PRs that alter it must never auto-merge.

- POD-40: every client POD A and POD B must each hold >=40 warm seats the client owns (TechEvo 30), counted per POD, never per campaign; borrowed seats never count; when under, rotate free warm generics in (Insight: no generics, alert Josh daily). Never narrow, skip the off-week POD, or exempt any client from the count.
- Generics Ledger: Every generic inbox we own has exactly one row: email, ESP, warmup on/off, assigned client (blank = free pool), assigned POD (A/B), assigned_at, and covering_for (the specific branded seats of that client it stands in for, each with its 14-day warm-ready date). All generics warm continuously; any generic found not warming gets warmup turned back on the same day. A generic is assigned only to fill one client's POD to 40 (30 TechEvo), to one client and one POD, and never moves PODs. Branded is preferred: when a covered branded seat reaches 14 days warm, it goes into the POD and the generic it covered comes out the same day: unlinked, client_id cleared, POD/POC tags stripped, signature reset, back to the free pool. No generic is assigned or released outside the ledger. Insight never receives generics; every other client, including PowerGRYD, does. CornerStone-domain inboxes are never generics and never in the pool. A generic on a live campaign without a ledger row, a generic tagged to Insight, a generic not warming, or a POD under 40 with no free warm generic alerts Josh the same day.
- ESP matching + 10m gap: every Smartlead campaign has AI ESP matching ON (enable_ai_esp_matching: true) and min_time_btw_emails = 10, always (D304). The wizard flags and fixes drift on sight with settings / schedule writes only, never a status change; STOPPED campaigns are left alone.
