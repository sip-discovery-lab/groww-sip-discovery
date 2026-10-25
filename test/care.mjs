import { makeD1 } from "./d1.mjs";
import fs from "node:fs";
const W = (await import("../dist/worker.js?" + Date.now())).default;
const cases = JSON.parse(fs.readFileSync(new URL("../eval/care_cases.json", import.meta.url), "utf8"));
let pass = 0, fail = 0; const F = [];
const t = (n, c, i) => { if (c) pass++; else { fail++; F.push(n + (i !== undefined ? " :: " + JSON.stringify(i).slice(0, 400) : "")); } };
const DB = makeD1();
let mode = "oracle", last = null;
const say = { en: "Your salary comes on the 7th but the SIP runs on the 3rd, so the balance was short.", hinglish: "Aapki salary 7 ko aati hai par SIP 3 ko kat-ta hai, isliye balance kam tha.", hi: "आपकी सैलरी 7 तारीख को आती है, पर SIP 3 तारीख को कटता है।" };
const home = { en: "Retry set for 7 Nov. Your SIP is active.", hinglish: "7 Nov ko retry set hai. Aapka SIP active hai.", hi: "7 Nov को फिर से कोशिश होगी। आपका SIP चालू है।" };
const mock = async ({ state, lang }) => {
  last = { state, lang };
  if (mode === "down") throw new Error("HTTP 429 · quota (free-tier limit reached: try again later)");
  if (mode === "bad") return { cause: "salary_after_sip_date", plan: ["retry_on_payday", "fix_autopay", "move_date_after_payday"], found: "Bounce fee of ₹0 waived, retry between 9 and 11 AM, act immediately.", home_message: "Zero penalty! 24 hrs reminder.", notes: [{ action: "retry_on_payday", note: "You should invest in a small cap fund." }] };
  if (mode === "wrong") return { cause: "other", plan: [], found: "x", home_message: "y" };
  const c = cases.find(c => c.state.bank_message.replace(/[A-Z]{5}\d{4}[A-Z]/g, "") .slice(0, 20) === state.bank_message.replace(/[A-Z]{5}\d{4}[A-Z]/g, "").slice(0, 20) && c.state.sip_day === state.sip_day && c.state.salary_day === state.salary_day && c.lang === lang) || null;
  const cause = c ? c.expect_cause : "salary_after_sip_date";
  const plan = c ? (c.first ? [c.first].concat((c.must_plan || []).filter(a => a !== c.first)) : (c.must_plan || [])).slice(0, 2) : ["retry_on_payday", "move_date_after_payday"];
  const L = c ? c.lang : lang;
  return { cause, plan, found: say[L], home_message: home[L], notes: plan.map(a => ({ action: a, note: L === "en" ? "This helps your SIP continue." : L === "hi" ? "इससे आपका SIP चलता रहेगा।" : "Isse aapka SIP chalta rahega." })) };
};
const env = { DB, GEMINI_CARE_MOCK: mock, GEMINI_MOCK: async () => ({ situation: "unclear", confidence: 0.5, language: "en", summary: "x", action_order: [] }) };
const call = async (path, body, method) => { const r = await W.fetch(new Request("https://x.test" + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : { method: method || "GET" }), env); const ct = r.headers.get("content-type") || ""; return { status: r.status, h: r.headers, body: ct.includes("json") ? await r.json() : await r.text() }; };

