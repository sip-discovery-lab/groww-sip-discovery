# SIP Care · AI agent concept for Groww

An AI-native helper for the moment a **first-time Groww SIP investor's instalment fails, gets stuck, or may fail soon**. It tells them, in their own language, what happened, whether their money is safe, and the exact steps to get back on track, so one missed month doesn't quietly end the SIP.

> Concept prototype built for a product case study. Not an official Groww product and not made by Groww. Not investment advice.

**Live:** deployed on Cloudflare Workers. Every push to `main` is tested by GitHub Actions and built and deployed by Cloudflare Workers Builds.

---

## Why this exists

Business goal: raise the share of first-time investors whose SIP is still active 12 months after they start (active = at least one successful instalment in the last 30 days).

An AI discovery engine labelled 288 public Groww voices (Play Store, App Store, YouTube, Reddit, Trustpilot, complaint sites and others):

| Finding | Count |
|---|---|
| At-risk voices (failed, stopped, paused or about to stop) | 100 |
| ...whose SIP broke through a payment they did **not** choose | 51 |
| ...plus voluntary stops right after payment trouble | 9 |
| Money debited but no units, or refund slow | 25 of 51 |
| Support didn't answer | 24 of 51 |
| Couldn't find how to pay the missed instalment | 14 of 51 |
| AutoPay or mandate not working | 13 of 51 |

These people started with good intent and wanted to continue. What breaks continuation is **not knowing what happened and not being helped back**.

**Segment:** first-time Groww SIP investors in their first 12 months, focusing on the moment of their first failed or stuck instalment.

## What it does

1. The person taps what happened (money gone but no units, instalment failed, AutoPay broken, balance short soon) and/or types it in **any language** (English, Hinglish, Hindi).
2. **Personal data is removed first:** PAN, account numbers, Aadhaar, UPI IDs, OTPs and IFSC are stripped before anything reaches the AI or is saved.
3. **Gemini** works out the situation, orders the options for their case (for example, move the SIP date to after payday if income arrives after the SIP date), and writes a short calm summary in their language.
4. **Facts and steps are fixed, sourced text** (Groww Help pages, fund-house and broker FAQs). The AI cannot change them.
5. **Every AI sentence is checked** for fund names, advice, return predictions, fear or urgency words, and requests for personal data. Anything that fails is removed and logged.
6. **The person chooses.** Stopping the SIP is always available, shown neutrally, never first.

Where it would sit in Groww: the failed-debit notification, a "Something went wrong with this instalment?" link in My SIPs, and an optional check-in 3 days before the SIP date.

## SIP Care agent (the MVP)

Open the app at `/`. It is a Groww-style concept app with a demo user (Riya) and 3 SIPs on the 26th of every month. **At launch everything is normal**: no errors, all SIPs active, the last invested date is the most recent 26th (last month's 26th until this month's comes round), with invested amount, current value and gain per SIP.

**The user decides what to check.** SIP Care offers topics (payment failed, not showing in app, stop or close a SIP, when will it grow, withdraw money, tax and exit load, change date or amount, skip or pause, AutoPay, is my money safe) and a free-text box for any SIP question, in English, Hinglish or Hindi.

**How it answers (agent loop per question):**
1. **Reads the account:** statuses, instalment history, invested vs current value, units, NAV, exit load, orders in progress, AutoPay, withdrawals.
2. **Checks SIP rules and platform guidelines:** a built-in guideline base (cut-off and NAV, unit allotment time, refunds, auto-cancellation after 3 failed instalments, stop processing time, redemption timelines, exit load, capital gains tax, AutoPay) plus, when AI is on, a background web check of current rules (cached for a week). Where a rule came from is never shown: links, site, company and regulator names are removed from notes, and any answer that mentions a source is blocked.
3. **Answers with evidence:** "What I found in your account", the answer, "What happens next", follow-up questions.
4. **Acts:** safe steps run by themselves (track an order, set a reminder, draft a support message). Anything that moves money or changes a SIP (withdraw, pay a missed instalment, stop, change date or amount, skip, pause, restart, new AutoPay request, send a ticket) is **proposed and waits for Confirm**, with the details (amount, exit load, bank, timeline) on the confirm sheet.
5. **Follows up in the background:** the agent keeps checking (in the open app and via Cloudflare Cron with the app closed) and notifies the user when units are added, a withdrawal is credited, a stop is processed or AutoPay is active again (in-app, inbox, and Web Push). Demo time is accelerated: things that take 1-2 working days finish in about a minute.

