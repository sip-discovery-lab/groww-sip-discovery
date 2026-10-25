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

Open the app at `/`. It is a Groww-style concept app with a demo user (Riya) and 3 SIPs, each with a real-world problem from the research: a failed instalment (salary after SIP date), money debited but units pending, and AutoPay not approved.

**SIP Care is an AI agent.** It reads the user's SIPs and message (any SIP problem, in English, Hinglish or Hindi), decides what's wrong and what to do, and:
- **acts on its own** only for safe steps: tracking an order, setting a reminder, drafting a support message;
- **asks the user to confirm** anything that moves money or changes a SIP: pay now, retry on payday, change date or amount, skip, pause, resume, new AutoPay request, send a ticket, stop;
- **never** recommends funds, predicts returns, sells units, or asks for PAN/OTP/account numbers.

The confirm rule is enforced by the server, not just the prompt: confirm-type actions can only run through `/api/agent/confirm`. Every action is validated (e.g. retry only on a failed instalment, amount at least the fund minimum).

| Route | What it does |
|---|---|
| `POST /api/agent/start` | Start or resume a demo session (`reset: true` for a fresh one) |
| `POST /api/agent/message` | Agent turn: reply, actions done automatically, proposals needing confirmation |
| `POST /api/agent/confirm` | Run the proposals the user confirmed; returns the steps and the Home message |
| `POST /api/agent/decline` | User says "Not now" to a proposal |
| `POST /api/agent/feedback` | 3 tester questions (understood, fixed, clarity) |
| `GET /api/agent/stats` | Sessions, fix rate, median time to fix, AI vs standard answers, tester answers |
| `GET /quality` | Run the 30-case agent quality gate and see every case |

AI answers are used only after the agent passes its gate (at least 90% of 30 cases, zero rule breaks). If the gate isn't passed, the AI is down, over the free limit, or an AI answer breaks a safety rule, SIP Care uses its rule-based agent instead, and the app labels the answer "Standard".

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
