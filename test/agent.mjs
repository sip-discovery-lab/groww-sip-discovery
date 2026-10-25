// Tests for SIP Care v3: normal account at launch, user-led questions, confirm rule, follow-ups, hidden research, cron, push, gate.
import { makeD1 } from "./d1.mjs";
import fs from "node:fs";
import { makeAgentMock, researchMock } from "./agent_mock.mjs";
const W = (await import("../dist/worker.js?" + Date.now())).default;
const lib = new Function(["guard", "facts", "core", "agent", "events"].map(f => fs.readFileSync(new URL(`../src/${f}.js`, import.meta.url), "utf8")).join("\n") + "; return { agentRules, demoState, stateWith, agentNormalise, agentGuard, agentPlan, agentScore, injectSituation, monitorTick };")();
let pass = 0, fail = 0; const F = [];
const t = (n, c, i) => { if (c) pass++; else { fail++; F.push(n + (i !== undefined ? " :: " + JSON.stringify(i).slice(0, 700) : "")); } };
const mode = { m: "ok" };
const DB = makeD1();
const pushes = []; const research = [];
const env = { DB, GEMINI_AGENT_MOCK: makeAgentMock(lib.agentRules, mode), GEMINI_RESEARCH_MOCK: async x => { research.push(x.topic); return researchMock(x); }, GEMINI_MOCK: async () => ({ situation: "unclear", confidence: .5, language: "en", summary: "x", action_order: [] }), GEMINI_CARE_MOCK: async () => ({ cause: "other", plan: [], found: "x", home_message: "y" }),
  TICK_FORCE_MS: -1, NOW_MS: Date.UTC(2026, 9, 25, 6, 0), PUSH_FETCH: async (url, init) => { pushes.push({ url, init }); return new Response(null, { status: 201 }); } };
const call = async (path, body, method) => { const r = await W.fetch(new Request("https://x.test" + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : { method: method || "GET" }), env); const ct = r.headers.get("content-type") || ""; return { status: r.status, h: r.headers, body: ct.includes("json") ? await r.json() : await r.text() }; };
const ask = async (sid, message, lang) => (await call("/api/agent/message", { session_id: sid, message, lang: lang || "en" })).body;
const tick = async sid => (await call("/api/agent/tick", { session_id: sid, force: true })).body;
const IST = (y, m, d) => Date.UTC(y, m, d, 6, 0);

// ---- dates: last invested = most recent 26th ----
let st = lib.demoState(IST(2026, 9, 25));
t("25 Oct: last invested 26 Sep", st.last_sip === "26 Sep 2026" && st.next_sip === "26 Oct 2026", [st.last_sip, st.next_sip]);
t("instalments end on 26 Sep, all paid", st.sips.every(s => s.instalments.slice(-1)[0].date === "26 Sep 2026" && s.instalments.every(i => i.status === "paid")));
st = lib.demoState(IST(2026, 9, 27));
t("27 Oct: last invested 26 Oct, next 26 Nov", st.last_sip === "26 Oct 2026" && st.next_sip === "26 Nov 2026");
st = lib.demoState(IST(2026, 0, 10));
t("year wrap: 10 Jan -> last 26 Dec 2025", st.last_sip === "26 Dec 2025" && st.sips[0].instalments[0].date === "26 Jul 2025", [st.last_sip, st.sips[0].instalments[0]]);
st = lib.demoState(IST(2026, 9, 26));
t("on the 26th: last invested still 26 Sep, next is today, nothing pending", st.sips.every(s => !s.order) && st.last_sip === "26 Sep 2026" && st.next_sip_is_today);
st = lib.demoState(IST(2026, 9, 25));
t("portfolio numbers", st.sips.map(s => s.invested).join() === "6000,8000,1000" && st.sips.map(s => s.value).join() === "6192,7912,1008", st.sips.map(s => [s.invested, s.value]));

