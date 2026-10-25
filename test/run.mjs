import { makeD1 } from "./d1.mjs";
const mod = await import("../dist/worker.js?" + Date.now());
const W = mod.default;
let pass = 0, fail = 0; const fails = [];
const t = (name, cond, info) => { if (cond) pass++; else { fail++; fails.push(name + (info ? " :: " + JSON.stringify(info).slice(0, 300) : "")); } };
const cases = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("../eval/cases.json", import.meta.url), "utf8"));

const DB = makeD1();
let mockMode = "oracle", lastInput = null;
const ORACLE = async input => {
  lastInput = input;
  if (mockMode === "throw429") throw new Error("HTTP 429 · quota (free-tier limit reached: try again later)");
  if (mockMode === "bad") return { situation: "instalment_failed", confidence: 0.9, language: "en", summary: "You should invest in a Nifty index fund immediately.", worry_answer: "", action_order: ["stop_sip", "pay_one_time", "fix_autopay"], notes: [{ action: "pay_one_time", note: "Share your PAN with support." }] };
  if (mockMode === "wrong") return { situation: "out_of_scope", confidence: 0.5, language: "en", summary: "Not sure.", action_order: [] };
  const c = cases.find(c => input.text && c.text.replace(/[A-Z]{5}\d{4}[A-Z]|\d{9,18}/g, "[removed]").slice(0, 40) === input.text.slice(0, 40));
  if (!c) return { situation: "instalment_failed", confidence: 0.8, language: "en", summary: "This month's instalment did not go through.", action_order: ["pay_one_time", "let_next_run"], notes: [{ action: "pay_one_time", note: "You can pay it today if you want this month invested." }] };
  const lang = c.lang === "hi" ? "hi" : c.lang;
  const summary = c.lang === "hi" ? "आपकी इस महीने की किस्त नहीं कटी।" : c.lang === "hinglish" ? "Aapka paisa safe hai, yeh instalment abhi process nahi hua." : "Your instalment did not go through, but your invested money is safe.";
  return { situation: c.expect, confidence: 0.9, language: lang, summary, worry_answer: c.worry ? "No, money already invested stays invested." : "", action_order: c.main.length ? [c.main[0]] : [], notes: [], support_message: "" };
};
const env = { DB, GEMINI_MOCK: ORACLE };
const req = (path, body, method) => new Request("https://x.test" + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : { method: method || "GET" });
const call = async (path, body, e = env) => { const r = await W.fetch(req(path, body), e); const ct = r.headers.get("content-type") || ""; return { status: r.status, body: ct.includes("json") ? await r.json() : await r.text() }; };

// 1 page
let r = await call("/");
t("page served", r.status === 200 && r.body.includes("SIP Recovery Helper") && r.body.includes("Concept prototype for Groww"));
t("page has no Groww branding claims", !/groww\.in\/(?!help|blog)/.test(r.body) && r.body.includes("Not an official Groww product"));
// 2 no DB
r = await call("/api/gate", null, {});
t("no DB -> clear error", r.status === 500 && /D1 binding/.test(r.body.error));
// 3 gate
r = await call("/api/gate");
t("gate off initially", r.body.ok && r.body.gate.passed === false && r.body.gate.prompt_version === "recovery-v1");
// 4 help before gate
for (const [chip, txt, exp] of [["money_stuck", "", "money_stuck"], [null, "paisa kat gaya units nahi aaye", "money_stuck"], [null, "autopay nahi ho raha", "autopay_problem"], [null, "my sip failed this month", "instalment_failed"], [null, "balance is low this month", "low_balance_ahead"], [null, "which fund is best", "out_of_scope"], [null, "help", "unclear"]]) {
  r = await call("/api/help", { chip, text: txt });
  t(`standard help: ${txt || chip} -> ${exp}`, r.body.situation === exp && r.body.used_ai === false && /quality check/.test(r.body.notice), r.body);
}
t("AI not called before gate", lastInput === null);
r = await call("/api/help", { chip: "instalment_failed" });
t("standard answer has money facts + sources", r.body.money_now.length === 3 && r.body.money_now.every(f => f.source && f.source.url.startsWith("https://")));
t("stop shown neutrally last", r.body.options.at(-1).id === "stop_sip" && r.body.options[0].id !== "stop_sip");
r = await call("/api/help", { chip: "money_stuck" });
t("support message present for money_stuck", r.body.options.some(o => o.id === "contact_support") && r.body.support_message.length > 20);
r = await call("/api/help", { text: "help" });
t("unclear asks one question", r.body.situation === "unclear" && r.body.question.length > 10 && r.body.options.length === 0);
// 5 PII
r = await call("/api/help", { text: "my PAN ABCDE1234F account 123456789012 upi me@okaxis OTP 123456 sip failed" });
t("PII redacted & reported", ["PAN", "Aadhaar or account number", "UPI ID", "OTP or PIN"].every(x => r.body.redacted.includes(x)), r.body.redacted);
let row = DB.raw.prepare("SELECT * FROM sessions ORDER BY rowid DESC LIMIT 1").get();
t("no message text stored", !Object.values(row).some(v => typeof v === "string" && /ABCDE1234F|123456789012|okaxis/.test(v)));
// 6 eval oracle
r = await call("/api/eval/start", {});
t("eval start", r.body.ok && r.body.cases.length === 25, r.body);
const run = r.body.run_id;
for (const id of r.body.cases) { const c = await call("/api/eval/case", { run_id: run, case_id: id }); if (!c.body.case || !c.body.case.ok) fails.push("oracle case " + id + " " + JSON.stringify(c.body.case)); }

