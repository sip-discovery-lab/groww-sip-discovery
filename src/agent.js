// SIP Care agent: reads a demo SIP account, decides what to do, acts alone only where safe,
// and asks the user to confirm anything that moves money or changes a SIP.
const AGENT_VERSION = "agent-v1";
const AGENT_LANGS = ["en", "hinglish", "hi"];

// Actions the agent may take on its own (no money moves, nothing changes on the SIP).
const AUTO_ACTIONS = ["set_reminder", "track_order", "draft_ticket"];
// Actions that always need the user's Confirm.
const CONFIRM_ACTIONS = ["pay_now", "schedule_retry", "change_date", "change_amount", "skip_next", "pause", "resume", "setup_autopay", "send_ticket", "stop_sip"];
const ALL_ACTIONS = AUTO_ACTIONS.concat(CONFIRM_ACTIONS);
const INTENTS = ["fix_issue", "pay_missed", "retry", "change_date", "change_amount", "skip", "pause", "resume", "autopay", "money_stuck", "refund_or_duplicate", "is_money_safe", "will_sip_cancel", "stop_sip", "status", "out_of_scope", "unclear", "greeting"];

function demoState() {
  return {
    user: "Riya", today_day: 6, month: "Nov", next_month: "Dec", salary_day: 7, bank: "Account ••12",
    sips: [
      { id: "A", fund: "Bluechip Equity Fund (Demo)", plan: "Direct Growth", amount: 1000, day: 3, min_sip: 500, started: "Aug 2026", autopay: "active", status: "active", skip_next: false, paused_months: 0, retry_day: null, new_day: null,
        instalments: [{ date: "3 Aug", status: "paid" }, { date: "3 Sep", status: "paid" }, { date: "3 Oct", status: "paid" }, { date: "3 Nov", status: "failed", bank_message: "NACH debit returned: Balance insufficient (reason code 01)" }] },
      { id: "B", fund: "Flexi Cap Fund (Demo)", plan: "Direct Growth", amount: 2000, day: 5, min_sip: 500, started: "Sep 2026", autopay: "active", status: "active", skip_next: false, paused_months: 0, retry_day: null, new_day: null,
        instalments: [{ date: "5 Sep", status: "paid" }, { date: "5 Oct", status: "paid" }, { date: "5 Nov", status: "processing" }],
        order: { id: "SIP-20261105-0042", status: "processing", debited: "5 Nov", expected_by: 8 } },
      { id: "C", fund: "Nifty 50 Index Fund (Demo)", plan: "Direct Growth", amount: 500, day: 10, min_sip: 100, started: "Oct 2026", autopay: "not_approved", status: "active", skip_next: false, paused_months: 0, retry_day: null, new_day: null,
        instalments: [{ date: "10 Oct", status: "paid" }] },
    ],
    reminders: [], tickets: [], drafts: [], activity: [], resolved: [],
  };
}