// CORS
let r = await call("/api/care/diagnose", null, "OPTIONS");
t("OPTIONS 204 with CORS", r.status === 204 && r.h.get("access-control-allow-origin") === "*");
// before gate: fallback
r = await call("/api/care/diagnose?lang=en");
t("diagnose CORS", r.h.get("access-control-allow-origin") === "*");
t("fallback before gate", r.body.used_ai === false && /quality check/.test(r.body.notice) && /salary arrives on the 7th/.test(r.body.found), r.body);
t("fallback fix = retry + move", r.body.fix.map(f => f.id).join() === "retry_on_payday,move_date_after_payday", r.body.fix);
t("fix titles use real numbers", r.body.fix[0].title === "Retry ₹1,000 on 7 Nov, after payday" && r.body.fix[1].title === "Move future SIP date to the 9th", r.body.fix);
t("other options", r.body.other_options.map(o => o.id).join() === "pay_now,skip_month", r.body.other_options);
t("sip facts", r.body.sip.instalment_no === 4 && r.body.sip.failed_on === "3 Nov" && r.body.sip.bank === "Account ••12");
t("home message fallback", /retried on 7 Nov/.test(r.body.home_message));
t("AI not called before gate", last === null);
t("bad lang falls back to en", (await call("/api/care/diagnose?lang=fr")).body.lang === "en");
// scoring + number checks via eval oracle
r = await call("/api/eval/start", { suite: "care" });
t("care eval start", r.body.ok && r.body.cases.length === 25, r.body);
const run = r.body.run_id;
for (const id of r.body.cases) { const c = await call("/api/eval/case", { run_id: run, case_id: id }); if (!c.body.case.ok) F.push("oracle " + id + " " + c.body.case.reasons + c.body.case.error); }
t("PII redacted before AI (K25)", !/ABCDE1234F/.test(JSON.stringify(last)));
r = await call("/api/eval/finish", { run_id: run });
t("oracle passes care gate", r.body.gate === true && r.body.score === 1, r.body);
r = await call("/api/eval?suite=care");
t("care eval listing", r.body.suite === "care" && r.body.cases.length === 25 && r.body.case_meta[0].text.includes("NACH") && r.body.gate.passed);
r = await call("/api/eval");
t("helper suite separate", r.body.suite === "helper" && r.body.gate.passed === false);
t("care cooldown independent of helper", (await call("/api/eval/start", {})).body.ok === true);
// after gate: AI
mode = "oracle"; last = null;
r = await call("/api/care/diagnose?lang=hinglish&session=s1");
t("AI used after gate", r.body.used_ai === true && /Aapki salary/.test(r.body.found) && r.body.gate.passed, r.body);
t("AI notes attached", r.body.fix[0].note.length > 5);
last = null;
r = await call("/api/care/diagnose?lang=hinglish&session=s1");
t("cached second call", r.body.cached === true && last === null);
// bad output
mode = "bad";
r = await call("/api/care/diagnose?lang=en&fresh=1&session=s2");
const txt = JSON.stringify(r.body);
t("bad text replaced", !/waived|Zero penalty|small cap|immediately|24 hrs/.test(txt) && /replaced/.test(r.body.notice), r.body);
t("disallowed action dropped", !r.body.fix.some(f => f.id === "fix_autopay") && r.body.fix.length === 2, r.body.fix);
// AI down
mode = "down";
r = await call("/api/care/diagnose?lang=hi&fresh=1");
t("AI down -> standard fix with reason", r.body.used_ai === false && /429/.test(r.body.notice) && r.body.fix.length === 2, r.body);
// fix + events + stats
r = await call("/api/care/event", { session_id: "u1", event: "home_view" });
t("event ok", r.body.ok);
t("bad event rejected", (await call("/api/care/event", { session_id: "u1", event: "hack" })).status === 400);
r = await call("/api/care/diagnose?session=u1");
r = await call("/api/care/fix", { session_id: "u1", plan: ["retry_on_payday", "move_date_after_payday", "rm -rf"] });
t("fix steps", r.body.ok && r.body.steps.length === 4 && r.body.steps[1] === "Scheduled a retry of ₹1,000 on 7 Nov" && r.body.steps[2] === "Changed your SIP date to the 9th from December" && /keep ₹1,000 ready on 7 Nov/.test(r.body.steps[3]), r.body);
t("fix needs plan", (await call("/api/care/fix", { plan: [] })).status === 400);
r = await call("/api/care/stats");
t("stats", r.body.ok && r.body.fixed >= 1 && r.body.fix_rate > 0 && r.body.median_seconds_to_fix !== null, r.body);
// failing eval for care
DB.raw.prepare("UPDATE eval_runs SET ts = '2000-01-01T00:00:00Z'").run();
mode = "wrong";
r = await call("/api/eval/start", { suite: "care" }); const run2 = r.body.run_id;
for (const id of r.body.cases) await call("/api/eval/case", { run_id: run2, case_id: id });
r = await call("/api/eval/finish", { run_id: run2 });
t("wrong AI fails care gate", r.body.gate === false, r.body);
t("gate off again -> fallback", (await call("/api/care/diagnose?fresh=1")).body.used_ai === false);
// quality page
r = await call("/quality");
t("quality page", r.status === 200 && /How SIP Care is tested/.test(r.body));
r = await call("/api/care/facts");
t("facts", r.body.ok && r.body.scenario.amount === 1000);
console.log(`care tests: ${pass} passed, ${fail} failed`); F.forEach(f => console.log("FAIL", f)); process.exit(fail || F.length ? 1 : 0);
