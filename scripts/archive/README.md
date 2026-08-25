# Archived one-off scripts

Historical, single-use production pokes from specific incidents (Goliath
bounce checks, TechEvo restores, one-time signature QA runs). They are kept
for the record of what was done, **not** for reuse.

Do not run these. Every job they did now has a standing owner:

- Staffing / fan-out / top-up — the 15-minute canon sweep (`runHealth`, D84)
- Bounce pauses and Smartlead autopause — `CampaignBounceAutostopService` (D80/D84)
- Signature QA and unpause — `campaignCheck` + `unpauseAfterSigQa` (D74/D77/D85)
- Lead runout — `LeadRunoutService` (D52)

If production needs a hand-poke the sweep cannot do, write a new script,
run it, and archive it here in the same PR — do not resurrect one of these
against current state.
