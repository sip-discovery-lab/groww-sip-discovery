import { makeD1 } from "./d1.mjs";
import fs from "node:fs";
import { makeAgentMock } from "./agent_mock.mjs";
const src = fs.readFileSync(new URL("../dist/worker.js", import.meta.url), "utf8");
const W = (await import("../dist/worker.js?" + Date.now())).default;
const rules = new Function(fs.readFileSync(new URL("../src/guard.js", import.meta.url), "utf8") + fs.readFileSync(new URL("../src/agent.js", import.meta.url), "utf8") + "; return { agentRules, demoState, agentNormalise, agentPlan, agentScore };")();
const cases = JSON.parse(fs.readFileSync(new URL("../eval/agent_cases.json", import.meta.url), "utf8"));
let pass = 0, fail = 0; const F = [];
const t = (n, c, i) => { if (c) pass++; else { fail++; F.push(n + (i !== undefined ? " :: " + JSON.stringify(i).slice(0, 500) : "")); } };
const mode = { m: "oracle" };
const DB = makeD1();
const env = { DB, GEMINI_AGENT_MOCK: makeAgentMock(rules.agentRules, mode), GEMINI_MOCK: async () => ({ situation: "unclear", confidence: .5, language: "en", summary: "x", action_order: [] }), GEMINI_CARE_MOCK: async () => ({ cause: "other", plan: [], found: "x", home_message: "y" }) };
const call = async (path, body, method) => { const r = await W.fetch(new Request("https://x.test" + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : { method: method || "GET" }), env); const ct = r.headers.get("content-type") || ""; return { status: r.status, h: r.headers, body: ct.includes("json") ? await r.json() : await r.text() }; };