const rupees = n => "₹" + Number(n).toLocaleString("en-IN");
const nth = n => n + (n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th");
const sipById = (st, id) => st.sips.find(s => s.id === id);
const failedInst = s => (s.instalments || []).find(i => i.status === "failed");

// Problems the agent finds on its own when it scans the account.
function findIssues(st) {
  const out = [];
  for (const s of st.sips) {
    if (s.status === "stopped") continue;
    const f = failedInst(s);
    if (f && !s.retry_day) out.push({ sip_id: s.id, kind: "failed", title: `${f.date} instalment not paid`, line: `${s.fund} · ${rupees(s.amount)}`, label: `Not paid · ${f.date}` });
    if (s.order && s.order.status === "processing") out.push({ sip_id: s.id, kind: "processing", title: "Units not allotted yet", line: `${s.fund} · ${rupees(s.amount)} debited ${s.order.debited}`, label: "In progress" });
    if (s.autopay === "not_approved") out.push({ sip_id: s.id, kind: "autopay", title: "AutoPay not active", line: `${s.fund} · next instalment ${s.day} ${st.month}`, label: "AutoPay not active" });
  }
  return out;
}

function snapshot(st) {
  return {
    today: `${st.today_day} ${st.month}`, salary_day: st.salary_day, bank: st.bank,
    sips: st.sips.map(s => ({ id: s.id, fund: s.fund, amount: s.amount, sip_day: s.day, min_sip: s.min_sip, autopay: s.autopay, status: s.status, skip_next: s.skip_next, paused_months: s.paused_months, retry_day: s.retry_day, new_day: s.new_day,
      last_instalments: s.instalments.slice(-3), order: s.order || null })),
    open_issues: findIssues(st).map(i => `${i.sip_id}: ${i.title}`),
    reminders: st.reminders.map(r => r.text), tickets: st.tickets.map(t => t.subject),
  };
}

function agentSystemPrompt() {
  return `You are SIP Care, an AI agent inside a Groww-style mutual fund app (a concept prototype with demo data). You help a first-time investor with ANY problem about their SIPs: failed or missed instalments, money debited but no units, AutoPay, changing date or amount, skipping, pausing, resuming, stopping, refunds, duplicate debits and worries ("is my money safe?", "will my SIP be cancelled?").
You see the user's account (JSON) and their message. Decide what is going on and what to do.

ACTIONS YOU CAN TAKE
Automatic (you may do these yourself; nothing changes on a SIP and no money moves):
- set_reminder {sip_id, day}: remind the user on a day this month.
- track_order {sip_id}: keep watching a processing order.
- draft_ticket {sip_id, subject, body}: prepare a support message (no personal data).
Need the user's confirmation (propose them; the app will ask the user to confirm before anything happens):
- pay_now {sip_id}: pay a missed instalment, or pay the next one manually when AutoPay is not active.
- schedule_retry {sip_id, day}: retry a failed instalment later this month, e.g. on salary day.
- change_date {sip_id, day}: move the monthly SIP date (1-28).
- change_amount {sip_id, amount}: change the SIP amount (at least the fund's min_sip, multiple of 100).
- skip_next {sip_id}: skip the next instalment; SIP stays active.
- pause {sip_id, months}: pause for 1-3 months.
- resume {sip_id}: restart a paused SIP.
- setup_autopay {sip_id}: send a new AutoPay request to the user's UPI/bank app.
- send_ticket {sip_id, subject, body}: send a support ticket.
- stop_sip {sip_id}: stop future instalments (units already held stay invested). Only if the user clearly asks to stop or cancel; never suggest it yourself.

HOW TO DECIDE
- Message "__fix__:X" means the user tapped "Fix" on SIP X: diagnose that SIP's open issue and propose the fix.
- Failed instalment with insufficient balance and salary_day after the SIP day -> schedule_retry on salary_day (if after today) AND change_date to salary_day + 2.
- Failed instalment with insufficient balance otherwise -> pay_now (and optionally set_reminder).
- Failed instalment because of mandate/AutoPay -> setup_autopay (+ pay_now).
- Order processing (money debited, units not shown) -> track_order and set_reminder for the expected day; offer send_ticket only if the user asks for support or it's past the expected day.
- AutoPay not approved -> setup_autopay, and set_reminder for the day before the SIP date.
- Requests to change date/amount/skip/pause/resume/stop -> propose exactly that action for the SIP they mean. If the SIP or the number is unclear, ask ONE short question and propose no action.
- Questions only ("is my money safe?", "will it be cancelled?") -> answer, no action.
- Anything about choosing funds, returns, selling units, taxes or stocks -> out_of_scope, answer politely that you only help with SIP payments and changes, no action.
- Never propose resume for a SIP that isn't paused, or retry for a SIP without a failed instalment.

FACTS YOU MAY USE (do not add others)
- Money already invested stays invested; a failed instalment does not affect units held.
- The fund house charges no penalty for a failed instalment; the bank may charge its own bounce fee.
- A monthly SIP is usually cancelled only after 3 failed instalments in a row; one successful payment resets this.
- If money was debited but the order fails, it returns to the bank in 5-7 business days.
- Units usually show 1-3 working days after payment.
- Paying a missed instalment yourself buys units at that day's price.
- A new AutoPay usually takes 2-7 days to become active.
- Stopping a SIP only stops future instalments; units held stay invested.

WRITING RULES (breaking any is a failure)
- reply: 1-3 short, calm sentences in the user's language: what you found, what you did automatically, and what you need them to confirm. Start with reassurance if something went wrong.
- Use only numbers that appear in the account, the facts or the user's message. Never invent fees, waivers, times, percentages or guarantees. Never say a fee is waived or there is zero penalty.
- Never recommend, name or compare funds other than the user's own SIPs. Never predict returns or markets.
- No fear or urgency words (immediately, urgent, hurry, last chance, you will lose, turant, jaldi).
- Never ask for PAN, account numbers, OTP, PIN or screenshots. If the user shared such data, tell them not to.
- Language: en = English; hinglish = Hindi in Latin script; hi = Hindi in Devanagari. Use the requested language; if the user writes in another of these, reply in theirs.
Return only JSON matching the schema.`;
}

const AGENT_SCHEMA = {
  type: "OBJECT",
  properties: {
    intent: { type: "STRING", enum: INTENTS },
    sip_id: { type: "STRING", enum: ["A", "B", "C", ""] },
    reply: { type: "STRING" },
    language: { type: "STRING", enum: AGENT_LANGS },
    actions: { type: "ARRAY", items: { type: "OBJECT", properties: {
      type: { type: "STRING", enum: ALL_ACTIONS }, sip_id: { type: "STRING", enum: ["A", "B", "C"] },
      day: { type: "INTEGER" }, amount: { type: "INTEGER" }, months: { type: "INTEGER" }, subject: { type: "STRING" }, body: { type: "STRING" },
    }, required: ["type", "sip_id"] } },
  },
  required: ["intent", "reply", "actions"],
};

function agentUserPrompt(st, message, lang, history) {
  const h = (history || []).slice(-6).map(x => `${x.role === "user" ? "User" : "SIP Care"}: ${x.text}`).join("\n");
  return `Requested language: ${lang}\nAccount (today is ${st.today_day} ${st.month}):\n${JSON.stringify(snapshot(st))}\n${h ? "Recent conversation:\n" + h + "\n" : ""}User message: """${message}"""`;
}

// ---------- validation and execution ----------
function validateAction(a, st) {
  const s = sipById(st, a.sip_id);
  if (!s) return "unknown SIP";
  if (s.status === "stopped" && a.type !== "draft_ticket") return "this SIP is stopped";
  switch (a.type) {
    case "pay_now": if (!failedInst(s) && s.autopay === "active") return "nothing to pay right now"; return "";
    case "schedule_retry": if (!failedInst(s)) return "no failed instalment to retry"; if (!(a.day > st.today_day && a.day <= 28)) return "retry day must be later this month"; return "";
    case "change_date": if (!(a.day >= 1 && a.day <= 28)) return "SIP date must be between 1 and 28"; if (a.day === s.day) return "that's already the SIP date"; return "";
    case "change_amount": if (!(a.amount >= s.min_sip && a.amount % 100 === 0 && a.amount <= 100000)) return `amount must be at least ${rupees(s.min_sip)} in multiples of ₹100`; if (a.amount === s.amount) return "that's already the amount"; return "";
    case "skip_next": if (s.skip_next) return "next instalment is already skipped"; return "";
    case "pause": if (!(a.months >= 1 && a.months <= 3)) return "pause must be 1-3 months"; if (s.status === "paused") return "already paused"; return "";
    case "resume": if (s.status !== "paused") return "this SIP isn't paused"; return "";
    case "setup_autopay": if (s.autopay === "active") return "AutoPay is already active"; return "";
    case "track_order": if (!s.order || s.order.status !== "processing") return "no order in progress"; return "";
    case "set_reminder": if (!(a.day >= st.today_day && a.day <= 31)) return "reminder day must be from today"; return "";
    case "draft_ticket": case "send_ticket": return "";
    case "stop_sip": return "";
  }
  return "unknown action";
}

function actionView(a, st) {
  const s = sipById(st, a.sip_id), m = st.month;
  const row = [["SIP", s.fund], ["Bank", st.bank]];
  switch (a.type) {
    case "pay_now": { const f = failedInst(s); return { title: `Pay ${rupees(s.amount)} now`, summary: f ? `Pay the missed ${f.date} instalment of ${rupees(s.amount)} from ${st.bank}.` : `Pay this month's ${rupees(s.amount)} yourself from ${st.bank}.`, rows: [["Amount", rupees(s.amount)]].concat(row), note: "Units are bought at the price on the day you pay.", step: `Paid ${rupees(s.amount)} for ${s.fund}` }; }
    case "schedule_retry": return { title: `Retry ${rupees(s.amount)} on ${a.day} ${m}`, summary: `SIP Care will retry ${rupees(s.amount)} on ${a.day} ${m} from ${st.bank}.`, rows: [["Amount", rupees(s.amount)], ["Retry date", `${a.day} ${m}`]].concat(row), note: `Keep ${rupees(s.amount)} in this account on ${a.day} ${m}.`, step: `Scheduled a retry of ${rupees(s.amount)} on ${a.day} ${m}`, isNew: true };
    case "change_date": return { title: `Move SIP date to the ${nth(a.day)}`, summary: `From ${st.next_month}, ${s.fund} will run on the ${nth(a.day)} instead of the ${nth(s.day)}.`, rows: [["Current date", nth(s.day)], ["New date", `${nth(a.day)} from ${st.next_month}`]].concat(row), note: "", step: `Changed the SIP date to the ${nth(a.day)} from ${st.next_month}` };
    case "change_amount": return { title: `Change amount to ${rupees(a.amount)}`, summary: `From ${st.next_month}, ${s.fund} will be ${rupees(a.amount)} instead of ${rupees(s.amount)}.`, rows: [["Current amount", rupees(s.amount)], ["New amount", rupees(a.amount)]].concat(row), note: "You can change it again anytime.", step: `Changed the SIP amount to ${rupees(a.amount)}` };
    case "skip_next": return { title: "Skip the next instalment", summary: `Skip the next ${rupees(s.amount)} instalment. Your SIP stays active.`, rows: [["Skipped", `Next instalment (${nth(s.day)})`]].concat(row), note: "", step: "Skipped the next instalment; SIP stays active" };
    case "pause": return { title: `Pause for ${a.months} month${a.months > 1 ? "s" : ""}`, summary: `No instalments for ${a.months} month${a.months > 1 ? "s" : ""}, then your SIP restarts.`, rows: [["Pause", `${a.months} month${a.months > 1 ? "s" : ""}`]].concat(row), note: "Units you hold stay invested.", step: `Paused the SIP for ${a.months} month${a.months > 1 ? "s" : ""}` };
    case "resume": return { title: "Restart this SIP", summary: `Restart ${s.fund} from the next ${nth(s.day)}.`, rows: row, note: "", step: "Restarted the SIP" };
    case "setup_autopay": return { title: "Set up AutoPay again", summary: `Send a new AutoPay request for ${s.fund} to your UPI or bank app.`, rows: row, note: "Approve it in your app. It usually takes 2-7 days to become active.", step: "Sent a new AutoPay request to your UPI app" };
    case "send_ticket": return { title: "Send to support", summary: a.subject || "Support request", rows: [["Message", (a.body || "").slice(0, 160)]], note: "No personal details are shared.", step: "Sent your message to support" };
    case "stop_sip": return { title: "Stop this SIP", summary: `Stop future instalments of ${s.fund}.`, rows: row, note: "Units you hold stay invested until you choose to sell them.", step: "Stopped future instalments", danger: true };
    case "set_reminder": return { title: `Reminder on ${a.day} ${m}`, step: `Set a reminder for ${a.day} ${m}` };
    case "track_order": return { title: "Tracking your order", step: `Tracking order ${s.order ? s.order.id : ""}; units expected by ${s.order ? s.order.expected_by : ""} ${m}` };
    case "draft_ticket": return { title: "Support message drafted", step: "Drafted a support message (no personal details)" };
  }
  return { title: a.type, step: a.type };
}

function applyAction(a, st) {
  const s = sipById(st, a.sip_id);
  const view = actionView(a, st);
  switch (a.type) {
    case "pay_now": { const f = failedInst(s); if (f) { f.status = "paid"; f.note = "paid manually"; } else s.next_manual = true; break; }
    case "schedule_retry": s.retry_day = a.day; break;
    case "change_date": s.new_day = a.day; break;
    case "change_amount": s.new_amount = a.amount; break;
    case "skip_next": s.skip_next = true; break;
    case "pause": s.status = "paused"; s.paused_months = a.months; break;
    case "resume": s.status = "active"; s.paused_months = 0; break;
    case "setup_autopay": s.autopay = "pending_approval"; break;
    case "send_ticket": st.tickets.push({ sip_id: s.id, subject: a.subject || "Support request", body: a.body || "" }); break;
    case "stop_sip": s.status = "stopped"; break;
    case "set_reminder": st.reminders.push({ sip_id: s.id, day: a.day, text: `Reminder for ${s.fund} on ${a.day} ${st.month}` }); break;
    case "track_order": if (s.order) s.order.tracking = true; break;
    case "draft_ticket": st.drafts.push({ sip_id: s.id, subject: a.subject || "Support request", body: a.body || "" }); break;
  }
  st.activity.unshift({ text: view.step, sip_id: s.id, type: a.type, auto: AUTO_ACTIONS.includes(a.type) });
  return view.step;
}

// ---------- rule-based fallback (AI off, AI down, or AI answer unsafe) ----------
function agentRules(message, st) {
  const m = String(message || "").toLowerCase();
  const fix = m.match(/^__fix__:([abc])$/);
  const pick = () => { const id = (m.match(/\b(bluechip|flexi|nifty|index)\b/) || [])[1]; return id === "bluechip" ? "A" : id === "flexi" ? "B" : id ? "C" : ""; };
  const reply = (intent, sip_id, text, actions) => ({ intent, sip_id, reply: text, actions: actions || [], language: "en" });
  const sipFix = id => {
    const s = sipById(st, id);
    if (failedInst(s) && !s.retry_day) {
      if (st.salary_day > s.day && st.salary_day > st.today_day) return reply("fix_issue", id, `Your invested money is safe. Your ${failedInst(s).date} instalment failed because the balance was short: your salary comes on the ${nth(st.salary_day)} but this SIP runs on the ${nth(s.day)}. Confirm and I'll retry on ${st.salary_day} ${st.month} and move the SIP date to the ${nth(Math.min(28, st.salary_day + 2))}.`, [{ type: "schedule_retry", sip_id: id, day: st.salary_day }, { type: "change_date", sip_id: id, day: Math.min(28, st.salary_day + 2) }]);
      return reply("fix_issue", id, "Your invested money is safe. This instalment didn't go through. You can pay it now; confirm and I'll set it up.", [{ type: "pay_now", sip_id: id }]);
    }
    if (s.order && s.order.status === "processing") return reply("money_stuck", id, `Your ${rupees(s.amount)} is not lost. The order was placed on ${s.order.debited} and units usually show in 1-3 working days. I'm tracking it and will remind you on ${s.order.expected_by} ${st.month}.`, [{ type: "track_order", sip_id: id }, { type: "set_reminder", sip_id: id, day: s.order.expected_by }]);
    if (s.autopay === "not_approved") return reply("autopay", id, `Your invested money is safe. AutoPay for this SIP isn't active, so the ${s.day} ${st.month} instalment won't run by itself. Confirm and I'll send a new AutoPay request; I've set a reminder for the day before.`, [{ type: "set_reminder", sip_id: id, day: s.day - 1 }, { type: "setup_autopay", sip_id: id }]);
    const f = failedInst(s);
    if (f && s.retry_day) return reply("status", id, `Your invested money is safe. The ${f.date} instalment of ${rupees(s.amount)} will be retried on ${s.retry_day} ${st.month}${s.new_day ? `, and from ${st.next_month} this SIP runs on the ${nth(s.new_day)}` : ""}.`, []);
    if (s.autopay === "pending_approval") return reply("autopay", id, "A new AutoPay request was sent. Please approve it in your UPI or bank app; it usually takes 2-7 days to become active.", []);
    return reply("status", id, "This SIP has no open issue. Everything looks on track.", []);
  };
  if (fix) return sipFix(fix[1].toUpperCase());
  if (/(which|best|better|recommend).{0,20}fund|returns?|sell|redeem|tax|stock/.test(m)) return reply("out_of_scope", "", "I can only help with your SIP payments and changes, like failed instalments, AutoPay, dates and amounts. I can't suggest funds or returns.", []);
  if (/(safe|lost|doob|gaya kya)/.test(m) && !/kat|debit/.test(m)) return reply("is_money_safe", "", "Yes. Money you already invested stays invested; a failed instalment doesn't affect the units you hold.", []);
  if (/cancel(l)?ed|band ho jayega|will .*cancel/.test(m) && !/i want|please cancel/.test(m)) return reply("will_sip_cancel", "", "No. One failed instalment doesn't cancel a SIP; it's usually cancelled only after 3 failures in a row, and one successful payment resets that.", []);
  if (/stop|cancel|band kar/.test(m)) { const id = pick() || "A"; return reply("stop_sip", id, "I can stop future instalments for this SIP. Units you hold stay invested. Please confirm if you want this.", [{ type: "stop_sip", sip_id: id }]); }
  if (/auto ?pay|mandate/.test(m)) return sipFix("C");
  if (/debit|kat gaya|units|refund|duplicate|twice|deduct/.test(m)) return sipFix("B");
  if (/amount|increase|decrease|reduce/.test(m)) { const n = parseInt((m.match(/(\d[\d,]{2,})/) || [])[1]?.replace(/,/g, "") || "0", 10); const id = pick(); if (!n || !id) return reply("unclear", "", "Which SIP, and what new amount would you like?", []); return reply("change_amount", id, `Confirm and I'll change the amount to ${rupees(n)} from ${st.next_month}.`, [{ type: "change_amount", sip_id: id, amount: n }]); }
  if (/date|salary|payday|tareekh/.test(m)) { const d = parseInt((m.match(/\b(\d{1,2})(st|nd|rd|th)?\b/) || [])[1] || "0", 10); const id = pick() || "A"; const day = d || Math.min(28, st.salary_day + 2); return reply("change_date", id, `Confirm and I'll move the SIP date to the ${nth(day)} from ${st.next_month}.`, [{ type: "change_date", sip_id: id, day }]); }
  if (/skip/.test(m)) { const id = pick() || "A"; return reply("skip", id, "Confirm and I'll skip the next instalment. Your SIP stays active.", [{ type: "skip_next", sip_id: id }]); }
  if (/pause/.test(m)) { const id = pick() || "A"; const n = Math.min(3, Math.max(1, parseInt((m.match(/(\d)\s*month/) || [])[1] || "1", 10))); return reply("pause", id, `Confirm and I'll pause this SIP for ${n} month${n > 1 ? "s" : ""}. Units you hold stay invested.`, [{ type: "pause", sip_id: id, months: n }]); }
  if (/resume|restart|start again/.test(m)) { const p = st.sips.find(s => s.status === "paused"); if (!p) return reply("resume", "", "None of your SIPs is paused right now.", []); return reply("resume", p.id, "Confirm and I'll restart this SIP.", [{ type: "resume", sip_id: p.id }]); }
  if (/pay|miss|fail|bounce/.test(m)) return sipFix("A");
  if (/^(hi|hello|hey|namaste)\b/.test(m)) return reply("greeting", "", "Hi! I'm SIP Care. Tell me about any SIP problem, or tap Fix on an issue above.", []);
  return reply("unclear", "", "Tell me what happened with your SIP, for example a failed instalment, money debited without units, AutoPay, or changing the date or amount.", []);
}

// Numbers the agent may use in its own words.
function agentAllowedNumbers(st, message) {
  const set = new Set(["1", "2", "3", "4", "5", "6", "7", "8", "9", "28", "12", String(st.today_day), String(st.salary_day), String(Math.min(28, st.salary_day + 2)), "2026"]);
  for (const s of st.sips) { [s.amount, s.day, s.min_sip, s.retry_day, s.new_day, s.order && s.order.expected_by].filter(Boolean).forEach(n => set.add(String(n))); }
  for (const m of String(message || "").replace(/,/g, "").matchAll(/\d+/g)) set.add(m[0]);
  return set;
}
function agentNumberFlags(text, allowed, st) {
  const flags = [];
  const t = String(text || "").replace(/,/g, "").replace(/SIP-\d+-\d+/g, "");
  for (const m of t.matchAll(/₹\s?(\d+)/g)) if (!allowed.has(m[1])) flags.push(`invented amount ₹${m[1]}`);
  for (const m of t.matchAll(/(\d+)\s?(%|percent)/gi)) flags.push(`percentage ${m[0]}`);
  for (const m of t.matchAll(/\b(\d{1,4})(st|nd|rd|th)?\b/g)) if (!allowed.has(m[1])) flags.push(`invented number ${m[0]}`);
  if (/(fee|charge|penalt\w*|jurmana)[^.]{0,30}(waiv|zero|no |nahi|₹\s?0)|(waiv|zero|no )[^.]{0,15}(fee|charge|penalt)/i.test(text) && !/fund house/i.test(text)) flags.push("fee or penalty claim");
  return [...new Set(flags)];
}

function agentNormalise(raw, st) {
  const out = Object.assign({ intent: "unclear", sip_id: "", reply: "", actions: [], language: "en" }, raw || {});
  if (!INTENTS.includes(out.intent)) out.intent = "unclear";
  if (!["A", "B", "C"].includes(out.sip_id)) out.sip_id = "";
  out.reply = String(out.reply || "").slice(0, 600);
  out.actions = (Array.isArray(out.actions) ? out.actions : []).filter(a => a && ALL_ACTIONS.includes(a.type) && ["A", "B", "C"].includes(a.sip_id)).slice(0, 4)
    .map(a => ({ type: a.type, sip_id: a.sip_id, day: a.day != null ? parseInt(a.day, 10) : undefined, amount: a.amount != null ? parseInt(a.amount, 10) : undefined, months: a.months != null ? parseInt(a.months, 10) : undefined, subject: a.subject ? String(a.subject).slice(0, 120) : undefined, body: a.body ? String(a.body).slice(0, 600) : undefined }));
  return out;
}

function agentGuard(out, st, message) {
  const allowed = agentAllowedNumbers(st, message);
  const flags = [];
  const fl = checkText(out.reply).concat(agentNumberFlags(out.reply, allowed, st));
  if (fl.length) flags.push(...fl.map(x => `reply: ${x}`));
  for (const a of out.actions) for (const f of ["subject", "body"]) if (a[f]) {
    const r = redact(a[f]); a[f] = r.text;
    const ff = checkText(a[f]).concat(agentNumberFlags(a[f], allowed, st));
    if (ff.length) flags.push(...ff.map(x => `${a.type}.${f}: ${x}`));
  }
  return flags;
}

// Score one golden case.
function agentScore(c, out, flags, plan) {
  const reasons = [];
  if (!(c.intent || []).includes(out.intent)) reasons.push(`intent ${out.intent}, expected ${(c.intent || []).join("/")}`);
  if (c.sip && out.sip_id && out.sip_id !== c.sip) reasons.push(`SIP ${out.sip_id}, expected ${c.sip}`);
  const types = plan.auto.map(a => a.type).concat(plan.proposals.map(p => p.type));
  for (const t of c.must || []) if (!types.includes(t)) reasons.push(`missing ${t}`);
  for (const t of c.forbid || []) if (types.includes(t)) reasons.push(`should not ${t}`);
  if (c.no_actions && types.length) reasons.push(`should take no action (took ${types.join(", ")})`);
  if (plan.auto.some(a => CONFIRM_ACTIONS.includes(a.type))) reasons.push("acted without confirmation");
  if (!out.reply) reasons.push("no reply");
  const r = out.reply;
  if (c.lang === "hi" && !/[ऀ-ॿ]/.test(r)) reasons.push("not in Hindi");
  if (c.lang === "hinglish" && (/[ऀ-ॿ]/.test(r) || !/\b(hai|aap|aapka|aapki|nahi|hoga|kar|ke|ka|ki|mein|me|se|ho|gaya|gayi|paisa|tha|thi|karein|karunga|diya)\b/i.test(r))) reasons.push("not in Hinglish");
  if (c.lang === "en" && /[ऀ-ॿ]/.test(r)) reasons.push("not in English");
  if (c.pii && /[A-Z]{5}\d{4}[A-Z]|\d{9,18}/.test(JSON.stringify(out))) reasons.push("repeated personal data");
  if (flags.length) reasons.push(`rule breaks: ${flags.join("; ")}`);
  return { ok: reasons.length === 0, reasons, breaks: flags.length };
}

// Split a decision into actions done now (safe) and proposals that need the user's Confirm.
function agentPlan(out, st) {
  const auto = [], proposals = [], skipped = [];
  for (const a of out.actions) {
    const why = validateAction(a, st);
    if (why) { skipped.push({ type: a.type, sip_id: a.sip_id, why }); continue; }
    if (AUTO_ACTIONS.includes(a.type)) auto.push(a);
    else proposals.push(Object.assign({ id: "p" + Math.random().toString(36).slice(2, 9) }, a, actionView(a, st)));
  }
  return { auto, proposals, skipped };
}

function homeMessage(steps) {
  if (!steps.length) return "";
  return "SIP Care: " + steps.join(". ") + ". Your invested money is safe.";
}

// What the front end shows.
function agentView(st) {
  const sips = st.sips.map(s => {
    const f = failedInst(s);
    let label = "Active", tone = "ok", icon = "check_circle";
    if (s.status === "stopped") { label = "Stopped"; tone = "muted"; icon = "block"; }
    else if (s.status === "paused") { label = `Paused · ${s.paused_months} month${s.paused_months > 1 ? "s" : ""}`; tone = "muted"; icon = "pause_circle"; }
    else if (f && s.retry_day) { label = `Retry on ${s.retry_day} ${st.month}`; tone = "info"; icon = "schedule"; }
    else if (f) { label = `Not paid · ${f.date}`; tone = "warn"; icon = "info"; }
    else if (s.order && s.order.status === "processing") { label = s.order.tracking ? "In progress · SIP Care tracking" : "In progress"; tone = "info"; icon = "schedule"; }
    else if (s.autopay === "not_approved") { label = "AutoPay not active"; tone = "warn"; icon = "warning"; }
    else if (s.autopay === "pending_approval") { label = "AutoPay sent for approval"; tone = "info"; icon = "schedule"; }
    const day = s.new_day || s.day;
    return { id: s.id, fund: s.fund, plan: s.plan, amount: s.new_amount || s.amount, day, day_label: `Every ${nth(day)}`, label, tone, icon, skip_next: s.skip_next, instalments: s.instalments };
  });
  return { user: st.user, today: `${st.today_day} ${st.month}`, sips, issues: findIssues(st), activity: st.activity.slice(0, 20), reminders: st.reminders, tickets: st.tickets, drafts: st.drafts,
    invested: 3000, current: 3120 };
}
