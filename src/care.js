// SIP Care agent: diagnoses a failed instalment from raw bank signals and prepares a fix.
const CARE_VERSION = "care-v1";

const CARE_CAUSES = {
  salary_after_sip_date: "Salary arrives after the SIP date, so the balance was short",
  low_balance_one_off: "The balance was short this time, but income arrives before the SIP date",
  mandate_inactive: "AutoPay (mandate) is not approved, expired or cancelled",
  bank_technical: "A technical problem at the bank, not the balance",
  other: "Something else; needs the bank or support",
};

const CARE_ALLOWED = {
  salary_after_sip_date: ["retry_on_payday", "move_date_after_payday", "pay_now", "skip_month"],
  low_balance_one_off: ["pay_now", "skip_month", "keep_balance_reminder"],
  mandate_inactive: ["fix_autopay", "pay_now", "skip_month"],
  bank_technical: ["pay_now", "skip_month"],
  other: ["pay_now", "skip_month", "contact_support"],
};
const CARE_ACTIONS = ["retry_on_payday", "move_date_after_payday", "pay_now", "skip_month", "keep_balance_reminder", "fix_autopay", "contact_support"];

// The demo user shown in the app.
const CARE_SCENARIOS = {
  riya: {
    name: "Riya", fund: "Bluechip Equity Fund (Demo)", plan: "Direct Growth", amount: 1000,
    sip_day: 3, salary_day: 7, month: "Nov", next_month: "December", instalment_no: 4,
    bank: "Account ••12", consecutive_failures: 1,
    bank_message: "NACH debit returned: Balance insufficient (reason code 01) on 03-Nov",
  },
};