r = await call("/api/eval/finish", { run_id: run });
t("oracle passes gate", r.body.gate === true && r.body.score === 1 && r.body.breaks === 0, r.body);
r = await call("/api/eval/start", {});
t("cooldown blocks new check", r.status === 429 && /min/.test(r.body.error));
r = await call("/api/eval");
t("eval listing", r.body.run && r.body.cases.length === 25 && r.body.case_meta.length === 25 && r.body.gate.passed);
// 7 help after gate, good
mockMode = "oracle";
r = await call("/api/help", { text: "Mera feb ki sip miss ho gayi, to ab mujhe kya karna chahiye?" });
t("AI answer used after gate", r.body.used_ai === true && r.body.situation === "instalment_failed" && r.body.options[0].id === "pay_one_time", r.body);
r = await call("/api/help", { text: "SIP failed, PAN ABCDE1234F acct 987654321098" });
t("AI only sees redacted text", lastInput && !/ABCDE1234F|987654321098/.test(JSON.stringify(lastInput)) && lastInput.redacted.length === 2, lastInput);
// 8 bad output guarded
mockMode = "bad";
r = await call("/api/help", { text: "sip failed" });
t("bad AI text removed", r.body.used_ai && !/Nifty|immediately/.test(JSON.stringify(r.body)) && /safety rule/.test(r.body.notice), r.body);
t("stop not first even if AI puts it first", r.body.options[0].id !== "stop_sip");
t("disallowed action filtered", !r.body.options.some(o => o.id === "fix_autopay"));
t("bad note removed", !r.body.options.some(o => /PAN/.test(o.note)));
row = DB.raw.prepare("SELECT flags FROM sessions ORDER BY rowid DESC LIMIT 1").get();
t("flags logged", /advice/.test(row.flags) && /urgency/.test(row.flags), row);
// 9 AI down
mockMode = "throw429";
r = await call("/api/help", { chip: "autopay_problem", text: "x" });
t("AI down -> standard help with reason", r.body.used_ai === false && /429/.test(r.body.notice) && r.body.situation === "autopay_problem", r.body);
// 10 daily cap
DB.raw.prepare("UPDATE usage SET n = 400 WHERE kind = 'help'").run();
mockMode = "oracle";
r = await call("/api/help", { chip: "money_stuck" });
t("daily cap -> standard help", r.body.used_ai === false && /limit/.test(r.body.notice));
DB.raw.prepare("UPDATE usage SET n = 0 WHERE kind = 'help'").run();
// 11 feedback
r = await call("/api/feedback", { session_id: "abc", understood: "yes", chosen: "pay_one_time", clarity: 9, seconds: 42, tester: true, scenario: "T2-failed" });
t("feedback saved", r.body.ok);
row = DB.raw.prepare("SELECT * FROM feedback ORDER BY rowid DESC LIMIT 1").get();
t("feedback clamped", row.clarity === 5 && row.chosen === "pay_one_time" && row.tester === 1);
r = await call("/api/feedback", { session_id: "abc", understood: "<script>", chosen: "rm -rf" });
row = DB.raw.prepare("SELECT * FROM feedback ORDER BY rowid DESC LIMIT 1").get();
t("feedback rejects junk", row.understood === "" && row.chosen === "");
r = await call("/api/feedback", {});
t("feedback needs session", r.status === 400);
// 12 results
r = await call("/api/results");
t("results", r.body.ok && r.body.sessions.n > 5 && r.body.feedback.length >= 2 && r.body.gate.passed);
// 13 model change resets gate
r = await call("/api/gate", null, Object.assign({}, env, { MODEL: "other-model" }));
t("gate is per model", r.body.gate.passed === false);
// 14 failing eval
DB.raw.prepare("UPDATE eval_runs SET ts = '2000-01-01T00:00:00Z'").run();
mockMode = "wrong";
r = await call("/api/eval/start", {}); const run2 = r.body.run_id;
for (const id of r.body.cases) await call("/api/eval/case", { run_id: run2, case_id: id });
r = await call("/api/eval/finish", { run_id: run2 });
t("wrong AI fails gate", r.body.gate === false && r.body.score < 0.9, r.body);
r = await call("/api/gate");
t("gate now off after failed latest check", r.body.gate.passed === false);
// 15 bad routes
r = await call("/api/eval/case", { run_id: "nope", case_id: "C01" });
t("bad run id", r.status === 400);
r = await call("/api/nope");
t("404", r.status === 404);

console.log(`unit+route tests: ${pass} passed, ${fail} failed`);
fails.forEach(f => console.log("FAIL", f));
process.exit(fail ? 1 : 0);
