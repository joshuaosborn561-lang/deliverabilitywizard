# Restored campaign analytics (from Supabase mirror, pre-delete)

Smartlead DELETE wiped campaign analytics permanently. These are the
real numbers from `campaignintelligence.public.sends` as of the last
sync before/around the delete. Use for the YouTube video overlay if
the Smartlead UI still shows zeros.

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

Leads are being re-imported; lead statuses (COMPLETED / BOUNCED /
INTERESTED) can be pushed afterward. Sent/open/reply counters in the
Smartlead campaign header cannot.
