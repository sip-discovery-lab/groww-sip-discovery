// Tests for SIP Care v3: normal account at launch, user-led questions, confirm rule, follow-ups, hidden research, cron, push, gate.
import { makeD1 } from "./d1.mjs";
import fs from "node:fs";
import { makeAgentMock, researchMock } from "./agent_mock.mjs";
const W = (await import("../dist/worker.js?" + Date.now())).default;
const lib = new Function(["guard", "facts", "core", "agent", "events"].map(f => fs.readFileSync(new URL(`../src/${f}.js`, import.meta.url), "utf8")).join("\n") + "; return { agentRules, agentFlowRules, rulesLinks, intentFilter, demoState, stateWith, agentNormalise, agentGuard, agentPlan, agentScore, injectSituation, monitorTick, firstYear, agentView, runSipDay };")();
let pass = 0, fail = 0; const F = [];
const t = (n, c, i) => { if (c) pass++; else { fail++; F.push(n + (i !== undefined ? " :: " + JSON.stringify(i).slice(0, 700) : "")); } };
const mode = { m: "ok" };
const DB = makeD1();
const pushes = []; const research = [];
const env = { DB, GEMINI_AGENT_MOCK: makeAgentMock(lib.agentRules, mode, lib.agentFlowRules), GEMINI_RESEARCH_MOCK: async x => { research.push(x.topic); return researchMock(x); }, GEMINI_MOCK: async () => ({ situation: "unclear", confidence: .5, language: "en", summary: "x", action_order: [] }), GEMINI_CARE_MOCK: async () => ({ cause: "other", plan: [], found: "x", home_message: "y" }),
  TICK_FORCE_MS: -1, START_SCENARIO: "normal", NOW_MS: Date.UTC(2026, 9, 25, 6, 0), PUSH_FETCH: async (url, init) => { pushes.push({ url, init }); return new Response(null, { status: 201 }); } };
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
r = await call("/discovery"); t("discovery report page", r.status === 200 && /325/.test(r.body) && /quit after one failed instalment/.test(r.body));

// ---- launch: everything normal ----
r = await call("/api/agent/start", {}); let sid = r.body.session_id; let v = r.body.view;
t("no errors at launch", v.issues.length === 0 && v.needs_you.length === 0 && v.inbox.length === 0 && v.observations.length === 0, v);
t("all SIPs active", v.sips.every(s => s.tone === "ok" || s.label === "Units on the way"), v.sips.map(s => s.label));
t("last invested shown", v.sips.every(s => s.last_invested === v.last_sip) && /26 /.test(v.last_sip), v.sips.map(s => s.last_invested));
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