// pages
let r = await call("/"); t("app page", r.status === 200 && /SIP Care/.test(r.body) && /Concept prototype for a Groww case study/.test(r.body) && /not an official Groww product/.test(r.body));
r = await call("/helper"); t("old helper moved", r.status === 200 && /SIP Recovery Helper/.test(r.body));
r = await call("/quality"); t("quality page", /How SIP Care is tested/.test(r.body));
// start
r = await call("/api/agent/start", {}); const sid = r.body.session_id;
t("start", r.body.ok && sid && r.body.view.issues.length === 3 && r.body.view.sips.length === 3 && r.h.get("access-control-allow-origin") === "*", r.body);
t("issue labels", r.body.view.sips[0].label === "Not paid · 3 Nov" && r.body.view.sips[1].label === "In progress" && r.body.view.sips[2].label === "AutoPay not active", r.body.view.sips.map(s => s.label));
r = await call("/api/agent/start", { session_id: sid }); t("resume same session", r.body.session_id === sid);
// rules mode (gate not passed)
r = await call("/api/agent/message", { session_id: sid, message: "__fix__:A", lang: "en" });
t("rules mode before gate", r.body.ok && r.body.used_ai === false && /quality check/.test(r.body.notice), r.body);
t("fix A proposes retry 7 + date 9", r.body.proposals.map(p => p.type + (p.day || "")).join() === "schedule_retry7,change_date9", r.body.proposals);
t("nothing auto for A", r.body.done.length === 0);
t("proposal views", r.body.proposals[0].title === "Retry ₹1,000 on 7 Nov" && /Keep ₹1,000/.test(r.body.proposals[0].note) && r.body.proposals[0].isNew, r.body.proposals[0]);
t("still not executed", r.body.view.sips[0].label === "Not paid · 3 Nov");
const pids = r.body.proposals.map(p => p.id);
r = await call("/api/agent/message", { session_id: sid, message: "__fix__:B", lang: "en" });
t("fix B auto track + reminder", r.body.done.length === 2 && /Tracking order SIP-20261105-0042/.test(r.body.done[0]) && r.body.proposals.length === 0, r.body);
t("B label tracking", r.body.view.sips[1].label === "In progress · SIP Care tracking");
r = await call("/api/agent/message", { session_id: sid, message: "__fix__:C", lang: "en" });
t("fix C reminder auto + autopay proposal", r.body.done.length === 1 && r.body.proposals.map(p => p.type).join() === "setup_autopay", r.body);
t("pending accumulates", r.body.pending.length === 3);
// confirm A
r = await call("/api/agent/confirm", { session_id: sid, proposal_ids: pids });
t("confirm A", r.body.ok && r.body.steps.length === 3 && r.body.steps[1] === "Scheduled a retry of ₹1,000 on 7 Nov" && r.body.steps[2] === "Changed the SIP date to the 9th from Dec", r.body);
t("A now retry + day 9", r.body.view.sips[0].label === "Retry on 7 Nov" && r.body.view.sips[0].day === 9, r.body.view.sips[0]);
t("home message", /Scheduled a retry of ₹1,000 on 7 Nov/.test(r.body.home_message) && /invested money is safe/.test(r.body.home_message));
t("issues drop to 2", r.body.view.issues.length === 2, r.body.view.issues);
t("confirm twice fails", (await call("/api/agent/confirm", { session_id: sid, proposal_ids: pids })).status === 400);
// decline C
const cp = r.body.pending[0].id;
r = await call("/api/agent/decline", { session_id: sid, proposal_id: cp }); t("decline", r.body.ok && r.body.removed === 1 && r.body.pending.length === 0);
// other requests in rules mode
r = await call("/api/agent/message", { session_id: sid, message: "Change my Flexi Cap SIP amount to 3000", lang: "en" });
t("change amount proposal", r.body.proposals[0] && r.body.proposals[0].type === "change_amount" && r.body.proposals[0].amount === 3000, r.body);
r = await call("/api/agent/message", { session_id: sid, message: "Reduce my Bluechip SIP to 200 rupees", lang: "en" });
t("below minimum rejected", r.body.proposals.length === 0 && r.body.skipped.length === 1 && /at least ₹500/.test(r.body.skipped[0].why), r.body);
r = await call("/api/agent/message", { session_id: sid, message: "Which fund should I switch to for better returns?", lang: "en" });
t("out of scope", r.body.intent === "out_of_scope" && r.body.proposals.length === 0 && r.body.done.length === 0);
r = await call("/api/agent/message", { session_id: sid, message: "My PAN is ABCDE1234F and account 123456789012, why did my SIP fail?", lang: "en" });
t("PII redacted", r.body.redacted.includes("PAN") && !/ABCDE1234F|123456789012/.test(JSON.stringify(r.body)), r.body.redacted);
const row = DB.raw.prepare("SELECT history FROM agent_sessions WHERE id = ?").get(sid);
t("PII not stored", !/ABCDE1234F|123456789012/.test(row.history));
r = await call("/api/agent/message", { session_id: sid, message: "I want to stop my Nifty 50 SIP", lang: "en" });
t("stop needs confirm", r.body.proposals[0] && r.body.proposals[0].type === "stop_sip" && r.body.proposals[0].danger && r.body.view.sips[2].label !== "Stopped", r.body.proposals);
t("bad session", (await call("/api/agent/message", { session_id: "nope", message: "hi" })).status === 400);
t("empty message", (await call("/api/agent/message", { session_id: sid, message: "  " })).status === 400);
// rules baseline on golden cases
let rb = 0;
for (const c of cases) { const st = rules.demoState(); if (c.patch) for (const [id, v] of Object.entries(c.patch)) Object.assign(st.sips.find(s => s.id === id), v); const out = rules.agentNormalise(rules.agentRules(c.message.replace(/[A-Z]{5}\d{4}[A-Z]|\d{9,18}/g, "[removed]"), st), st); const plan = rules.agentPlan(out, st); const sc = rules.agentScore(Object.assign({}, c, { lang: "en" }), out, [], plan); if (sc.ok) rb++; }
console.log(`rules-only baseline on golden cases (language ignored): ${rb}/${cases.length}`);
// agent gate with oracle
r = await call("/api/eval/start", { suite: "agent" }); t("agent eval start", r.body.ok && r.body.cases.length === 30, r.body);
const run = r.body.run_id;
for (const id of r.body.cases) { const c = await call("/api/eval/case", { run_id: run, case_id: id }); if (!c.body.case.ok) F.push("oracle " + id + " " + c.body.case.reasons + " " + c.body.case.error); }
r = await call("/api/eval/finish", { run_id: run }); t("oracle passes agent gate", r.body.gate === true && r.body.score === 1, r.body);
r = await call("/api/eval?suite=agent"); t("agent listing", r.body.suite === "agent" && r.body.cases.length === 30 && r.body.gate.passed);
// AI mode
const s2 = (await call("/api/agent/start", {})).body.session_id;
r = await call("/api/agent/message", { session_id: s2, message: "__fix__:A", lang: "hinglish" });
t("AI used after gate", r.body.used_ai === true && /Maine aapki SIP/.test(r.body.reply) && r.body.proposals.map(p => p.type).join() === "schedule_retry,change_date", r.body);
mode.m = "bad";
r = await call("/api/agent/message", { session_id: s2, message: "__fix__:A", lang: "en" });
t("unsafe AI -> rules answer", r.body.used_ai === false && /safety rule/.test(r.body.notice) && !/waived|immediately|999/.test(JSON.stringify(r.body)) && !r.body.proposals.some(p => p.type === "stop_sip"), r.body);
mode.m = "wrong";
r = await call("/api/agent/message", { session_id: s2, message: "hello there", lang: "en" });
t("AI stop_sip only proposed, not executed", r.body.view.sips[2].label !== "Stopped" && r.body.proposals.some(p => p.type === "stop_sip"), r.body);
mode.m = "down";
r = await call("/api/agent/message", { session_id: s2, message: "__fix__:C", lang: "en" });
t("AI down -> rules", r.body.used_ai === false && /429/.test(r.body.notice) && r.body.proposals.some(p => p.type === "setup_autopay"), r.body);
mode.m = "oracle";
// feedback + stats
r = await call("/api/agent/feedback", { session_id: sid, understood: "yes", fixed: "yes", clarity: 5 }); t("feedback", r.body.ok);
r = await call("/api/agent/feedback", { understood: "yes" }); t("feedback needs session", r.status === 400);
r = await call("/api/agent/stats");
t("stats", r.body.ok && r.body.sessions >= 2 && r.body.confirmed_a_fix >= 1 && r.body.feedback.n === 1 && r.body.feedback.avg_clarity === 5 && r.body.declined === 1, r.body);
// reset
r = await call("/api/agent/start", { session_id: sid, reset: true }); t("reset gives fresh state", r.body.session_id !== sid && r.body.view.issues.length === 3);
r = await call("/api/agent/message", null, "OPTIONS"); t("OPTIONS", r.status === 204);
console.log(`agent tests: ${pass} passed, ${fail} failed`); F.forEach(f => console.log("FAIL", f)); process.exit(fail || F.length ? 1 : 0);