const ord = n => n + (n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th");
const inr = n => "₹" + Number(n).toLocaleString("en-IN");
function careNumbers(s) {
  const newDay = s.salary_day ? Math.min(28, s.salary_day + 2) : null;
  return { retryDay: s.salary_day || null, newDay };
}

function careSystemPrompt() {
  return `You are SIP Care, an AI agent inside a mutual fund app. A first-time investor's monthly SIP instalment failed.
You receive the SIP details and the bank's raw failure message. Your job:
1. Decide the cause (one of the listed causes) by reading the bank message and the dates.
2. Choose the fix: 1-2 actions ONLY from the allowed list for that cause, most helpful first.
3. Write short, calm, plain text in the requested language.

CAUSES
${Object.entries(CARE_CAUSES).map(([k, v]) => `- ${k}: ${v}`).join("\n")}
Rules for cause:
- Insufficient balance AND salary day is after the SIP day -> salary_after_sip_date.
- Insufficient balance AND salary day is on/before the SIP day, or unknown -> low_balance_one_off.
- Mandate/AutoPay not registered, not approved, expired, revoked or cancelled -> mandate_inactive.
- Bank server, timeout, technical decline, network -> bank_technical.
- Anything else (account frozen, KYC, closed account) -> other.

ALLOWED ACTIONS PER CAUSE
${Object.entries(CARE_ALLOWED).map(([k, v]) => `- ${k}: ${v.join(", ")}`).join("\n")}
- For salary_after_sip_date the fix is retry_on_payday then move_date_after_payday.
- For mandate_inactive the fix starts with fix_autopay.
- For low_balance_one_off or bank_technical the fix starts with pay_now.

WRITING RULES (breaking any is a failure)
- found: 1-2 sentences explaining the cause in the user's words, e.g. salary vs SIP date. Do not blame the user.
- notes: one short sentence per chosen action explaining why it helps.
- home_message: 1-2 sentences confirming what was set up, written as if the fix is done, and ending with the SIP being active.
- Use ONLY numbers given in the input (amount, days, dates). Never invent fees, waivers, times, percentages or guarantees.
- Never say a bank fee is waived or that there is zero penalty. The fund house charges no penalty; the bank may charge its own fee.
- Never recommend, name or compare other funds. Never predict returns or markets.
- No fear or urgency words (immediately, urgent, hurry, last chance, you will lose, turant, jaldi).
- Never ask for PAN, account numbers, OTP, PIN or screenshots.
- Language: en = English; hinglish = Hindi in Latin script; hi = Hindi in Devanagari. Write found, notes and home_message in that language.
Return only JSON matching the schema.`;
}

const CARE_SCHEMA = {
  type: "OBJECT",
  properties: {
    cause: { type: "STRING", enum: Object.keys(CARE_CAUSES) },
    plan: { type: "ARRAY", items: { type: "STRING", enum: CARE_ACTIONS } },
    found: { type: "STRING" },
    notes: { type: "ARRAY", items: { type: "OBJECT", properties: { action: { type: "STRING", enum: CARE_ACTIONS }, note: { type: "STRING" } }, required: ["action", "note"] } },
    home_message: { type: "STRING" },
  },
  required: ["cause", "plan", "found", "home_message"],
};

function careUserPrompt(s, lang) {
  const n = careNumbers(s);
  return [
    `Language: ${lang}`,
    `Fund: ${s.fund} · ${s.plan}`,
    `Monthly SIP: ${inr(s.amount)} on the ${ord(s.sip_day)} of every month`,
    `Failed instalment: ${s.sip_day} ${s.month} (instalment #${s.instalment_no}); failures in a row: ${s.consecutive_failures}`,
    `Salary/income usually arrives: ${s.salary_day ? "the " + ord(s.salary_day) : "unknown"}`,
    n.retryDay ? `If retrying on payday, the retry date is ${n.retryDay} ${s.month}. If moving the SIP date, the new date is the ${ord(n.newDay)} from ${s.next_month}.` : `No payday date is known.`,
    `Bank's raw failure message: """${redact(s.bank_message).text}"""`,
  ].join("\n");
}

// Numbers the AI is allowed to use in its text.
function careAllowedNumbers(s) {
  const n = careNumbers(s);
  const set = new Set([s.amount, s.sip_day, s.instalment_no, s.consecutive_failures, 1, 2, 3, 4, 5, 7, 12].filter(Boolean).map(String));
  if (n.retryDay) set.add(String(n.retryDay));
  if (n.newDay) set.add(String(n.newDay));
  return set;
}
function careNumberFlags(text, s) {
  const allowed = careAllowedNumbers(s);
  const flags = [];
  const t = String(text || "").replace(/,/g, "");
  for (const m of t.matchAll(/₹\s?(\d+)/g)) if (m[1] !== String(s.amount)) flags.push(`invented amount ₹${m[1]}`);
  for (const m of t.matchAll(/(\d+)\s?(%|percent)/gi)) flags.push(`percentage ${m[0]}`);
  for (const m of t.matchAll(/\b(\d{1,2})(st|nd|rd|th)?\b/g)) if (!allowed.has(m[1])) flags.push(`invented number ${m[0]}`);
  if (/(fee|charge|penalt\w*|jurmana)[^.]{0,30}(waiv|zero|no |nahi|₹\s?0)|(waiv|zero|no )[^.]{0,15}(fee|charge|penalt)/i.test(text) && !/fund house/i.test(text)) flags.push("fee or penalty claim");
  return [...new Set(flags)];
}

function careNormalise(raw) {
  const out = Object.assign({ found: "", home_message: "", notes: [], plan: [] }, raw || {});
  if (!CARE_CAUSES[out.cause]) out.cause = "other";
  const allowed = CARE_ALLOWED[out.cause];
  out.plan = (Array.isArray(out.plan) ? out.plan : []).filter((a, i, arr) => allowed.includes(a) && arr.indexOf(a) === i).slice(0, 2);
  if (!out.plan.length) out.plan = allowed.slice(0, out.cause === "salary_after_sip_date" ? 2 : 1);
  out.notes = (Array.isArray(out.notes) ? out.notes : []).filter(n => n && out.plan.includes(n.action) && typeof n.note === "string").map(n => ({ action: n.action, note: n.note.slice(0, 200) }));
  out.found = String(out.found || "").slice(0, 400);
  out.home_message = String(out.home_message || "").slice(0, 400);
  return out;
}

function careGuard(out, s) {
  const flags = [];
  const clean = Object.assign({}, out);
  for (const f of ["found", "home_message"]) {
    const fl = checkText(out[f]).concat(careNumberFlags(out[f], s));
    if (fl.length) { flags.push(...fl.map(x => `${f}: ${x}`)); clean[f] = ""; }
  }
  clean.notes = [];
  for (const n of out.notes || []) {
    const fl = checkText(n.note).concat(careNumberFlags(n.note, s));
    if (fl.length) flags.push(...fl.map(x => `note(${n.action}): ${x}`)); else clean.notes.push(n);
  }
  return { flags, clean };
}

// Fixed titles and steps, built from the SIP data (not written by the AI).
function careActionView(id, s) {
  const n = careNumbers(s);
  const A = {
    retry_on_payday: { title: `Retry ${inr(s.amount)} on ${n.retryDay} ${s.month}, after payday`, desc: "Funds are debited after your salary usually arrives.", step: `Scheduled a retry of ${inr(s.amount)} on ${n.retryDay} ${s.month}`, isNew: true },
    move_date_after_payday: { title: `Move future SIP date to the ${ord(n.newDay || 0)}`, desc: "Future instalments run after payday.", step: `Changed your SIP date to the ${ord(n.newDay || 0)} from ${s.next_month}` },
    pay_now: { title: `Pay ${inr(s.amount)} now`, desc: "Units are bought at the price on the day you pay.", step: `Opened a one-time payment of ${inr(s.amount)}` },
    skip_month: { title: "Skip this month (SIP stays active)", desc: "Your next instalment runs as normal.", step: `Skipped the ${s.month} instalment; your SIP stays active` },
    keep_balance_reminder: { title: `Remind me to keep ${inr(s.amount)} ready`, desc: "A reminder 4 days before the SIP date.", step: `Set a reminder to keep ${inr(s.amount)} ready 4 days before the SIP date` },
    fix_autopay: { title: "Set up AutoPay again", desc: "Approve it in your UPI or bank app; it usually takes 2-7 days.", step: "Sent a new AutoPay request to your UPI app" },
    contact_support: { title: "Contact support", desc: "SIP Care prepares the message for you.", step: "Prepared a support message (no personal details)" },
  };
  return Object.assign({ id }, A[id]);
}

const CARE_FALLBACK = {
  en: {
    found: "Your salary arrives on the 7th but this SIP runs on the 3rd, so the balance was short. This is likely to happen again next month.",
    home_message: "₹1,000 will be retried on 7 Nov, after payday. From December your SIP runs on the 9th. Your SIP is active.",
  },
};

function careFallback(s, lang) {
  const n = careNumbers(s);
  const fb = CARE_FALLBACK[lang] || CARE_FALLBACK.en;
  return { cause: "salary_after_sip_date", plan: ["retry_on_payday", "move_date_after_payday"], found: fb.found, notes: [], home_message: fb.home_message, retryDay: n.retryDay };
}

function careBuild(s, ai, meta) {
  const base = careFallback(s, meta.lang);
  const out = ai || base;
  const notes = {}; (out.notes || []).forEach(x => { notes[x.action] = x.note; });
  const others = CARE_ALLOWED[out.cause].filter(a => !out.plan.includes(a));
  return {
    scenario: meta.scenario, lang: meta.lang, used_ai: !!meta.used_ai, notice: meta.notice || "",
    sip: { fund: s.fund, plan: s.plan, amount: s.amount, sip_day: s.sip_day, failed_on: `${s.sip_day} ${s.month}`, instalment_no: s.instalment_no, bank: s.bank },
    cause: out.cause, cause_label: CARE_CAUSES[out.cause],
    found: out.found || base.found,
    fix: out.plan.map(id => Object.assign(careActionView(id, s), { note: notes[id] || "" })),
    other_options: others.map(id => careActionView(id, s)),
    home_message: out.home_message || base.home_message,
    facts: [FACTS.units_safe.text, FACTS.three_strikes.text, FACTS.no_amc_penalty.text],
  };
}

// Golden-case scoring for the care gate.
function careScore(c, out, flags) {
  const reasons = [];
  if (out.cause !== c.expect_cause) reasons.push(`cause ${out.cause}, expected ${c.expect_cause}`);
  for (const a of c.must_plan || []) if (!out.plan.includes(a)) reasons.push(`fix misses ${a}`);
  for (const a of c.must_not_plan || []) if (out.plan.includes(a)) reasons.push(`fix should not include ${a}`);
  if (c.first && out.plan[0] !== c.first) reasons.push(`fix should start with ${c.first}`);
  if (!out.found) reasons.push("no explanation");
  if (!out.home_message) reasons.push("no home message");
  const txt = out.found + " " + out.home_message;
  if (c.lang === "hi" && !/[ऀ-ॿ]/.test(txt)) reasons.push("not in Hindi");
  if (c.lang === "hinglish" && (/[ऀ-ॿ]/.test(txt) || !/\b(hai|aap|aapka|aapki|nahi|hoga|kar|ke|ka|ki|mein|me|se|ho|gaya|gayi|paisa|tha|thi)\b/i.test(txt))) reasons.push("not in Hinglish");
  if (c.lang === "en" && /[ऀ-ॿ]/.test(txt)) reasons.push("not in English");
  if (flags.length) reasons.push(`rule breaks: ${flags.join("; ")}`);
  return { ok: reasons.length === 0, reasons, breaks: flags.length };
}