// pages
let r = await call("/"); t("app page", r.status === 200 && /SIP Care/.test(r.body) && /not an official Groww product/.test(r.body));
r = await call("/sw.js"); t("service worker", /addEventListener\("push"/.test(r.body) && /#\/note\//.test(r.body));
r = await call("/quality"); t("quality page", /How SIP Care is tested/.test(r.body));

// ---- launch: everything normal ----
r = await call("/api/agent/start", {}); let sid = r.body.session_id; let v = r.body.view;
t("no errors at launch", v.issues.length === 0 && v.needs_you.length === 0 && v.inbox.length === 0 && v.observations.length === 0, v);
t("all SIPs active", v.sips.every(s => s.tone === "ok" || s.label === "Units on the way"), v.sips.map(s => s.label));
t("last invested shown", v.sips.every(s => s.last_invested === v.last_sip) && /26 /.test(v.last_sip), v.sips.map(s => s.last_invested));
t("situations offered", r.body.situations.length === 3);
t("totals", v.invested === 15000 && v.value === 15112 && v.gain === 112, [v.invested, v.value]);
let b = await tick(sid);
t("background check stays quiet when nothing changes", b.fresh.length === 0 && b.view.inbox.length === 0);

// ---- standard answers (gate off) ----
b = await ask(sid, "My SIP payment failed this month");
t("no failure on account: says so, no pay_now", b.topic === "payment_failed" && /every instalment went through/.test(b.answer) && !b.proposals.some(p => p.type === "pay_now") && b.used_ai === false, b);
t("standard label notice", /quality check/.test(b.notice));
t("found lists account facts", b.found.length >= 3 && /paid on 26 /.test(b.found[0]), b.found);
t("support draft is auto", b.done.some(d => /Drafted/.test(d)));
b = await ask(sid, "When will my invested money grow?");
t("growth: no prediction, shows invested/value", b.topic === "growth" && /can.t be promised/.test(b.answer) && /15,000/.test(b.answer) && /15,112/.test(b.answer) && !b.proposals.length, b.answer);
b = await ask(sid, "How can I withdraw my money?");
t("withdraw: asks which fund, timeline", b.topic === "withdraw" && /2 working days/.test(b.answer) && !b.proposals.length, b);
b = await ask(sid, "Withdraw 2000 from my Bluechip fund");
const red = b.proposals.find(p => p.type === "redeem");
t("redeem proposed, not executed", red && red.amount === 2000 && /Withdraw ₹2,000/.test(red.title) && b.view.sips[0].value === 6192, b.proposals);
t("redeem shows exit load and bank", red.rows.some(x => x[0] === "Exit load" && /₹20/.test(x[1])) && red.rows.some(x => x[0] === "Credited to"), red.rows);
r = await call("/api/agent/confirm", { session_id: sid, proposal_ids: [red.id] });
t("redeem executes after confirm", r.body.ok && r.body.view.sips[0].value === 4192 && r.body.view.redemptions[0].status === "processing", r.body.view.sips[0]);
b = await tick(sid); b = await tick(sid);
t("follow-up: withdrawal credited notification", b.fresh.some(o => /Withdrawal credited/.test(o.title)) && b.view.inbox[0].body.includes("₹1,980"), b.view.inbox[0]);
t("balance increased by net", b.view.balance === 42500 + 1980, b.view.balance);
b = await ask(sid, "I want to close my Nifty 50 SIP");
const stop = b.proposals.find(p => p.type === "stop_sip");
t("stop proposed with units-stay note", stop && /stay invested/.test(stop.note) && stop.danger, stop);
r = await call("/api/agent/confirm", { session_id: sid, proposal_ids: [stop.id] });
t("stop requested", r.body.view.sips[2].label === "Stop requested");
b = await tick(sid);
t("stop processed -> notification", b.view.sips[2].label === "Stopped" && b.fresh.some(o => o.title === "SIP stopped"));
b = await ask(sid, "Reduce my Bluechip SIP to 200 rupees");
t("below minimum: no change proposed", !b.proposals.some(p => p.type === "change_amount"));
b = await ask(sid, "Which fund should I switch to for better returns?");
t("advice refused", b.topic === "out_of_scope" && !b.proposals.length);
b = await ask(sid, "My PAN is ABCDE1234F and account 123456789012, why did my SIP fail?");
t("PII removed and warned", !/ABCDE1234F|123456789012/.test(JSON.stringify(b)) && /don't share/i.test(b.answer) && b.redacted.length >= 2, b.answer);

// ---- demo situations ----
r = await call("/api/agent/start", { reset: true }); sid = r.body.session_id;
r = await call("/api/agent/situation", { session_id: sid, kind: "payment_failed" });
v = r.body.view;
t("situation: payment failed alert + notification", r.body.fresh.length === 1 && v.needs_you.length === 1 && v.inbox[0].ask && v.sips[1].tone === "warn", v.sips[1]);
t("failed instalment adjusts invested", v.sips[1].invested === 6000, v.sips[1].invested);
r = await call("/api/agent/situation", { session_id: sid, kind: "payment_failed" });
t("same situation twice: no duplicate", r.body.fresh.length === 0 && r.body.note);
b = await ask(sid, r.body.view.inbox[0].ask);
const pay = b.proposals.find(p => p.type === "pay_now");
t("asks -> analyses failure with bank message, pay_now proposed", b.topic === "payment_failed" && b.found.some(f => /Insufficient balance/.test(f)) && pay, b);
r = await call("/api/agent/confirm", { session_id: sid, proposal_ids: [pay.id] });
t("pay now -> units on the way, alert resolved", r.body.view.sips[1].label === "Units on the way", r.body.view.sips[1]);
let b1 = await tick(sid); b = await tick(sid); b.fresh = b1.fresh.concat(b.fresh);
t("units allotted notification, alert resolved", b.fresh.some(o => o.kind === "units_allotted") && b.view.needs_you.length === 0 && b.view.sips[1].invested === 8000, [b.view.needs_you, b.view.sips[1]]);
r = await call("/api/agent/situation", { session_id: sid, kind: "units_pending" });
b = await ask(sid, "Money was debited but my investment is not showing in the app.");
t("units pending: tracking auto, no pay", b.done.some(d => /Tracking/.test(d)) && !b.proposals.some(p => p.type === "pay_now"), b);
r = await call("/api/agent/situation", { session_id: sid, kind: "autopay_expired" });
b = await ask(sid, "Why did my AutoPay stop and what do I need to do?");
const ap = b.proposals.find(p => p.type === "setup_autopay");
t("autopay: new request proposed", ap, b.proposals);
r = await call("/api/agent/confirm", { session_id: sid, proposal_ids: [ap && ap.id] }); b = await tick(sid); b = await tick(sid);
t("autopay active notification", b.view.sips[2].autopay === "active" && b.view.inbox.some(i => /AutoPay for/.test(i.body) && /active again/.test(i.body)));

// ---- confirm rule ----
r = await call("/api/agent/confirm", { session_id: sid, proposal_ids: ["nope"] });
t("confirm unknown -> 400", r.status === 400);
r = await call("/api/agent/situation", { session_id: sid, kind: "bogus" });
t("unknown situation -> 400", r.status === 400);

// ---- gate pass: AI path, research, guards ----
await DB.prepare(`INSERT INTO eval_runs (id, ts, model, prompt_version, n, passed, breaks, score, gate, complete, errors) VALUES ('g1', ?, 'gemini-3.5-flash-lite', 'agent-v3', 30, 30, 0, 1, 1, 1, 0)`).bind(new Date().toISOString()).run();
r = await call("/api/agent/start", { reset: true }); sid = r.body.session_id;
t("gate passed visible", r.body.gate.passed === true);
b = await ask(sid, "When will I get the money if I withdraw from my Bluechip fund?");
t("AI answer used", b.used_ai === true && b.topic === "withdraw", b);
t("research ran once for topic", research.filter(x => x === "withdraw").length === 1, research);
const cached = (await DB.prepare(`SELECT body FROM care_cache WHERE k = 'research:v1:withdraw'`).first()).body;
t("research notes cleaned (no links, no sources)", !/https?:|example\.com|SEBI|Source/i.test(cached) && /2 working days/.test(cached), cached);
b = await ask(sid, "How can I withdraw my money?");
t("research cached (no second call)", research.filter(x => x === "withdraw").length === 1);
mode.m = "bad"; b = await ask(sid, "My SIP payment failed this month");
t("unsafe AI -> standard answer", b.used_ai === false && /safety rule/.test(b.notice) && !/waived|SEBI/.test(b.answer) && !b.proposals.some(p => p.type === "stop_sip"), b);
mode.m = "leak"; b = await ask(sid, "How can I withdraw my money?");
t("source mention blocked", b.used_ai === false && !/Zerodha|website/i.test(JSON.stringify(b.answer)), b.answer);
mode.m = "down"; b = await ask(sid, "Is my money safe?");
t("AI down -> standard", b.used_ai === false && /unavailable/.test(b.notice) && b.topic === "is_money_safe");
mode.m = "ok";
b = await ask(sid, "Mera paisa kab badhega?", "hinglish");
t("hinglish AI answer", b.used_ai && /aapka|paisa/i.test(b.answer));

// ---- guard unit checks ----
st = lib.stateWith([], IST(2026, 9, 25));
const g = x => lib.agentGuard(lib.agentNormalise(x), st, "");
t("guard: invented ₹", g({ topic: "growth", answer: "You will get ₹25,000 next year.", found: [], actions: [] }).length > 0);
t("guard: own numbers ok", g({ topic: "growth", answer: "You invested ₹15,000 and it is worth ₹15,112.", found: ["Bluechip Equity Fund (Demo): ₹6,000 → ₹6,192"], actions: [] }).length === 0, g({ topic: "growth", answer: "You invested ₹15,000 and it is worth ₹15,112.", found: ["Bluechip Equity Fund (Demo): ₹6,000 → ₹6,192"], actions: [] }));
t("guard: source names", g({ topic: "tax", answer: "As per SEBI, tax is 20%.", found: [], actions: [] }).some(f => /source/.test(f)));
t("guard: link", g({ topic: "tax", answer: "See www.amfiindia.com", found: [], actions: [] }).length > 0);
t("guard: prediction", g({ topic: "growth", answer: "Your money will double soon.", found: [], actions: [] }).length > 0);
t("guard: allowed tax numbers", g({ topic: "tax", answer: "Short-term gains are taxed at 20%; long-term at 12.5% above ₹1.25 lakh.", found: [], actions: [] }).length === 0, g({ topic: "tax", answer: "Short-term gains are taxed at 20%; long-term at 12.5% above ₹1.25 lakh.", found: [], actions: [] }));
t("guard: dates ok", g({ topic: "status", answer: "Your next instalments are on 26 Oct 2026; the last was on 26 Sep 2026.", found: [], actions: [] }).length === 0);

// ---- cron + push ----
r = await call("/api/agent/start", { reset: true }); sid = r.body.session_id;
await call("/api/agent/push-subscribe", { session_id: sid, subscription: { endpoint: "https://push.example/abc" } });
r = await call("/api/agent/situation", { session_id: sid, kind: "units_pending" });
t("situation pushes", pushes.length === 1);
b = await ask(sid, "Money was debited but my investment is not showing in the app.");
await DB.prepare(`UPDATE agent_sessions SET state = json_set(state, '$.last_tick', 0) WHERE id = ?`).bind(sid).run().catch(() => {});
const row = await DB.prepare(`SELECT state FROM agent_sessions WHERE id = ?`).bind(sid).first(); const s2 = JSON.parse(row.state); s2.last_tick = 0; s2.sips[0].order.ticks = 1;
await DB.prepare(`UPDATE agent_sessions SET state = ?, updated = ? WHERE id = ?`).bind(JSON.stringify(s2), new Date().toISOString(), sid).run();
const ctx = { p: null, waitUntil(p) { this.p = p; } }; W.scheduled({}, env, ctx); const cr = await ctx.p;
t("cron ticks and pushes when units arrive", cr && cr.ticked >= 1 && pushes.length === 2, [cr, pushes.length]);
r = await call("/api/agent/latest?endpoint=" + encodeURIComponent("https://push.example/abc"));
t("latest notification for push", /Units added/.test(r.body.notification.title), r.body);

// ---- quality gate with the oracle mock ----
r = await call("/api/eval/start", { suite: "agent" });
if (r.status === 429) { await DB.prepare(`DELETE FROM eval_runs`).run(); r = await call("/api/eval/start", { suite: "agent" }); }
t("eval start", r.body.ok && r.body.cases.length === 30, r.body);
const fails = [];
for (const id of r.body.cases) { const c = (await call("/api/eval/case", { run_id: r.body.run_id, case_id: id })).body.case; if (!c.ok) fails.push(id + ": " + c.reasons + " :: " + c.summary.slice(0, 160)); }
const fin = (await call("/api/eval/finish", { run_id: r.body.run_id })).body;
t("gate passes with good model", fin.gate === true, fails);
r = await call("/api/eval?suite=agent");
t("latest shows meta", r.body.case_meta && r.body.case_meta.length === 30 && r.body.cases.length === 30);

// ---- the standard (rule-based) agent on the gate cases ----
const cases = JSON.parse(fs.readFileSync(new URL("../eval/agent_cases.json", import.meta.url), "utf8"));
const rb = [];
for (const c of cases) {
  if (c.lang !== "en") continue;
  const s = lib.stateWith(c.situations || [], IST(2026, 9, 25));
  const out = lib.agentNormalise(lib.agentRules(c.message, s));
  const fl = lib.agentGuard(out, s, c.message); const plan = lib.agentPlan(out, s);
  const sc = lib.agentScore(Object.assign({}, c, { lang: "en" }), out, fl, plan);
  if (!sc.ok) rb.push(c.id + ": " + sc.reasons.join("; "));
}
t("standard answers pass English gate cases", rb.length === 0, rb);

console.log(`agent: ${pass} passed, ${fail} failed`);
if (fail) { console.log(F.join("\n")); process.exit(1); }
