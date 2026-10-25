// SIP Care agent (v3): the user asks anything about their SIPs; the agent reads the account,
// checks SIP rules and platform guidelines, answers with evidence, does safe steps itself,
// and asks the user to confirm anything that moves money or changes a SIP.
const AGENT_VERSION = "agent-v3";
const AGENT_LANGS = ["en", "hinglish", "hi"];

const AUTO_ACTIONS = ["track_order", "set_reminder", "draft_ticket"];
const CONFIRM_ACTIONS = ["pay_now", "redeem", "stop_sip", "change_date", "change_amount", "skip_next", "pause", "resume", "setup_autopay", "send_ticket"];
const ALL_ACTIONS = AUTO_ACTIONS.concat(CONFIRM_ACTIONS);
const TOPICS = ["payment_failed", "not_reflecting", "stop_sip", "growth", "withdraw", "tax", "exit_load", "change_sip", "autopay", "missed_instalment", "is_money_safe", "will_sip_cancel", "status", "how_to", "out_of_scope", "unclear", "greeting"];
const INTENTS = TOPICS;

// ---------- dates (India time) ----------
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function istNow(ms) { const d = new Date((ms || Date.now()) + 5.5 * 3600 * 1000); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() }; }
const dlabel = (d, m, y) => `${d} ${MONTHS[(m + 12) % 12]}${y ? " " + y : ""}`;
function addMonths(m, y, k) { const t = m + k; return { m: ((t % 12) + 12) % 12, y: y + Math.floor(t / 12) }; }
const rupees = n => "₹" + Number(Math.round(n)).toLocaleString("en-IN");
const nth = n => n + (n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th");
const sipById = (st, id) => st.sips.find(s => s.id === id);
const failedInst = s => (s.instalments || []).find(i => i.status === "failed");

// ---------- the demo account: everything normal at launch ----------
const SIP_DAY = 26;
function demoState(nowMs) {
  const t = istNow(nowMs);
  // Last invested = the most recent 26th before today (last month's 26th until the 26th comes round).
  const last = t.d > SIP_DAY ? { m: t.m, y: t.y } : addMonths(t.m, t.y, -1);
  const next = t.d > SIP_DAY ? addMonths(t.m, t.y, 1) : { m: t.m, y: t.y };
  const mk = (id, fund, plan, category, amount, months, nav, gainPct, min_sip, exit_load, exit_note) => {
    const inst = [];
    for (let k = months - 1; k >= 0; k--) { const mm = addMonths(last.m, last.y, -k); inst.push({ date: dlabel(SIP_DAY, mm.m, mm.y), status: "paid", amount }); }
    const invested = amount * months, value = Math.round(invested * (1 + gainPct / 100));
    const st0 = addMonths(last.m, last.y, -(months - 1));
    return { id, fund, plan, category, amount, day: SIP_DAY, min_sip, started: dlabel(SIP_DAY, st0.m, st0.y), autopay: "active", status: "active", skip_next: false, paused_months: 0, new_day: null, new_amount: null,
      instalments: inst, invested, value, nav, units: +(value / nav).toFixed(3), exit_load, exit_note, lock_in: "None", order: null };
  };
  const st = {
    user: "Riya", now: t, today: dlabel(t.d, t.m, t.y), today_day: t.d,
    last_sip: dlabel(SIP_DAY, last.m, last.y), next_sip: dlabel(SIP_DAY, next.m, next.y), next_sip_is_today: t.d === SIP_DAY,
    bank: "Account ••12", balance: 42500, lang: "en", autoplay: true, last_tick: 0, ended: false, clock: 0,
    sips: [
      mk("A", "Bluechip Equity Fund (Demo)", "Direct Growth", "Large cap equity", 1000, 6, 51.24, 3.2, 500, 1, "1% if units are redeemed within 1 year of each instalment"),
      mk("B", "Flexi Cap Fund (Demo)", "Direct Growth", "Flexi cap equity", 2000, 4, 78.10, -1.1, 500, 1, "1% if units are redeemed within 1 year of each instalment"),
      mk("C", "Nifty 50 Index Fund (Demo)", "Direct Growth", "Index fund (equity)", 500, 2, 24.36, 0.8, 100, 0, "No exit load"),
    ],
    redemptions: [], observations: [], inbox: [], reminders: [], tickets: [], drafts: [], activity: [], ledger: [],
  };
  return st;
}

function findIssues(st) {
  const out = [];
  for (const s of st.sips) {
    const f = failedInst(s);
    if (f) out.push({ sip_id: s.id, kind: "failed", title: `${f.date} instalment not paid`, line: `${s.fund} · ${rupees(s.amount)}` });
    if (s.order && s.order.status === "delayed") out.push({ sip_id: s.id, kind: "delayed", title: "Units not showing yet", line: `${s.fund} · ${rupees(s.amount)}` });
    if (s.autopay === "expired") out.push({ sip_id: s.id, kind: "autopay", title: "AutoPay not active", line: `${s.fund} · next ${st.next_sip}` });
  }
  return out;
}

function snapshot(st) {
  return {
    today: st.today, last_instalment_date: st.last_sip, next_instalment_date: st.next_sip, bank: st.bank, bank_balance_demo: st.balance,
    sips: st.sips.map(s => ({ id: s.id, fund: s.fund, plan: s.plan, category: s.category, monthly_amount: s.amount, sip_date: nth(s.day), status: s.status, autopay: s.autopay, started: s.started,
      instalments_paid: s.instalments.filter(i => i.status === "paid").length, last_instalments: s.instalments.slice(-3), invested: s.invested, current_value: s.value, gain: s.value - s.invested, units: s.units, nav: s.nav,
      exit_load: s.exit_note, lock_in: s.lock_in, min_sip: s.min_sip, order: s.order, skip_next: s.skip_next, new_date_from_next_cycle: s.new_day, new_amount_from_next_cycle: s.new_amount })),
    redemptions: st.redemptions.map(r => ({ sip_id: r.sip_id, amount: r.amount, status: r.status })),
    recent_agent_updates: (st.observations || []).slice(0, 4).map(o => `${o.title} (${o.status})`),
  };
}

// ---------- guidelines the agent checks (where they came from stays internal; never shown) ----------
const GUIDELINES = [
  "Missed or failed instalment: only that month's units are not bought; units already held are not affected. The fund house charges no penalty; the bank may charge its own bounce fee. A monthly SIP is cancelled automatically after 3 consecutive failed instalments (2 for quarterly or longer); one successful instalment resets the count.",
  "Paying a missed instalment yourself is a one-time purchase; units are bought at the NAV of the day the money reaches the fund before the 3:00 pm cut-off.",
  "NAV and units: purchase NAV depends on when the money reaches the fund. Money received by 3:00 pm on a business day gets that day's NAV; otherwise the next business day's. Units usually show 1-3 working days after the debit, because the fund house and registrar update the platform later.",
  "If money was debited but the order failed, it is refunded to the same bank account, usually within 5-7 business days.",
  "Stopping or cancelling a SIP only stops future instalments; units already held stay invested until the investor redeems them. Cancellation is processed within 2 working days; an instalment due inside that window may still be debited. A new SIP can be started later.",
  "Changing the SIP date or amount applies from the next instalment cycle. Amount must be at least the fund's minimum SIP. A skip applies to the next instalment only and the SIP stays active.",
  "AutoPay (mandate): if it expires or is not approved, instalments are not debited automatically. A new request must be approved in the UPI or bank app and usually becomes active in 2-7 days. Meanwhile an instalment can be paid manually.",
  "Withdrawal (redemption): in the app, open the fund, tap Redeem, choose amount or units, confirm. Requests before 3:00 pm on a business day get that day's NAV. For equity funds the money is usually credited to the bank account linked to the folio within 2 working days; liquid funds usually next working day. The SIP continues unless it is stopped separately.",
  "Exit load: many equity funds charge about 1% if units are redeemed within 1 year of each instalment; index funds often have none. Each SIP instalment has its own holding period.",
  "Tax on equity funds: units held up to 12 months are short-term, taxed at 20%; held over 12 months are long-term, taxed at 12.5% on total long-term gains above ₹1.25 lakh in a financial year. Each instalment's holding period is counted separately (first in, first out). Tax applies only when units are redeemed, and only on gains. ELSS has a 3-year lock-in per instalment.",
  "Growth: mutual fund values are market-linked and move up and down; no one can promise when or how much they will grow. The value grows when the fund's NAV rises. Equity funds are generally meant for long holding periods. Past performance does not guarantee future returns.",
  "Statements and holdings can be seen in the app's portfolio; a consolidated account statement covers all folios.",
];

function agentSystemPrompt() {
  return `You are SIP Care, an AI agent inside a Groww-style mutual fund app (concept prototype; the account is demo data). The investor can ask ANY question about their SIPs: a payment that failed, an investment not showing, stopping or closing a SIP, when their money will grow, how and when they can withdraw, tax, exit load, changing date or amount, skipping, pausing, AutoPay, or anything else about SIPs.

HOW YOU WORK
1. Read the ACCOUNT (JSON) and find the facts that answer the question: statuses, dates, amounts, units, NAV, invested, current value, gain, exit load, orders, AutoPay. Never contradict the account. If the user says something happened that the account doesn't show (e.g. a failed payment that isn't there), say what you found and offer to help check further.
2. Apply the GUIDELINES and any BACKGROUND NOTES to those facts. If notes conflict with the guidelines, follow the guidelines.
3. Answer clearly and specifically for THIS user (their funds, amounts and dates).
4. Decide actions. Automatic actions (track_order, set_reminder, draft_ticket) you may do yourself. Everything else (pay_now, redeem, stop_sip, change_date, change_amount, skip_next, pause, resume, setup_autopay, send_ticket) is only proposed; the user must confirm. Propose an action only when the user asked for it or it clearly solves their problem. Never propose stop_sip or redeem unless the user asked to stop/close or to withdraw money.
   - redeem {sip_id, amount} (rupees, at most current_value) or {sip_id, all: true}.
   - change_date {sip_id, day 1-28}; change_amount {sip_id, amount}; pause {sip_id, months 1-3}; set_reminder {sip_id, day}.
   - If the fund or the number is unclear, ask ONE short question in the answer and propose nothing.

OUTPUT FIELDS
- topic: one of the listed topics.
- found: 1-4 short facts from the account you used, with exact numbers/dates, e.g. "Last instalment: ₹1,000 paid on 26 Sep 2026".
- answer: 2-4 short, calm sentences answering the question for this user.
- next: 0-3 short "what happens next" points (timelines, steps in the app).
- followups: 2-3 short follow-up questions the user may tap next.
- actions: as above.

RULES (breaking any is a failure)
- Never recommend, rank or compare funds (other than describing the user's own SIPs). Never suggest investing more, switching or selling as advice; act only on what the user asks.
- Never predict returns, NAV or markets, and never give a date or number for future growth. For growth questions explain how value changes, show their invested vs current value from the account, and say no one can promise growth.
- Use only numbers and dates from the account, the guidelines or the user's message. Never invent fees, waivers, timings or percentages.
- No fear or urgency words (immediately, urgent, hurry, last chance, you will lose, turant, jaldi).
- Never ask for PAN, OTP, PIN, passwords, account numbers or screenshots. If the user shares one, tell them not to share it.
- NEVER mention where information comes from: no websites, links, articles, companies, regulators by name, "according to", "sources" or "research". Speak only as SIP Care.
- Language: en = English; hinglish = Hindi in Latin script; hi = Hindi in Devanagari. Write found, answer, next and followups in that language.
Return only JSON matching the schema.`;
}

const AGENT_SCHEMA = {
  type: "OBJECT",
  properties: {
    topic: { type: "STRING", enum: TOPICS },
    sip_id: { type: "STRING", enum: ["A", "B", "C", ""] },
    found: { type: "ARRAY", items: { type: "STRING" } },
    answer: { type: "STRING" },
    next: { type: "ARRAY", items: { type: "STRING" } },
    followups: { type: "ARRAY", items: { type: "STRING" } },
    language: { type: "STRING", enum: AGENT_LANGS },
    actions: { type: "ARRAY", items: { type: "OBJECT", properties: {
      type: { type: "STRING", enum: ALL_ACTIONS }, sip_id: { type: "STRING", enum: ["A", "B", "C"] },
      day: { type: "INTEGER" }, amount: { type: "INTEGER" }, all: { type: "BOOLEAN" }, months: { type: "INTEGER" }, subject: { type: "STRING" }, body: { type: "STRING" },
    }, required: ["type", "sip_id"] } },
  },
  required: ["topic", "found", "answer", "actions"],
};

function agentUserPrompt(st, message, lang, history, notes) {
  const h = (history || []).slice(-6).map(x => `${x.role === "user" ? "User" : "SIP Care"}: ${x.text}`).join("\n");
  return `Requested language: ${lang}
ACCOUNT (today is ${st.today}):
${JSON.stringify(snapshot(st))}
GUIDELINES:
- ${GUIDELINES.join("\n- ")}
${notes ? "BACKGROUND NOTES (use quietly; never mention them):\n" + notes + "\n" : ""}${h ? "Recent conversation:\n" + h + "\n" : ""}User question: """${message}"""`;
}

// ---------- actions ----------
function exitLoadOn(s, amount) { return s.exit_load ? Math.round(amount * s.exit_load / 100) : 0; }
function validateAction(a, st) {
  const s = sipById(st, a.sip_id);
  if (!s) return "unknown SIP";
  if (s.status === "stopped" && !["draft_ticket", "send_ticket", "redeem"].includes(a.type)) return "this SIP is stopped";
  switch (a.type) {
    case "pay_now": if (!failedInst(s)) return "there is no missed instalment to pay"; if (st.balance < s.amount) return `your balance is ${rupees(st.balance)}, below ${rupees(s.amount)}`; return "";
    case "redeem":
      if (s.value <= 0) return "nothing left to withdraw in this fund";
      if (a.all) return "";
      if (!(a.amount > 0)) return "tell me how much to withdraw";
      if (a.amount > s.value) return `you can withdraw up to ${rupees(s.value)} from this fund`;
      return "";
    case "stop_sip": if (s.status === "stop_requested") return "a stop request is already being processed"; return "";
    case "change_date": if (!(a.day >= 1 && a.day <= 28)) return "SIP date must be between 1 and 28"; if (a.day === (s.new_day || s.day)) return "that's already the SIP date"; return "";
    case "change_amount": if (!(a.amount >= s.min_sip && a.amount % 100 === 0 && a.amount <= 100000)) return `amount must be at least ${rupees(s.min_sip)} in multiples of ₹100`; if (a.amount === (s.new_amount || s.amount)) return "that's already the amount"; return "";
    case "skip_next": if (s.skip_next) return "the next instalment is already skipped"; return "";
    case "pause": if (!(a.months >= 1 && a.months <= 3)) return "pause must be 1-3 months"; if (s.status === "paused") return "already paused"; return "";
    case "resume": if (s.status !== "paused") return "this SIP isn't paused"; return "";
    case "setup_autopay": if (s.autopay === "active") return "AutoPay is already active"; if (s.autopay === "pending_approval") return "a new AutoPay request is already waiting for your approval"; return "";
    case "track_order": if (!s.order || s.order.status === "allotted") return "no order in progress"; if (s.order.tracking) return "already tracking"; return "";
    case "set_reminder": if (!(a.day >= 1 && a.day <= 31)) return "invalid reminder day"; return "";
    case "draft_ticket": case "send_ticket": return "";
  }
  return "unknown action";
}

function actionView(a, st) {
  const s = sipById(st, a.sip_id);
  const row = [["SIP", s.fund], ["Bank", st.bank]];
  switch (a.type) {
    case "pay_now": { const f = failedInst(s); return { title: `Pay ${rupees(s.amount)} now`, summary: `Pay the missed ${f ? f.date : ""} instalment of ${rupees(s.amount)} from ${st.bank}.`, rows: [["Amount", rupees(s.amount)]].concat(row), note: "Units are bought at the NAV of the day the money reaches the fund.", step: `Paid ${rupees(s.amount)} for ${s.fund}; units on the way` }; }
    case "redeem": { const amt = a.all ? s.value : a.amount; const load = exitLoadOn(s, amt); return { title: a.all ? `Withdraw all (${rupees(amt)})` : `Withdraw ${rupees(amt)}`, summary: `Redeem ${a.all ? "all units" : rupees(amt)} from ${s.fund}. Money goes to ${st.bank}.`, rows: [["Amount", rupees(amt)], ["Exit load", load ? `about ${rupees(load)} (1%)` : "None"], ["Credited to", st.bank], ["Expected", "within 2 working days"], ["SIP", s.fund]], note: `${s.exit_note}. Tax applies only on gains when you redeem. Your SIP continues unless you stop it.`, step: `Placed a withdrawal of ${rupees(amt)} from ${s.fund}` }; }
    case "stop_sip": return { title: "Stop this SIP", summary: `Stop future instalments of ${s.fund}.`, rows: row.concat([["Processed in", "up to 2 working days"]]), note: `Units you hold (${rupees(s.value)}) stay invested until you choose to withdraw. An instalment due in the next 2 working days may still be debited.`, step: `Requested to stop ${s.fund}`, danger: true };
    case "change_date": return { title: `Move SIP date to the ${nth(a.day)}`, summary: `From the next cycle, ${s.fund} will run on the ${nth(a.day)} instead of the ${nth(s.new_day || s.day)}.`, rows: [["Current date", nth(s.new_day || s.day)], ["New date", nth(a.day)]].concat(row), note: "", step: `Changed the SIP date to the ${nth(a.day)} from the next cycle` };
    case "change_amount": return { title: `Change amount to ${rupees(a.amount)}`, summary: `From the next instalment, ${s.fund} will be ${rupees(a.amount)} instead of ${rupees(s.new_amount || s.amount)}.`, rows: [["Current amount", rupees(s.new_amount || s.amount)], ["New amount", rupees(a.amount)]].concat(row), note: "You can change it again anytime.", step: `Changed the SIP amount to ${rupees(a.amount)} from the next instalment` };
    case "skip_next": return { title: "Skip the next instalment", summary: `Skip the ${st.next_sip} instalment of ${rupees(s.amount)}. Your SIP stays active.`, rows: [["Skipped", st.next_sip]].concat(row), note: "", step: `Skipped the ${st.next_sip} instalment; SIP stays active` };
    case "pause": return { title: `Pause for ${a.months} month${a.months > 1 ? "s" : ""}`, summary: `No instalments for ${a.months} month${a.months > 1 ? "s" : ""}, then your SIP restarts.`, rows: [["Pause", `${a.months} month${a.months > 1 ? "s" : ""}`]].concat(row), note: "Units you hold stay invested.", step: `Paused the SIP for ${a.months} month${a.months > 1 ? "s" : ""}` };
    case "resume": return { title: "Restart this SIP", summary: `Restart ${s.fund} from the next ${nth(s.day)}.`, rows: row, note: "", step: "Restarted the SIP" };
    case "setup_autopay": return { title: "Set up AutoPay again", summary: `Send a new AutoPay request for ${s.fund} to your UPI or bank app.`, rows: row, note: "Approve it in your app. It usually becomes active in 2-7 days.", step: "Sent a new AutoPay request to your UPI app" };
    case "send_ticket": return { title: "Send to support", summary: a.subject || "Support request", rows: [["Message", (a.body || "").slice(0, 200)]], note: "No personal details are shared.", step: "Sent your message to support" };
    case "set_reminder": return { title: "Reminder set", step: `Set a reminder${a.day ? " for the " + nth(a.day) : ""}` };
    case "track_order": return { title: "Tracking your order", step: `Tracking your ${rupees(s.amount)} instalment; I'll tell you when units show` };
    case "draft_ticket": return { title: "Support message drafted", step: "Drafted a support message (no personal details)" };
  }
  return { title: a.type, step: a.type };
}

function applyAction(a, st) {
  const s = sipById(st, a.sip_id);
  const view = actionView(a, st);
  switch (a.type) {
    case "pay_now": { const f = failedInst(s); st.balance -= s.amount; f.status = "processing"; f.note = `paid on ${st.today}`; s.order = { id: `PAY-${s.id}${Date.now() % 100000}`, status: "processing", debited: st.today, expected: "1-3 working days", ticks: 2, tracking: true, from_failed: f.date }; break; }
    case "redeem": { const amt = Math.min(s.value, a.all ? s.value : a.amount); const frac = amt / s.value; s.units = +(s.units * (1 - frac)).toFixed(3); s.invested -= Math.round(s.invested * frac); s.value = Math.round(s.value - amt); st.redemptions.push({ id: "R" + (Date.now() % 100000), sip_id: s.id, amount: Math.round(amt), load: exitLoadOn(s, amt), status: "processing", ticks: 2 }); break; }
    case "stop_sip": s.status = "stop_requested"; s.stop_ticks = 1; break;
    case "change_date": s.new_day = a.day; break;
    case "change_amount": s.new_amount = a.amount; break;
    case "skip_next": s.skip_next = true; break;
    case "pause": s.status = "paused"; s.paused_months = a.months; break;
    case "resume": s.status = "active"; s.paused_months = 0; break;
    case "setup_autopay": s.autopay = "pending_approval"; s.autopay_ticks = 2; break;
    case "send_ticket": st.tickets.push({ sip_id: s.id, subject: a.subject || "Support request", body: a.body || "" }); if (s.order) s.order.ticket = true; break;
    case "set_reminder": st.reminders.push({ sip_id: s.id, day: a.day, text: view.step }); break;
    case "track_order": if (s.order) s.order.tracking = true; break;
    case "draft_ticket": st.drafts.push({ sip_id: s.id, subject: a.subject || "Support request", body: a.body || "" }); break;
  }
  st.activity.unshift({ text: view.step, sip_id: s.id, type: a.type, auto: AUTO_ACTIONS.includes(a.type) });
  return view.step;
}

// ---------- standard (rule-based) answers: used when AI is off, down or unsafe ----------
function pickSip(m) {
  if (/bluechip|large/.test(m)) return "A";
  if (/flexi/.test(m)) return "B";
  if (/nifty|index/.test(m)) return "C";
  return "";
}
function lastPaidOf(s) { const p = s.instalments.filter(i => i.status === "paid"); return p.length ? p[p.length - 1].date : ""; }
function agentRules(message, st) {
  const m = String(message || "").toLowerCase();
  const id = pickSip(m);
  const tot = st.sips.reduce((a, s) => ({ inv: a.inv + s.invested, val: a.val + s.value }), { inv: 0, val: 0 });
  const R = (topic, sip_id, found, answer, next, actions, followups) => ({ topic, sip_id, found, answer, next: next || [], actions: actions || [], followups: followups || [], language: "en" });
  const fails = st.sips.filter(s => failedInst(s));
  const proc = st.sips.filter(s => s.order && s.order.status !== "allotted");
  const lastPaid = st.sips.map(s => `${s.fund}: ${rupees(s.amount)} paid on ${lastPaidOf(s) || "—"}`);
  const num = parseInt((m.replace(/,/g, "").match(/(\d{3,7})/) || [])[1] || "0", 10);

  if (/(which|best|better|recommend|suggest|top).{0,25}(fund|scheme|stock)|should i (buy|invest|switch)|\bstocks?\b/.test(m)) return R("out_of_scope", "", [], "I can help with your SIPs: payments, changes, withdrawals, tax and timelines. I can't recommend or compare funds.", [], [], ["How do I withdraw?", "When will my money grow?"]);
  if (/(pan|aadhaar|otp|\b\d{9,18}\b)/.test(m) && /(my pan|account|otp|aadhaar)/.test(m)) {
    const base = agentRules(m.replace(/my pan is \S+|account \S+|otp \S+|aadhaar \S+/g, ""), st);
    base.answer = "Please don't share your PAN, account number or OTP here; I don't need them. " + base.answer; return base;
  }
  if (/(cancel ho jayegi|will (my )?sip (be|get) cancel|get cancelled|be cancelled|band ho ja|बंद हो जा)/.test(m)) return R("will_sip_cancel", "", st.sips.map(s => `${s.fund}: ${s.instalments.filter(i => i.status === "failed").length} failed instalments`), "No. One missed instalment doesn't cancel a SIP. A monthly SIP is cancelled only after 3 failed instalments in a row, and one successful instalment resets that.", [], [], ["What if my payment fails?", "Can I skip a month?"]);
  if (/(fail|bounce|declin|not deducted|didn'?t go|nahi kata|fail ho|two debits|double debit|debited twice)/.test(m)) {
    if (/(two debits|double|twice)/.test(m)) { const s = id || "A"; return R("payment_failed", s, lastPaid, "I'll raise this with support. If an extra amount was debited, it is refunded to your bank account. Confirm below and I'll send the message.", ["Refunds usually take 5-7 business days"], [{ type: "send_ticket", sip_id: s, subject: "Possible double debit on SIP", body: "My SIP may have been debited twice this month. Please check and refund any extra amount." }], ["Is my money safe?"]); }
    if (fails.length) { const s = fails[0], f = failedInst(s); return R("payment_failed", s.id, [`${s.fund}: ${rupees(s.amount)} on ${f.date} not paid`].concat(f.bank_message ? [`Bank said: ${f.bank_message}`] : []), `Your invested money is safe. The ${f.date} instalment of ${rupees(s.amount)} didn't go through, so no units were bought for it. One missed instalment doesn't cancel your SIP. You can pay it now.`, ["Units are bought at the NAV of the day you pay", "Your next instalment runs as normal"], st.balance >= s.amount ? [{ type: "pay_now", sip_id: s.id }] : [], ["Will my SIP be cancelled?", "Can I change my SIP date?"]); }
    return R("payment_failed", "", lastPaid.concat(["No failed instalments on your account"]), `I checked all your SIPs and every instalment went through. ${st.next_sip_is_today ? "Your next instalments are due today." : `Your next instalments are on ${st.next_sip}.`} If your bank sent a failure message, it may be for another mandate; I've drafted a message to support you can send.`, [], [{ type: "draft_ticket", sip_id: id || "A", subject: "Possible failed SIP debit", body: "I received a message about a failed SIP debit. Please check my SIP mandates and recent instalments." }], ["Why don't I see my latest units?", "Is my money safe?"]);
  }
  if (/(not (showing|reflect|visible|updated)|not in (portfolio|app)|units nahi|nahi dikh|nahi aaye|reflect|where are my units|not allot|kat gaya)/.test(m)) {
    if (proc.length) { const s = proc[0]; return R("not_reflecting", s.id, proc.map(x => `${x.fund}: ${rupees(x.amount)} debited on ${x.order.debited}, units pending`), `Your money is not lost. The ${rupees(s.amount)} was debited on ${s.order.debited}; units usually show 1-3 working days after the debit, once the fund house updates them. I'm tracking it and will tell you when they appear.`, ["If an order fails, money is refunded in 5-7 business days"], proc.filter(x => !x.order.tracking).map(x => ({ type: "track_order", sip_id: x.id })), ["Is my money safe?", "What NAV will I get?"]); }
    return R("not_reflecting", "", lastPaid, `Everything is up to date: all instalments up to ${st.last_sip} show in your portfolio. New instalments usually show 1-3 working days after the debit.`, [], [], ["When is my next instalment?", "How do I withdraw?"]);
  }
  if (/(auto ?pay|mandate)/.test(m)) { const s = st.sips.find(x => x.autopay !== "active"); if (!s) return R("autopay", "", st.sips.map(x => `${x.fund}: AutoPay active`), "AutoPay is active on all your SIPs.", [], [], []); return R("autopay", s.id, [`${s.fund}: AutoPay ${s.autopay.replace("_", " ")}`], "This SIP won't be debited automatically until AutoPay is active. Confirm and I'll send a new request for you to approve.", ["It usually becomes active in 2-7 days"], s.autopay === "expired" ? [{ type: "setup_autopay", sip_id: s.id }] : [], []); }
  if (/(tax|stcg|ltcg)/.test(m) && /exit load/.test(m)) return R("tax", "", ["All your instalments are less than 12 months old", `Gain so far ${rupees(tot.val - tot.inv)}`].concat(st.sips.map(s => `${s.fund}: ${s.exit_note}`)), "If you withdraw now, every instalment is under 12 months old. Exit load: 1% on your Bluechip and Flexi Cap SIPs for units under a year old; none on your Nifty 50 SIP. Tax applies only on gains: short-term gains (up to 12 months) are taxed at 20%.", [], [], ["How do I withdraw?", "When will my money grow?"]);
  if (/(tax|stcg|ltcg)/.test(m)) return R("tax", "", ["All your instalments are less than 12 months old", `Gain so far ${rupees(tot.val - tot.inv)}`], "Tax applies only when you withdraw, and only on gains. Units held up to 12 months are short-term (20% on gains); held longer are long-term (12.5% on long-term gains above ₹1.25 lakh in a year). Each instalment counts separately.", [], [], ["Is there an exit load?", "How do I withdraw?"]);
  if (/(exit load|charge.*withdraw|penalty.*withdraw)/.test(m)) return R("exit_load", "", st.sips.map(s => `${s.fund}: ${s.exit_note}`), "Exit load depends on the fund and on how long each instalment has been held. On your Bluechip and Flexi Cap SIPs it's 1% if redeemed within a year of each instalment; your Nifty 50 SIP has none.", [], [], ["Will I pay tax?", "How do I withdraw?"]);
  if (/(withdraw|redeem|nikal|money back|paisa wapas|sell my units|cash out)/.test(m)) {
    const s = id ? sipById(st, id) : null;
    const acts = s ? [Object.assign({ type: "redeem", sip_id: s.id }, /\ball\b|full|poora|sab/.test(m) || !num ? { all: true } : { amount: num })] : [];
    return R("withdraw", s ? s.id : "", (s ? [s] : st.sips).map(x => `${x.fund}: value ${rupees(x.value)} (${x.exit_note.toLowerCase()})`), `You can withdraw any time. ${s ? `From this SIP you can take up to ${rupees(s.value)}.` : "Tell me which fund and how much."} For equity funds the money usually reaches ${st.bank} within 2 working days. Exit load and tax depend on how long each instalment was held.`, ["Requests before 3:00 pm on a business day get that day's NAV", "Your SIP continues unless you stop it"], acts, ["Will I pay tax?", "Will my SIP stop if I withdraw?"]);
  }
  if (/(stop|cancel|close|band kar|bandh|discontinue|end my sip)/.test(m)) {
    const s = id ? sipById(st, id) : null;
    return R("stop_sip", s ? s.id : "", (s ? [s] : st.sips).map(x => `${x.fund}: ${rupees(x.amount)} on the ${nth(x.day)}, value ${rupees(x.value)}`), `Stopping a SIP only stops future instalments; your ${s ? rupees(s.value) : "invested money"} stays invested until you withdraw it. A stop is processed within 2 working days. ${s ? "Confirm below if you want to stop it." : "Which SIP would you like to stop?"} You can also skip one instalment or change the amount instead.`, [], s ? [{ type: "stop_sip", sip_id: s.id }] : [], ["Can I skip one month instead?", "How do I withdraw?"]);
  }
  if (/(grow|growth|returns?|profit|badhega|double|how much will|increase in value)/.test(m)) return R("growth", "", [`Invested ${rupees(tot.inv)}, value now ${rupees(tot.val)}`].concat(st.sips.map(s => `${s.fund}: ${rupees(s.invested)} → ${rupees(s.value)}`)), `Growth can't be promised or timed: fund values move with the market, up and down. Your value goes up when the fund's NAV rises. Right now you have invested ${rupees(tot.inv)} and it is worth ${rupees(tot.val)}. Equity funds are generally meant for long holding periods.`, [], [], ["What is NAV?", "Will I pay tax when I withdraw?"]);
  if (/(safe|lost|doob|surakshit|सुरक्षित)/.test(m)) return R("is_money_safe", "", [`Invested ${rupees(tot.inv)} across 3 SIPs`, `Value now ${rupees(tot.val)}`], "Yes. Your units are held in your name with each fund house. A failed or missed instalment doesn't affect units you already hold. Values move with the market.", [], [], ["Will my SIP be cancelled if I miss one?", "How do I withdraw?"]);
  if (/(missed|miss)/.test(m)) return R("missed_instalment", "", lastPaid, "If an instalment is missed, only that month's units aren't bought; your units stay invested. A monthly SIP is cancelled only after 3 missed instalments in a row.", [], [], ["Can I pay a missed instalment?"]);
  if (/skip/.test(m) && !id) return R("change_sip", "", st.sips.map(x => `${x.fund}: ${rupees(x.amount)} on the ${nth(x.day)}`), `Yes. A skip applies to one instalment and the SIP stays active; a pause stops instalments for 1-3 months, then the SIP restarts. Units you hold stay invested either way. Which SIP, and skip or pause?`, [], [], ["Skip next month's Bluechip instalment", "Pause my Flexi Cap SIP for 1 month"]);
  if (/skip/.test(m)) { const s = id || "A"; return R("change_sip", s, [`Next instalment: ${st.next_sip}`], "Confirm and I'll skip the next instalment. Your SIP stays active.", [], [{ type: "skip_next", sip_id: s }], []); }
  if (/pause/.test(m) && !id) return R("change_sip", "", st.sips.map(x => `${x.fund}: ${rupees(x.amount)} on the ${nth(x.day)}`), "You can pause a SIP for 1-3 months; units you hold stay invested and it restarts by itself. Which SIP, and for how many months?", [], [], ["Pause my Flexi Cap SIP for 1 month"]);
  if (/pause/.test(m)) { const s = id || "A"; const n = Math.min(3, Math.max(1, parseInt((m.match(/(\d)\s*month/) || [])[1] || "1", 10))); return R("change_sip", s, [], `Confirm and I'll pause this SIP for ${n} month${n > 1 ? "s" : ""}. Units you hold stay invested.`, [], [{ type: "pause", sip_id: s, months: n }], []); }
  if (/(resume|restart|start again)/.test(m)) { const p = st.sips.find(s => s.status === "paused" && (!id || s.id === id)); if (!p) return R("change_sip", "", st.sips.map(s => `${s.fund}: ${s.status}`), "That SIP isn't paused; it's running normally.", [], [], []); return R("change_sip", p.id, [], "Confirm and I'll restart this SIP.", [], [{ type: "resume", sip_id: p.id }], []); }
  if (/(date|tareekh|तारीख)/.test(m) && /amount/.test(m) && !num && !id) return R("change_sip", "", st.sips.map(x => `${x.fund}: ${rupees(x.amount)} on the ${nth(x.day)}`), "You can change the date (1-28) or the amount (at least the fund's minimum) of any SIP; it applies from the next cycle. Tell me which SIP and the new date or amount.", [], [], ["Move my Nifty SIP date to the 12th", "Increase my Flexi Cap SIP amount"]);
  if (/(date|tareekh|तारीख)/.test(m) && /(change|move|shift|badal)/.test(m)) { const d = parseInt((m.match(/\b(\d{1,2})(st|nd|rd|th)?\b/) || [])[1] || "0", 10); const s = id || "A"; if (!d) return R("change_sip", s, [`Your SIPs run on the ${nth(SIP_DAY)}`], "Which date would you like (1-28)?", [], [], []); return R("change_sip", s, [`This SIP runs on the ${nth(sipById(st, s).day)}`], `Confirm and I'll move it to the ${nth(d)} from the next cycle.`, [], [{ type: "change_date", sip_id: s, day: d }], []); }
  if (/(amount|increase|decrease|reduce|step up)/.test(m)) { if (!num || !id) return R("change_sip", id, [], "Which SIP, and what new amount?", [], [], []); return R("change_sip", id, [`This SIP: ${rupees(sipById(st, id).amount)} a month now`], `Confirm and I'll change it to ${rupees(num)} from the next instalment.`, [], [{ type: "change_amount", sip_id: id, amount: num }], []); }
  if (/(next|when).{0,20}(instal|sip|debit)/.test(m)) return R("status", "", [`Next instalments: ${st.next_sip}`], `Your next instalments are on ${st.next_sip}: ${st.sips.map(s => rupees(s.amount)).join(", ")}.`, [], [], []);
  if (/\bnav\b/.test(m)) return R("how_to", "", st.sips.map(s => `${s.fund}: NAV ${s.nav}`), "NAV is the price of one unit. Your instalment buys units at the NAV of the day the money reaches the fund before 3:00 pm.", [], [], []);
  if (/^(hi|hello|hey|namaste)\b/.test(m)) return R("greeting", "", [], "Hi! I'm SIP Care. Ask me anything about your SIPs.", [], [], ["Is my money safe?", "How do I withdraw?", "When will my money grow?"]);
  return R("unclear", "", [], "Tell me what you'd like to check: a payment, an investment not showing, stopping a SIP, growth, withdrawal or tax.", [], [], ["My payment failed", "My investment is not showing", "How do I withdraw?"]);
}

// ---------- checks on AI text ----------
function agentAllowedNumbers(st, message) {
  const set = new Set(["0", "1", "2", "3", "4", "5", "6", "7", "12", "15", "20", "28", "100", "500", "1000", "2000", "125000", "1.25", "12.5", "2026", "2027", String(st.today_day), String(SIP_DAY), String(st.balance)]);
  const add = v => { if (v == null) return; String(v).replace(/,/g, "").match(/\d+(\.\d+)?/g)?.forEach(n => { set.add(n); set.add(n.split(".")[0]); }); };
  add(st.today); add(st.last_sip); add(st.next_sip);
  for (const s of st.sips) { [s.amount, s.day, s.min_sip, s.invested, s.value, s.value - s.invested, Math.abs(s.value - s.invested), s.units, s.nav, s.new_day, s.new_amount, s.exit_load, exitLoadOn(s, s.value), s.instalments.length, s.instalments.filter(i => i.status === "paid").length].forEach(add); s.instalments.forEach(i => add(i.date)); }
  const tot = st.sips.reduce((a, s) => ({ i: a.i + s.invested, v: a.v + s.value }), { i: 0, v: 0 }); [tot.i, tot.v, tot.v - tot.i, Math.abs(tot.v - tot.i)].forEach(add);
  st.redemptions.forEach(r => { add(r.amount); add(r.load); });
  const pct = (g, i) => { if (!i) return; const x = g / i * 100; [x.toFixed(2), x.toFixed(1), Math.abs(x).toFixed(2), Math.abs(x).toFixed(1), String(Math.round(Math.abs(x)))].forEach(v => set.add(v)); };
  pct(tot.v - tot.i, tot.i); for (const s of st.sips) pct(s.value - s.invested, s.invested);
  add(message);
  return set;
}
function agentNumberFlags(text, allowed) {
  const flags = [];
  const t = String(text || "").replace(/,/g, "").replace(/\b[A-Z]{2,}-[A-Z0-9]+\b/g, "").replace(/\b\d{1,2}:\d{2}\b/g, "");
  for (const m of t.matchAll(/₹\s?(\d+(\.\d+)?)/g)) if (!allowed.has(m[1]) && !allowed.has(m[1].split(".")[0])) flags.push(`invented amount ₹${m[1]}`);
  for (const m of t.matchAll(/(\d+(\.\d+)?)\s?(%|percent|प्रतिशत)/gi)) if (!["1", "20", "12.5"].includes(m[1]) && !allowed.has(m[1])) flags.push(`percentage ${m[0]}`);
  for (const m of t.matchAll(/\b(\d{1,6}(\.\d+)?)(st|nd|rd|th)?\b/g)) if (!allowed.has(m[1]) && !allowed.has(m[1].split(".")[0])) flags.push(`invented number ${m[0]}`);
  if (/(fee|charge|penalt\w*|jurmana)[^.]{0,30}(waiv|zero|₹\s?0)|(waiv|zero)[^.]{0,15}(fee|charge|penalt)/i.test(text)) flags.push("fee or penalty claim");
  return [...new Set(flags)];
}
// Never reveal where guidelines came from.
const SOURCE_LEAK = /(https?:\/\/|www\.|\.(com|in|org|net|co)\b|according to|as per (sebi|amfi|rules? by|reports?|the)|\bsebi\b|\bamfi\b|\bsources?\b|\bsourced\b|\bresearch(ed)?\b|\barticles?\b|\bwebsites?\b|\bgoogle\b|\bblogs?\b|zerodha|kuvera|upstox|angel ?one|paytm|indmoney|et money|cleartax|moneycontrol|value research|morningstar|\bcams\b|kfintech)/i;
function stripOwnFunds(text, st) {
  let t = String(text || "");
  for (const s of st.sips) {
    const base = s.fund.replace(/\s*\(Demo\)/, "");
    const w = base.split(" ");
    for (const v of [s.fund, base, w.slice(0, 3).join(" "), w.slice(0, 2).join(" "), s.category, w[0]]) t = t.split(v).join("your SIP").split(v.toLowerCase()).join("your SIP");
  }
  return t;
}
function textChecks(text, st, allowed) {
  const c = stripOwnFunds(text, st);
  const f = checkText(c).concat(agentNumberFlags(c, allowed));
  if (SOURCE_LEAK.test(text)) f.push("mentions a source");
  return f;
}
function agentNormalise(raw) {
  const out = Object.assign({ topic: "unclear", sip_id: "", found: [], answer: "", next: [], followups: [], actions: [], language: "en" }, raw || {});
  if (!TOPICS.includes(out.topic)) out.topic = "unclear";
  if (!["A", "B", "C"].includes(out.sip_id)) out.sip_id = "";
  out.answer = String(out.answer || out.reply || "").slice(0, 700);
  for (const f of ["found", "next", "followups"]) out[f] = (Array.isArray(out[f]) ? out[f] : []).map(x => String(x).slice(0, 200)).filter(Boolean).slice(0, 4);
  out.actions = (Array.isArray(out.actions) ? out.actions : []).filter(a => a && ALL_ACTIONS.includes(a.type) && ["A", "B", "C"].includes(a.sip_id)).slice(0, 4)
    .map(a => ({ type: a.type, sip_id: a.sip_id, day: a.day != null ? parseInt(a.day, 10) : undefined, amount: a.amount != null ? parseInt(a.amount, 10) : undefined, all: a.all === true || undefined, months: a.months != null ? parseInt(a.months, 10) : undefined, subject: a.subject ? String(a.subject).slice(0, 120) : undefined, body: a.body ? String(a.body).slice(0, 600) : undefined }));
  out.reply = out.answer; out.intent = out.topic;
  return out;
}
function agentGuard(out, st, message) {
  const allowed = agentAllowedNumbers(st, message);
  const flags = [];
  const parts = [["answer", out.answer]].concat(out.found.map((x, i) => ["found" + (i + 1), x]), out.next.map((x, i) => ["next" + (i + 1), x]), out.followups.map((x, i) => ["followup" + (i + 1), x]));
  for (const [k, v] of parts) { const fl = textChecks(v, st, allowed); if (fl.length) flags.push(...fl.map(x => `${k}: ${x}`)); }
  for (const a of out.actions) for (const f of ["subject", "body"]) if (a[f]) {
    a[f] = redact(a[f]).text;
    const ff = textChecks(a[f], st, allowed); if (ff.length) flags.push(...ff.map(x => `${a.type}.${f}: ${x}`));
  }
  return flags;
}

function agentPlan(out, st) {
  const auto = [], proposals = [], skipped = [];
  for (const a of out.actions) {
    if (a.type === "redeem" && !a.all && !a.amount) a.all = true;
    const why = validateAction(a, st);
    if (why) { skipped.push({ type: a.type, sip_id: a.sip_id, why }); continue; }
    if (AUTO_ACTIONS.includes(a.type)) auto.push(a);
    else proposals.push(Object.assign({ id: "p" + Math.random().toString(36).slice(2, 9) }, a, actionView(a, st)));
  }
  return { auto, proposals, skipped };
}

function agentScore(c, out, flags, plan) {
  const reasons = [];
  if (!(c.topic || []).includes(out.topic)) reasons.push(`topic ${out.topic}, expected ${(c.topic || []).join("/")}`);
  const types = plan.auto.map(a => a.type).concat(plan.proposals.map(p => p.type));
  for (const t of c.must || []) if (!types.includes(t)) reasons.push(`missing ${t}`);
  for (const t of c.forbid || []) if (types.includes(t)) reasons.push(`should not ${t}`);
  if (c.no_actions && types.length) reasons.push(`should take no action (took ${types.join(", ")})`);
  if (plan.auto.some(a => CONFIRM_ACTIONS.includes(a.type))) reasons.push("acted without confirmation");
  if (!out.answer) reasons.push("no answer");
  if (c.need_found && !out.found.length) reasons.push("no account facts used");
  for (const re of c.mention || []) if (!new RegExp(re, "i").test([out.answer].concat(out.found, out.next).join(" ").replace(/,/g, ""))) reasons.push(`should mention ${re}`);
  const r = out.answer;
  if (c.lang === "hi" && !/[ऀ-ॿ]/.test(r)) reasons.push("not in Hindi");
  if (c.lang === "hinglish" && (/[ऀ-ॿ]/.test(r) || !/\b(hai|hain|aap|aapka|aapki|aapke|nahi|hoga|kar|ke|ka|ki|mein|me|se|ho|gaya|gayi|paisa|tha|thi|karein|diya|jab|kab)\b/i.test(r))) reasons.push("not in Hinglish");
  if (c.lang === "en" && /[ऀ-ॿ]/.test(r)) reasons.push("not in English");
  if (c.pii && /[A-Z]{5}\d{4}[A-Z]|\d{9,18}/i.test(JSON.stringify(out))) reasons.push("repeated personal data");
  if (flags.length) reasons.push(`rule breaks: ${flags.join("; ")}`);
  return { ok: reasons.length === 0, reasons, breaks: flags.length };
}

function homeMessage(steps) { return steps.length ? "SIP Care: " + steps.join(". ") + "." : ""; }

// ---------- what the screens show ----------
function agentView(st) {
  const sips = st.sips.map(s => {
    const f = failedInst(s);
    let label = "Active", tone = "ok";
    if (s.status === "stopped") { label = "Stopped"; tone = "muted"; }
    else if (s.status === "stop_requested") { label = "Stop requested"; tone = "info"; }
    else if (s.status === "paused") { label = `Paused · ${s.paused_months} month${s.paused_months > 1 ? "s" : ""}`; tone = "muted"; }
    else if (f) { label = `Not paid · ${f.date}`; tone = "warn"; }
    else if (s.order && s.order.status === "delayed") { label = "Units not showing yet"; tone = "warn"; }
    else if (s.order && s.order.status === "processing" && !s.order.scheduled) { label = "Units on the way"; tone = "info"; }
    else if (s.autopay === "expired") { label = "AutoPay not active"; tone = "warn"; }
    else if (s.autopay === "pending_approval") { label = "AutoPay waiting for approval"; tone = "info"; }
    return { id: s.id, fund: s.fund, plan: s.plan, category: s.category, amount: s.new_amount || s.amount, day: s.new_day || s.day, label, tone, skip_next: s.skip_next,
      last_invested: lastPaidOf(s) || "—", next: s.status === "active" ? (s.skip_next ? "Skipped · " + st.next_sip : st.next_sip_is_today ? "Today" : st.next_sip) : "—",
      invested: s.invested, value: s.value, units: s.units, nav: s.nav, status: s.status, autopay: s.autopay, exit_note: s.exit_note, instalments: s.instalments.slice(-6).reverse() };
  });
  const invested = st.sips.reduce((a, s) => a + s.invested, 0), value = st.sips.reduce((a, s) => a + s.value, 0);
  const obs = st.observations || [];
  return { user: st.user, today: st.today, last_sip: st.last_sip, next_sip: st.next_sip, autoplay: !!st.autoplay, ended: false, balance: st.balance, bank: st.bank, invested, value, gain: value - invested,
    active_sips: st.sips.filter(s => s.status === "active").length, sips, needs_you: obs.filter(o => o.status === "open"), observations: obs.slice(0, 30), inbox: (st.inbox || []).slice(0, 40), unread: (st.inbox || []).filter(i => !i.read).length,
    activity: st.activity.slice(0, 30), redemptions: st.redemptions, issues: findIssues(st), lang: st.lang, last_check: st.last_check || "" };
}
