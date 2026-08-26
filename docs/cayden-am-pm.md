# Cayden — morning and afternoon check

You are the eyeballs. The wizard already restaffs, writes leftover signatures, attaches canaries, creates placement tests, reconnects mailboxes, and pauses campaigns that are bouncing hard. Do not redo that. Look for what looks wrong.

**Where:** Slack, Smartlead, `/ops`.

**Ping Josh when:** something that should be sending is down, spam is high and staying high, a campaign is short on senders after a couple of hours, or a Slack button wants money / a domain retired.

**Never:** buy, retire a domain, unpause a bounce-paused campaign, START a canary shell, or change send rules.

---

## Morning

1. **Sending?**
   Are the client campaigns actually on, and are the fake/test ones still off?
   Live book is **ACTIVE**: Goliath, BCP, Peterson, Parlay, TechEvo. Canary shells and Pod control shell stay **PAUSED**. If the wizard paused one for bounce, leave it.

2. **Staffed?**
   Does each live campaign have enough mailboxes to send, or is it sitting on one or two?
   Wait one health pass (15 min). Still empty or obviously thin → Josh.

3. **Placement / spam?**
   Are the emails landing in the inbox, or in spam / promo?
   Live campaigns should be about **80%+** inbox. A new one does not go live under **85%**. Promo tab counts as a miss.

4. **Canaries?**
   Is there a seed test running so we can see inbox vs spam without guessing?
   Each live campaign needs one living placement test. Still missing after an hour → Josh.

5. **Signatures / copy?**
   Does the email look like it came from that client, not someone else?
   From-name and signature are that client’s brand. No leftover `%signature%`. No other client’s name in the body.

6. **Disconnects?**
   Are any mailboxes logged out so they cannot send?
   Reconnect red ones in `/ops`. Still red → Josh.

7. **Slack?**
   Is there a button waiting that is yours, or Josh’s?
   You may tap a **copy swap** or **Add %signature%**. Spend, retire, and Allow generics stay with Josh.

---

## Afternoon

1. **EOD Slack**
   How much did we send today, and how much landed in spam?
   Read sends and spam % per client. Spam high and staying high → Josh. Do not rotate senders by hand.

2. **Paused?**
   Is anything stopped that should still be sending — or is it stopped on purpose because it was bouncing?
   Bounce-paused stays down. Paused for no bounce reason → Josh.

3. **Drafts with leads?**
   Is a campaign sitting in draft with a list already loaded, so it will never send?
   A **DRAFT** with remaining leads is stuck. Name it to Josh.

4. **Tomorrow**
   Will the morning book actually be able to send, and is anything new good enough to launch?
   Still staffed. Launching tomorrow needs **85%+** inbox or it waits.

5. **Same eyeballs as morning**
   Did anything drift since you looked at 7am?
   Shells still paused. Canaries still running. Signatures still that client. Slack buttons cleared or handed to Josh.

---

## What “good” looks like

| Check | What it means | Good |
|---|---|---|
| Sending | Campaigns that should mail are on; test shells are off | Live book ACTIVE; shells PAUSED |
| Staffed | Enough connected mailboxes to send | A real list, not 1–2 boxes |
| Spam | Seed inboxes got the mail in Inbox, not Spam | Live ~80%+; launch 85%+ |
| Canaries | A daily seed test is watching that campaign | One living test per live campaign |
| Sigs | The email is signed as that client | Name + brand; no `%signature%`; no foreign brand |
| Bounce | Too many bad addresses, so we stopped sending | Wizard paused it. Leave it. |
| You | Fix the small stuff; escalate the rest | Reconnect. Copy-swap button only. |

If it is already green, you are done. Do not keep clicking.
