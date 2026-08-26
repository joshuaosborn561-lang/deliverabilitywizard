# Cayden — morning and afternoon check

You are the eyeballs. The wizard already restaffs, writes leftover signatures, attaches canaries, creates placement tests, reconnects mailboxes, and pauses campaigns that are bouncing hard. Do not redo that. Look for what looks wrong.

**Where:** Slack, Smartlead, `/ops`.

**Ping Josh when:** something that should be sending is down, spam is high and staying high, a campaign is short on senders after a couple of hours, or a Slack button wants money / a domain retired.

**Never:** buy, retire a domain, unpause a bounce-paused campaign, START a canary shell, or change send rules.

---

## Morning

1. **Sending?**
   - Live book is **ACTIVE**: Goliath, BCP, Peterson, Parlay, TechEvo.
   - **Canary shells** and **Pod control shell** stay **PAUSED**.
   - A campaign the wizard paused for bounce stays paused. Do not turn it back on.

2. **Staffed?**
   - Each live campaign has senders on it (connected, not a handful).
   - Empty or obviously thin → wait one health pass (15 min), then tell Josh.

3. **Placement / spam?**
   - Live campaigns inboxing **~80%+**.
   - A new campaign does not go live under **85%**.
   - Promo tab counts as a miss.

4. **Canaries?**
   - Each live campaign has a placement test running.
   - Missing test → tell Josh if it is still missing after an hour.

5. **Signatures / copy?**
   - From-name and signature are that client’s brand.
   - No leftover `%signature%` in the email.
   - No other client’s brand in the body.

6. **Disconnects?**
   - Red / disconnected mailboxes: reconnect in `/ops`.
   - Still red after that → Josh.

7. **Slack?**
   - Tap only a **copy swap** or **Add %signature%** if it is sitting there.
   - Leave spend / retire / Allow generics for Josh.

---

## Afternoon

1. **EOD Slack**
   - Read sends and spam % per client.
   - Spam high on a live campaign → tell Josh. Do not start rotating senders by hand.

2. **Paused?**
   - Bounce-paused campaigns stay down.
   - Something that should still be sending is paused for no bounce reason → tell Josh.

3. **Drafts with leads?**
   - A **DRAFT** sitting on a list that already has leads is stuck. Name it to Josh.

4. **Tomorrow**
   - Campaigns that should send in the morning are still staffed.
   - Anything launching tomorrow is at **85%+** inbox, or it waits.

5. **Same eyeballs as morning**
   - Shells still paused.
   - Canaries still running.
   - Signatures still that client’s brand.
   - Slack buttons cleared or handed to Josh.

---

## What “good” looks like

| Check | Good |
|---|---|
| Sending | Live book ACTIVE; shells PAUSED |
| Staffed | Each live campaign has a real sender list, not 1–2 boxes |
| Spam | Live ~80%+ inbox; launch 85%+ |
| Canaries | One living test per live campaign |
| Sigs | Name + that client’s brand; no `%signature%`; no foreign brand |
| Bounce | Wizard paused it over 10% after 1k leads, or a bounce burst. Leave it. |
| You | Reconnect. One confirmed rotation if `/ops` says every check passed. Copy-swap button only. |

If it is already green, you are done. Do not keep clicking.