// ---- SIP day: instant failure alert, options, fix flow, cancel flow, redirect links ----
const flowAsk = async (sid, flow) => (await call("/api/agent/message", { session_id: sid, flow, lang: "en" })).body;
r = await call("/api/agent/start", { reset: true }); sid = r.body.session_id;
t("situations offered", r.body.situations.length === 9);
r = await call("/api/agent/situation", { session_id: sid, kind: "sip_low_balance" });
v = r.body.view;
const fo = r.body.fresh.find(o => o.kind === "payment_failed");
t("SIP day: instant failure notification", fo && /payment failed today/.test(fo.title) && v.inbox[0].title === fo.title && v.needs_you.length === 1, r.body.fresh);
t("SIP day: demo date moved to the 26th, others paid, no balance shown", /^26 /.test(v.demo_date) && v.sips[0].instalments[0].status === "processing" && v.sips[1].failed && v.balance === undefined && v.salary_day === undefined, [v.demo_date]);
const ob = v.observations.find(o => o.kind === "payment_failed");
t("failure analysis: only what the app knows", ob.why.some(w => /insufficient funds/.test(w)) && !/salary|₹1,740|balance at/i.test(JSON.stringify(ob)) && ob.options === true, ob.why);
r = await call("/api/agent/situation", { session_id: sid, kind: "sip_low_balance" });
t("same SIP day twice: no duplicate", r.body.fresh.length === 0 && r.body.note);
b = await flowAsk(sid, { kind: "fix", sip_id: "B" });
t("fix flow (insufficient funds): pay now + reminder before next SIP, link to SIP page, no salary talk", b.proposals.some(p => p.type === "pay_now") && b.done.some(d => /reminder/i.test(d) && /24th/.test(d)) && b.links.some(l => l.to === "sip") && !/salary|balance (is|was)/i.test(b.answer), b);
t("fix flow never proposes stop", !b.proposals.some(p => p.type === "stop_sip"));
const pay = b.proposals.find(p => p.type === "pay_now");
r = await call("/api/agent/confirm", { session_id: sid, proposal_ids: [pay.id] });
t("confirmed pay -> alert being fixed", ["in_progress", "resolved"].includes(r.body.view.observations.find(o => o.kind === "payment_failed").status), r.body.view.observations[0]);
let b1 = await tick(sid); b = await tick(sid); b.fresh = b1.fresh.concat(b.fresh);
t("paid -> units allotted, alert resolved", b.view.needs_you.length === 0 && !b.view.sips[1].failed && b.fresh.some(o => o.kind === "units_allotted"), b.view.needs_you);
// every other cause, each fixed with the app's own tools
const causeChecks = {
  sip_autopay: x => x.proposals.some(p => p.type === "setup_autopay") && x.proposals.some(p => p.type === "pay_now") && x.links.some(l => l.to === "autopay"),
  sip_not_approved: x => x.proposals.some(p => p.type === "setup_autopay") && /never approved/.test(x.answer),
  sip_mandate_cancelled: x => x.proposals.some(p => p.type === "setup_autopay") && /cancelled/.test(x.answer),
  sip_mandate_limit: x => x.proposals.some(p => p.type === "setup_autopay" && p.limit === 2000 && /Raise AutoPay limit/.test(p.title)) && /limit/.test(x.answer),
  sip_bank_error: x => x.proposals.some(p => p.type === "pay_now") && x.proposals.some(p => p.type === "send_ticket") && x.links.some(l => l.to === "support"),
  sip_debited: x => x.done.some(d => /Tracking/.test(d)) && x.proposals.some(p => p.type === "send_ticket") && !x.proposals.some(p => p.type === "pay_now"),
};
for (const [k, fn] of Object.entries(causeChecks)) {
  r = await call("/api/agent/start", { reset: true, scenario: k }); sid = r.body.session_id;
  t(`${k}: alert at launch`, r.body.fresh.some(o => o.kind === "payment_failed"), r.body.fresh);
  b = await flowAsk(sid, { kind: "fix", sip_id: "B" });
  t(`${k}: right fix with app tools`, fn(b), [b.answer, b.proposals.map(p => p.type + (p.limit ? ":" + p.limit : "")), b.done, b.links]);
}
// debited: refund follow-up, then paying again is allowed
r = await call("/api/agent/start", { reset: true, scenario: "sip_debited" }); sid = r.body.session_id;
r = await call("/api/agent/propose", { session_id: sid, type: "pay_now", sip_id: "B" });
t("debited: can't pay again before refund", r.status === 400, r.body);
let got = []; for (let i = 0; i < 4; i++) got = got.concat((await tick(sid)).fresh);
t("debited: refund notification", got.some(o => o.kind === "refunded"), got.map(o => o.kind));
r = await call("/api/agent/propose", { session_id: sid, type: "pay_now", sip_id: "B" });
t("after refund, pay now allowed", r.body.ok, r.body);
// mandate limit: raising the limit makes AutoPay active again
r = await call("/api/agent/start", { reset: true, scenario: "sip_mandate_limit" }); sid = r.body.session_id;
r = await call("/api/agent/propose", { session_id: sid, type: "setup_autopay", sip_id: "B", limit: 2000 });
r = await call("/api/agent/confirm", { session_id: sid, proposal_ids: [r.body.proposal.id] });
await tick(sid); b = await tick(sid);
t("limit raised -> AutoPay active with new limit", b.view.sips[1].autopay === "active" && b.view.sips[1].mandate_limit === 2000, b.view.sips[1]);
b = await ask(sid, "Is there enough balance in my bank account for the next SIP?");
t("balance question: says it can't see the bank balance", /can't see your bank balance/.test(b.answer) && !b.proposals.length, b.answer);
r = await call("/api/agent/start", { reset: true, scenario: "sip_low_balance" }); sid = r.body.session_id;
// cancel flow
b = await flowAsk(sid, { kind: "cancel_reason", sip_id: "B", reason: "money_tight" });
t("cancel flow: alternatives first, cancel last", b.proposals.length >= 2 && b.proposals[b.proposals.length - 1].type === "stop_sip" && b.proposals.some(p => ["skip_next", "pause"].includes(p.type)), b.proposals.map(p => p.type));
b = await flowAsk(sid, { kind: "cancel_reason", sip_id: "A", reason: "need_money" });
t("cancel flow (need money): withdraw link + cancel option", b.links.some(l => l.to === "withdraw" && l.sip_id === "A") && b.proposals.some(p => p.type === "stop_sip"), b);
b = await flowAsk(sid, { kind: "cancel_reason", sip_id: "C", reason: "growth", text: "My PAN is ABCDE1234F" });
t("cancel flow text is redacted", !/ABCDE1234F/.test(JSON.stringify(b)), b.shown);
// other SIP-day reasons
r = await call("/api/agent/start", { reset: true }); sid = r.body.session_id;
await call("/api/agent/situation", { session_id: sid, kind: "sip_autopay" });
b = await flowAsk(sid, { kind: "fix", sip_id: "B" });
t("fix flow (AutoPay): setup + pay, link to AutoPay page", b.proposals.some(p => p.type === "setup_autopay") && b.proposals.some(p => p.type === "pay_now") && b.links.some(l => l.to === "autopay"), b);
r = await call("/api/agent/start", { reset: true }); sid = r.body.session_id;
await call("/api/agent/situation", { session_id: sid, kind: "sip_bank_error" });
b = await flowAsk(sid, { kind: "fix", sip_id: "B" });
t("fix flow (bank error): retry + ticket, links orders/support", b.proposals.some(p => p.type === "pay_now") && b.proposals.some(p => p.type === "send_ticket") && b.links.some(l => l.to === "support"), b);
// pages create proposals directly (still need confirm)
r = await call("/api/agent/propose", { session_id: sid, type: "change_amount", sip_id: "A", amount: 1500 });
t("page proposal created", r.body.ok && r.body.proposal.type === "change_amount" && r.body.pending.some(p => p.id === r.body.proposal.id) && r.body.view.sips[0].amount === 1000, r.body);
r = await call("/api/agent/propose", { session_id: sid, type: "change_amount", sip_id: "A", amount: 200 });
t("page proposal validated", r.status === 400 && /at least/.test(r.body.error), r.body);
r = await call("/api/agent/propose", { session_id: sid, type: "set_reminder", sip_id: "A", day: 3 });
t("page cannot run auto action", r.status === 400);
r = await call("/api/agent/situation", { session_id: sid, kind: "units_pending" });
b = await ask(sid, "Money was debited but my investment is not showing in the app.");
t("units pending: tracking auto, no pay", b.done.some(d => /Tracking/.test(d)) && !b.proposals.some(p => p.type === "pay_now"), b);

// ---- confirm rule ----
r = await call("/api/agent/confirm", { session_id: sid, proposal_ids: ["nope"] });
t("confirm unknown -> 400", r.status === 400);
r = await call("/api/agent/situation", { session_id: sid, kind: "bogus" });
t("unknown situation -> 400", r.status === 400);

// ---- gate pass: AI path, research, guards ----
await DB.prepare(`INSERT INTO eval_runs (id, ts, model, prompt_version, n, passed, breaks, score, gate, complete, errors) VALUES ('g1', ?, 'gemini-3.5-flash-lite', 'agent-v6', 53, 53, 0, 1, 1, 1, 0)`).bind(new Date().toISOString()).run();
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
mode.m = "bad_once"; b = await ask(sid, "When will my invested money grow?");
t("self-correction: rule break fixed on second try", b.used_ai === true && !/double|1,080/.test(JSON.stringify(b)), b);
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

// ---- default demo opens on a failed SIP payment ----
delete env.START_SCENARIO;
r = await call("/api/agent/start", { reset: true });
t("default start: failed payment alert at launch", r.body.fresh.some(o => o.kind === "payment_failed") && r.body.view.needs_you.length === 1 && r.body.view.inbox[0].level === "alert", r.body.fresh);
r = await call("/api/agent/start", { reset: true, scenario: "normal" });
t("scenario normal: clean account", r.body.fresh.length === 0 && r.body.view.needs_you.length === 0);
r = await call("/api/agent/start", { reset: true, scenario: "sip_autopay" });
t("scenario AutoPay: AutoPay failure at launch", r.body.view.observations.some(o => o.reason === "autopay_expired"));
const resumed = await call("/api/agent/start", { session_id: r.body.session_id });
t("resume doesn't re-run the SIP day", resumed.body.fresh.length === 0 && resumed.body.view.observations.filter(o => o.kind === "payment_failed").length === 1);
env.START_SCENARIO = "normal";

// ---- the real SIP date: the agent runs the debits itself ----
r = await call("/api/agent/start", { reset: true }); sid = r.body.session_id;
env.NOW_MS = Date.UTC(2026, 9, 26, 6, 0);
b = await tick(sid);
t("on the real SIP date the debits run and the user is told", b.fresh.some(o => o.kind === "sip_debited") && b.view.sips.every(x => x.instalments[0].status === "processing"), b.fresh);
b = await tick(sid);
t("SIP day runs once", !b.fresh.some(o => o.kind === "sip_debited"));
env.NOW_MS = Date.UTC(2026, 9, 25, 6, 0);
r = await call("/api/agent/start", { reset: true }); sid = r.body.session_id;
await call("/api/agent/push-subscribe", { session_id: sid, subscription: { endpoint: "https://push.example/def" } });
const before = pushes.length;
await call("/api/agent/situation", { session_id: sid, kind: "sip_bank_error" });
t("failed SIP payment pushes an alert at once", pushes.length === before + 1);

// ---- quality gate with the oracle mock ----
r = await call("/api/eval/start", { suite: "agent" });
if (r.status === 429) { await DB.prepare(`DELETE FROM eval_runs`).run(); r = await call("/api/eval/start", { suite: "agent" }); }
t("eval start", r.body.ok && r.body.cases.length === 53, r.body);
const fails = [];
for (const id of r.body.cases) { const c = (await call("/api/eval/case", { run_id: r.body.run_id, case_id: id })).body.case; if (!c.ok) fails.push(id + ": " + c.reasons + " :: " + c.summary.slice(0, 160)); }
const fin = (await call("/api/eval/finish", { run_id: r.body.run_id })).body;
t("gate passes with good model", fin.gate === true, fails);
r = await call("/api/eval?suite=agent");
t("latest shows meta", r.body.case_meta && r.body.case_meta.length === 53 && r.body.cases.length === 53);

// ---- the standard (rule-based) agent on the gate cases ----
const cases = JSON.parse(fs.readFileSync(new URL("../eval/agent_cases.json", import.meta.url), "utf8"));
const rb = [];
for (const c of cases) {
  if (c.lang !== "en") continue;
  const s = lib.stateWith(c.situations || [], IST(2026, 9, 25)); if (c.state_patch) Object.assign(s, c.state_patch);
  const out = lib.rulesLinks(lib.intentFilter(lib.agentNormalise(c.flow ? lib.agentFlowRules(s, c.flow) : lib.agentRules(c.message, s)), c.message || "", c.flow));
  const fl = lib.agentGuard(out, s, c.message || ""); const plan = lib.agentPlan(out, s);
  const sc = lib.agentScore(Object.assign({}, c, { lang: "en" }), out, fl, plan);
  if (!sc.ok) rb.push(c.id + ": " + sc.reasons.join("; "));
}
t("standard answers pass English gate cases", rb.length === 0, rb);

// ---- first year (from the account only; no predictions) ----
{ const st = lib.demoState(IST(2026, 9, 25)); const B = st.sips.find(s => s.id === "B"); const y = lib.firstYear(B, st);
  t("first year: 4 paid, avg 2.5 months by date, down 88", y.paid === 4 && y.avg_months === 2.5 && /down ₹88/.test(y.move) && y.held.length === 4 && y.held[0].months === 4 && y.held[3].months === 1, y);
  t("first year line has no prediction", /no one can promise/.test(y.line) && !/will (grow|rise|double)/.test(y.line));
  t("view carries year1 per SIP", lib.agentView(st).sips.every(s => s.year1 && s.year1.paid > 0));
  const st2 = lib.stateWith(["sip_low_balance"]); const fx = lib.agentFlowRules(st2, { kind: "fix", sip_id: "B" });
  t("fix plan includes the first-year line", fx.next.some(x => /first year so far/i.test(x)), fx.next);
  const st3 = lib.demoState(IST(2026, 9, 25)); const obs = lib.runSipDay(st3, "low_balance"); const f = obs.find(o => o.kind === "payment_failed");
  t("failure alert carries the first-year line", f && /on average your money has been in/.test(f.year1), f && f.year1); }
console.log(`agent: ${pass} passed, ${fail} failed`);
if (fail) { console.log(F.join("\n")); process.exit(1); }
