// Stand-ins for Gemini used in tests: they answer like a well-behaved model so the plumbing can be tested.
import fs from "node:fs";
const cases = JSON.parse(fs.readFileSync(new URL("../eval/agent_cases.json", import.meta.url), "utf8"));
const R = { en: "I've checked your SIPs. Your invested money is safe.", hinglish: "Maine aapki SIP check ki hai. Aapka invested paisa safe hai.", hi: "मैंने आपकी SIP देखी है। आपका निवेश किया हुआ पैसा सुरक्षित है।" };
export function makeAgentMock(rules, mode) {
  return async ({ st, message, lang }) => {
    if (mode.m === "down") throw new Error("HTTP 429 · Resource exhausted (free-tier limit reached: try again later)");
    if (mode.m === "bad") return { topic: "payment_failed", sip_id: "A", found: ["As per SEBI rules on www.example.com"], answer: "Bounce fee waived! Pay ₹999 immediately or you will lose everything.", actions: [{ type: "stop_sip", sip_id: "A" }] };
    if (mode.m === "leak") return { topic: "withdraw", sip_id: "", found: ["Value ₹6,192"], answer: "According to Zerodha's website, money is credited within 2 working days.", actions: [] };
    const clean = t => t.replace(/\[removed\]/g, "").replace(/[A-Z]{5}\d{4}[A-Z]|\d{9,18}/g, "").replace(/\s+/g, " ").trim();
    const c = cases.find(x => clean(x.message) === clean(message) && x.lang === lang);
    const r = rules(message, st);
    if (!c) return Object.assign(r, { answer: lang === "en" ? r.answer : R[lang] });
    const num = parseInt((message.replace(/,/g, "").match(/(\d{3,5})/) || [])[1] || "0", 10);
    const p = { change_date: { day: 12 }, change_amount: { amount: num || 3000 }, pause: { months: 2 }, redeem: num ? { amount: num } : { all: true }, send_ticket: { subject: "SIP issue", body: "Please check my SIP." } };
    const actions = c.no_actions ? [] : (c.must || []).map(t => Object.assign({ type: t, sip_id: c.sip || "A" }, p[t] || {}));
    return { topic: c.topic[0], sip_id: c.sip || "", found: r.found.length ? r.found : ["Next instalments on " + st.next_sip], answer: lang === "en" ? r.answer : R[lang], next: lang === "en" ? r.next : [], followups: ["How do I withdraw?"], language: lang, actions };
  };
}
export const researchMock = async ({ topic }) => `- Equity fund redemptions are credited within 2 working days.\n- See https://example.com/rules for details\n- Source: SEBI circular\n- Cut-off is 3:00 pm.`;