**On the SIP date (failed payment flow):**
1. **Instant alert.** SIP Care watches every debit on the SIP date. If one fails, it notifies the user at once (in-app, inbox and Web Push) with what happened, why (bank reason, balance at the time of the debit, salary day, AutoPay status) and what it means (invested money safe, SIP still active).
2. **Options first.** SIP Care recommends checking the options before deciding: keep my SIP going (recommended), take a break (pause 1-3 months), cancel this SIP, or ask something else.
3. **Keep going → AI fix.** SIP Care detects the cause and proposes the best fix: low balance → reminder on salary day + move the SIP date after payday (pay the missed instalment once salary arrives; it alerts when salary lands); AutoPay expired → set up AutoPay again + pay now; bank error → retry payment + support ticket. Stop and withdraw are never proposed here.
4. **Cancel → AI asks why first.** Reasons (not seeing growth, money tight, payment trouble, need the money, don't understand SIPs, other + own words), then a recommendation that fits the reason (e.g. early SIP values move little, explained with the user's own numbers; skip or pause; withdraw only what's needed). "Cancel this SIP" is always offered, last, and a "skip and cancel now" button is always there.
5. **Redirects.** Answers carry buttons to the right page: SIP details (date, amount, skip, pause, AutoPay, withdraw, cancel), AutoPay settings, payments & orders, support ticket (pre-drafted), bank account, withdraw. Every change made from a page still needs Confirm.

On the real SIP date the agent runs the debits itself (all succeed in the demo account). **For testers:** "try a situation" jumps to the next SIP date with a chosen outcome (low balance, AutoPay expired, bank error, all paid) or shows money debited without units.

**Safety rules (checked on every AI answer):** no fund recommendations or comparisons, no return predictions, only numbers from the account, the guidelines or the user's message, no fee waivers, no fear or urgency words, no requests for personal data (PAN, account numbers, OTP are stripped before the AI sees them), no mention of sources. If any rule breaks, or AI is off, down or over the free limit, SIP Care uses its rule-based answer and labels it "Standard".

| Route | What it does |
|---|---|
| `POST /api/agent/start` | Start or resume a demo session (`reset: true` for a fresh account) |
| `POST /api/agent/message` | Ask SIP Care any SIP question, or a guided step (`flow`: fix a failed payment, or cancel with a reason); returns found / answer / next / follow-ups / links, auto steps and proposals |
| `POST /api/agent/confirm` / `decline` | User confirms or declines proposals |
| `POST /api/agent/tick` | Background check (auto-paced) |
| `POST /api/agent/situation` | Testers: run the SIP date with a chosen outcome, or another demo situation |
| `POST /api/agent/propose` | App pages create an action that still needs Confirm |
| `POST /api/agent/settings` | Pause/resume background checks, language, mark notifications read |
| `GET /api/agent/push-key`, `POST /api/agent/push-subscribe`, `GET /api/agent/latest` | Web Push alerts (VAPID keys generated and kept in D1; pushes carry no data) |
| `POST /api/agent/feedback`, `GET /api/agent/stats` | Tester answers and usage stats |
| `GET /quality` | Run the 42-case agent quality gate (`agent-v4`: 30 questions + 12 guided fix/cancel cases) |

AI answers are used only after the agent passes its gate: at least 90% of 42 cases and zero rule breaks, per model and version.

## Earlier SIP Care diagnosis API

The app's screens (built in Stitch, running on Lovable) call these routes. The AI reads the bank's raw failure message and the SIP dates, decides the cause, picks the fix and writes the explanation; fixed titles, dates and amounts are built from the SIP data, never by the AI.

| Route | What it does |
|---|---|
| `GET /api/care/diagnose?lang=en|hinglish|hi` | Cause, "what SIP Care found", the fix, other options, home message. AI only if the care gate passed; otherwise the standard text. Cached 30 min to save the free quota. |
| `POST /api/care/fix` | Records the confirmed (simulated) fix and returns the steps shown on the "fixing" screen |
| `POST /api/care/event` | Anonymous funnel events (no typed text, no personal data) |
| `GET /api/care/stats` | Sessions, fix rate, median time to fix, AI answers |
| `GET /quality` | Public quality-check page: run the 25-case SIP Care gate and see every case |

Extra checks on AI text: no invented amounts, dates, percentages, fee waivers or "zero penalty" claims.

## Eval gate

AI answers stay **off** until the model passes a 25-case quality check written from real Groww SIP posts plus edge cases (asking which fund to buy, sharing a PAN, angry "I'm stopping everything" messages, out-of-scope questions, Hindi and Hinglish).

- Pass rule: **at least 90% correct and zero rule breaks**, per model and prompt version.
- A case passes when the situation is right, a correct action is in the top two, stop is not first, the language matches, worries are answered, personal data is removed, and no safety rule breaks.
- If the gate is not passed, or the AI is down or over its free limit, people get standard (non-AI) help. They are never left without an answer.
- Anyone can rerun the check from the **Quality check** tab (rate-limited to protect the free quota). Every run is stored and shown case by case.

## Testing with users

The **Try a scenario** tab gives testers three realistic situations and three questions (understood what happened? what would you do? how clear?). Results appear in the **Results** tab. Nothing typed is stored, only choices, scores and time taken.

| Measure | Target |
|---|---|
| Understood what happened to their money | at least 80% |
| Picked a next step | at least 80% |
| Clarity | 4 or more out of 5 |
| Time to decision | under 2 minutes |
| AI rule breaks | 0 |

## Tech stack

| Part | Tool |
|---|---|
| AI | Google Gemini (free tier, `gemini-3.5-flash-lite`, structured JSON output) |
| Back end and page | Cloudflare Workers (single file, no framework) |
| Data | Cloudflare D1 (sessions, feedback, eval runs, usage) |
| CI/CD | GitHub Actions runs the tests (no secrets); Cloudflare Workers Builds deploys from this repo |
| Tests | Node built-in test harness with mock AI and in-memory SQLite; Playwright UI tests |

```
src/facts.js     fixed facts, actions, situations and sources
src/prompt.js    system prompt and response schema
src/guard.js     personal-data removal and safety checks
src/core.js      Gemini call, answer builder, fallback, case scoring
src/worker.js    routes, database, eval gate
src/page.html    the web page
eval/cases.json  the 25 gate cases
test/            guard, route and UI tests
build.mjs        inlines everything into dist/worker.js
```

## Run locally

```
npm test        # build + safety + route tests (mock AI, no keys needed)
npm run dev     # local server on http://localhost:8788 with mock AI
node test/ui.cjs # browser tests (needs Playwright and the dev server)
```

## Deploy

No keys or tokens are stored in this repo or in GitHub.

- Cloudflare Workers Builds is connected to this repo from the Cloudflare dashboard. On each push it runs `node build.mjs` and deploys `dist/worker.js` using `wrangler.toml`.
- The Gemini key is an encrypted secret (`GEMINI_API_KEY`) set only in the Worker's settings in Cloudflare.
- The D1 database is bound as `DB` (see `wrangler.toml`).
- Every build and deployed version is listed in Cloudflare (Workers → Deployments), and each commit on GitHub shows its build check.

## Limits

- It explains and guides. It cannot see or change a real Groww account.
- Facts come from public pages and may change. Each one links to its source.
- Gemini's free tier may use prompts to improve Google's products, which is one reason personal data is removed first. Daily AI use is capped; above the cap, standard help is shown.
