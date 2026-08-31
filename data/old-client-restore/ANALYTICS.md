# Restored campaign analytics (from Supabase mirror, pre-delete)

## What Smartlead will show after restore

| UI field | Restorable via API? | How |
|---|---|---|
| Lead categories (Interested / Positive Reply / OOO / bounce category, …) | **Yes** | `POST /campaigns/{id}/leads/{leadId}/category` — applied from Supabase dump |
| Campaign header **sent / open / click / reply** | **No** | Read-only counters from real send events. DELETE wiped them; no write endpoint. Lead `status` is rejected (`"status" is not allowed`); PATCH `…/status` 404s on this account. |
| Bounce **category** on leads | Yes (as category_id `9`) | Does **not** rewrite the header bounce/sent counters |

Use the table below as the YouTube overlay for sent / replied / bounced.
Positive/interested counts in the lead-stats panel should match the
category restore once it finishes.

| Old id | New id | Campaign | Sent | Replied | Positive | Bounced |
|---|---|---|---|---|---|---|
| 3110622 | 3867914 | Nieto RB2B | 133 | 0 | 0 | 14 |
| 3201244 | 3867917 | Nieto Houston Floodzones | 1,318 | 10 | 0 | 14 |
| 3201308 | 3867918 | Nieto MSPs 20-200 | 26,956 | 295 | 0 | 157 |
| 3201381 | 3867919 | Nieto Spring | 3,602 | 64 | 0 | 56 |
| 3429214 | 3867921 | Nieto Law Firms | 2,238 | 36 | 0 | 59 |
| 3429333 | 3867922 | Nieto Astros Offer/Proprietary Tech | 1,740 | 28 | 0 | 33 |
| 3437329 | 3867923 | Nieto Sports or Airpods Offer/Proprietary Tech | 4,031 | 31 | 1 | 99 |
| 3563069 | 3867925 | MSRS Ticket Offer Propert Manager | 5,592 | 183 | 22 | 39 |
| 3628940 | 3867944 | MSRS2 Ticket Offer Property Manager | 5,108 | 101 | 0 | 124 |
| 3628943 | 3867945 | Positive | 0 | 0 | 0 | 0 |

Source: `campaignintelligence.public.sends` (last sync around delete).

```bash
# Re-apply categories from leads.json (idempotent):
unset RAILWAY_TOKEN RAILWAY_API_TOKEN
railway run -- npx tsx scripts/restore-lead-categories.ts --apply
```
