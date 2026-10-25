// Stand-in for Gemini used in tests: answers the golden cases correctly, and falls back to the rules for anything else.
import fs from "node:fs";
const cases = JSON.parse(fs.readFileSync(new URL("../eval/agent_cases.json", import.meta.url), "utf8"));
const R = { en: "I've checked your SIP. Your invested money is safe.", hinglish: "Maine aapki SIP check ki hai. Aapka invested paisa safe hai.", hi: "मैंने आपकी SIP देखी है। आपका निवेश किया हुआ पैसा सुरक्षित है।" };
export function makeAgentMock(rules, mode) {
  return async ({ st, message, lang }) => {
    if (mode.m === "down") throw new Error("HTTP 429 · Resource exhausted (free-tier limit reached: try again later)");
    if (mode.m === "bad") return { intent: "fix_issue", sip_id: "A", reply: "Bounce fee waived! Pay ₹999 immediately or you will lose everything.", actions: [{ type: "stop_sip", sip_id: "A" }, { type: "schedule_retry", sip_id: "A", day: 7 }] };
    if (mode.m === "wrong") return { intent: "unclear", sip_id: "", reply: "Hmm.", actions: [{ type: "stop_sip", sip_id: "C" }] };
    const c = cases.find(x => x.message.replace(/[A-Z]{5}\d{4}[A-Z]|\d{9,18}/g, "") === message.replace(/\[removed\]/g, "").replace(/[A-Z]{5}\d{4}[A-Z]|\d{9,18}/g, "") && x.lang === lang)
      || cases.find(x => x.message === message && x.lang === lang);
    if (!c) { const r = rules(message, st); return Object.assign(r, { reply: lang === "en" ? r.reply : R[lang] }); }
    const num = parseInt((message.match(/(\d{2,5})/) || [])[1] || "0", 10);
    const p = { schedule_retry: { day: 7 }, change_date: { day: /12th/.test(message) ? 12 : 9 }, change_amount: { amount: num || 3000 }, pause: { months: 2 }, send_ticket: { subject: "Duplicate SIP debit", body: "Two debits for one SIP instalment this month. Please refund the extra debit." }, set_reminder: { day: 8 } };
    const actions = c.no_actions ? [] : (c.must || []).map(t => Object.assign({ type: t, sip_id: c.sip || "A" }, p[t] || {}));
    return { intent: c.intent[0], sip_id: c.sip || "", reply: R[c.lang], language: c.lang, actions };
  };
}
