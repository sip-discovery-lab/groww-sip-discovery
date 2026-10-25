const CASES = /*@@CASES*/[];
const CARE_CASES = /*@@CARE_CASES*/[];
const AGENT_CASES = /*@@AGENT_CASES*/[];
const APP_PAGE = /*@@APP*/"";
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="22" fill="#00b386"/><path d="M48 18 24 27v18c0 15 10.2 25.8 24 28.5C61.8 70.8 72 60 72 45V27z" fill="none" stroke="#fff" stroke-width="6" stroke-linejoin="round"/><path d="M48 58s-10-6-10-12.6A5.5 5.5 0 0 1 48 42a5.5 5.5 0 0 1 10 3.4C58 52 48 58 48 58z" fill="#fff"/></svg>`;
const SW_JS = `self.addEventListener("install", e => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("push", e => e.waitUntil((async () => {
  let n = null;
  try { const sub = await self.registration.pushManager.getSubscription(); const r = await fetch("/api/agent/latest?endpoint=" + encodeURIComponent(sub ? sub.endpoint : "")); const j = await r.json(); n = j.notification; } catch (err) {}
  const title = n ? (/^SIP Care/.test(n.title) ? n.title : "SIP Care · " + n.title) : "SIP Care";
  const body = n ? n.body : "SIP Care has an update on your SIPs.";
  await self.registration.showNotification(title, { body, icon: "/icon.svg", badge: "/icon.svg", tag: n ? n.id : "sipcare", data: { url: n ? "/#/note/" + n.obs_id : "/" } });
})()));
self.addEventListener("notificationclick", e => { e.notification.close(); const url = (e.notification.data && e.notification.data.url) || "/"; e.waitUntil((async () => { const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true }); for (const c of all) { if ("focus" in c) { c.navigate(url); return c.focus(); } } return self.clients.openWindow(url); })()); });`;
const QUALITY_PAGE = /*@@QUALITY*/"";
const PAGE = /*@@PAGE*/"";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, ts TEXT, chip TEXT, ai_situation TEXT, situation TEXT, confidence REAL, lang TEXT, actions TEXT, used_ai INTEGER, flags TEXT, redacted TEXT, latency_ms INTEGER, model TEXT, prompt_version TEXT, tester INTEGER, scenario TEXT, error TEXT)`,
  `CREATE TABLE IF NOT EXISTS feedback (session_id TEXT, ts TEXT, understood TEXT, chosen TEXT, clarity INTEGER, helpful TEXT, seconds INTEGER, tester INTEGER, scenario TEXT)`,
  `CREATE TABLE IF NOT EXISTS eval_runs (id TEXT PRIMARY KEY, ts TEXT, model TEXT, prompt_version TEXT, n INTEGER, passed INTEGER, breaks INTEGER, score REAL, gate INTEGER, complete INTEGER, errors INTEGER)`,
  `CREATE TABLE IF NOT EXISTS eval_cases (run_id TEXT, case_id TEXT, situation TEXT, actions TEXT, ok INTEGER, reasons TEXT, breaks INTEGER, summary TEXT, error TEXT, PRIMARY KEY (run_id, case_id))`,
  `CREATE TABLE IF NOT EXISTS usage (day TEXT, kind TEXT, n INTEGER, PRIMARY KEY (day, kind))`,
  `CREATE TABLE IF NOT EXISTS care_cache (k TEXT PRIMARY KEY, ts TEXT, body TEXT)`,
  `CREATE TABLE IF NOT EXISTS care_events (session_id TEXT, ts TEXT, event TEXT, data TEXT)`,
  `CREATE TABLE IF NOT EXISTS agent_sessions (id TEXT PRIMARY KEY, created TEXT, updated TEXT, state TEXT, history TEXT, pending TEXT, msgs INTEGER)`,
  `CREATE TABLE IF NOT EXISTS push_subs (session_id TEXT PRIMARY KEY, endpoint TEXT, origin TEXT, created TEXT)`,
  `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)`,
];
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  for (const q of SCHEMA) await db.prepare(q).run();
  schemaReady = true;
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const now = () => new Date().toISOString();
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
const day = () => now().slice(0, 10);

async function bump(db, kind) {
  await db.prepare(`INSERT INTO usage (day, kind, n) VALUES (?, ?, 1) ON CONFLICT(day, kind) DO UPDATE SET n = n + 1`).bind(day(), kind).run();
  const r = await db.prepare(`SELECT n FROM usage WHERE day = ? AND kind = ?`).bind(day(), kind).first();
  return r ? r.n : 1;
}

async function gateStatus(db, env, version) {
  version = version || PROMPT_VERSION;
  const model = env.MODEL || DEFAULT_MODEL;
  const last = await db.prepare(`SELECT * FROM eval_runs WHERE complete = 1 AND model = ? AND prompt_version = ? ORDER BY ts DESC LIMIT 1`).bind(model, version).first();
  return { model, prompt_version: version, passed: !!(last && last.gate), last: last || null, min_score: GATE_MIN_SCORE };
}

async function readJson(req) { try { return await req.json(); } catch (e) { return {}; } }
const dayNum = v => { const n = parseInt(v, 10); return n >= 1 && n <= 31 ? n : null; };

async function runAI(env, input) {
  const r = redact(input.text);
  const clean = { chip: SITUATIONS[input.chip] ? input.chip : null, text: r.text, sip_day: dayNum(input.sip_day), salary_day: dayNum(input.salary_day), redacted: r.found };
  const t0 = Date.now();
  const raw = await callGemini(env, clean);
  const out = normalise(raw, clean);
  const g = guardOutput(out);
  return { clean, out, safe: g.clean, flags: g.flags, latency: Date.now() - t0 };
}

async function handleHelp(req, env, db) {
  const input = await readJson(req);
  const id = uid();
  const gate = await gateStatus(db, env);
  const r = redact(input.text);
  const base = { chip: SITUATIONS[input.chip] ? input.chip : null, text: r.text, sip_day: dayNum(input.sip_day), salary_day: dayNum(input.salary_day), redacted: r.found };
  let answer, ai = null, err = "", flags = [], latency = 0, aiSit = null;
  const used = await bump(db, "help");
  if (!gate.passed) {
    answer = buildAnswer(keywordSituation(base), null, { used_ai: false, notice: "AI answers are off until the quality check passes. Showing standard help." });
  } else if (used > HELP_DAILY_CAP) {
    answer = buildAnswer(keywordSituation(base), null, { used_ai: false, notice: "Today's free AI limit is used up. Showing standard help." });
  } else {
    try {
      ai = await runAI(env, input);
      flags = ai.flags; latency = ai.latency; aiSit = ai.out.situation;
      answer = buildAnswer(ai.safe.situation, ai.safe, { used_ai: true, notice: flags.length ? "Part of the AI answer broke a safety rule and was removed." : "" });
    } catch (e) {
      err = String(e.message || e);
      answer = buildAnswer(keywordSituation(base), null, { used_ai: false, notice: `AI is unavailable right now (${err}). Showing standard help.` });
    }
  }
  answer.session_id = id;
  answer.redacted = base.redacted;
  await db.prepare(`INSERT INTO sessions (id, ts, chip, ai_situation, situation, confidence, lang, actions, used_ai, flags, redacted, latency_ms, model, prompt_version, tester, scenario, error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, now(), base.chip, aiSit, answer.situation, answer.confidence, answer.language, answer.options.map(o => o.id).join(","), answer.used_ai ? 1 : 0, flags.join(" | "), base.redacted.join(","), latency, gate.model, PROMPT_VERSION, input.tester ? 1 : 0, String(input.scenario || "").slice(0, 40), err.slice(0, 300)).run();
  return json(answer);
}

async function handleFeedback(req, env, db) {
  const b = await readJson(req);
  if (!b.session_id) return json({ ok: false, error: "missing session_id" }, 400);
  const clarity = Math.max(0, Math.min(5, parseInt(b.clarity, 10) || 0));
  const chosen = ACTIONS[b.chosen] || b.chosen === "none" ? b.chosen : "";
  const understood = ["yes", "partly", "no"].includes(b.understood) ? b.understood : "";
  const helpful = ["yes", "no"].includes(b.helpful) ? b.helpful : "";
  await db.prepare(`INSERT INTO feedback (session_id, ts, understood, chosen, clarity, helpful, seconds, tester, scenario) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(String(b.session_id).slice(0, 64), now(), understood, chosen, clarity, helpful, Math.max(0, parseInt(b.seconds, 10) || 0), b.tester ? 1 : 0, String(b.scenario || "").slice(0, 40)).run();
  return json({ ok: true });
}

// Two quality-check suites: the original helper and the SIP Care agent.
const SUITES = {
  helper: {
    version: PROMPT_VERSION, cases: CASES,
    meta: c => ({ id: c.id, from: c.from, lang: c.lang, text: c.text, expect: c.expect, alt: c.alt || [], main: c.main }),
    run: async (env, c) => {
      const ai = await runAI(env, { text: c.text, sip_day: c.sip_day, salary_day: c.salary_day });
      const sc = scoreCase(c, ai.out, ai.flags, { redacted: ai.clean.redacted });
      return { situation: ai.out.situation, actions: ai.out.action_order.join(","), ok: sc.ok ? 1 : 0, reasons: sc.reasons.join(" | "), breaks: sc.breaks, summary: ai.out.summary.slice(0, 300) };
    },
  },
  care: {
    version: CARE_VERSION, cases: CARE_CASES,
    meta: c => ({ id: c.id, from: c.from, lang: c.lang, text: c.state.bank_message, sip: `${"\u20b9"}${c.state.amount} on the ${c.state.sip_day}, salary ${c.state.salary_day ? "on the " + c.state.salary_day : "unknown"}`, expect: c.expect_cause, alt: [], main: c.must_plan }),
    run: async (env, c) => {
      const ai = await runCareAI(env, c.state, c.lang);
      const sc = careScore(c, ai.out, ai.flags);
      return { situation: ai.out.cause, actions: ai.out.plan.join(","), ok: sc.ok ? 1 : 0, reasons: sc.reasons.join(" | "), breaks: sc.breaks, summary: (ai.out.found + " || " + ai.out.home_message).slice(0, 400) };
    },
  },
};
SUITES.agent = {
  version: AGENT_VERSION, cases: AGENT_CASES,
  meta: c => ({ id: c.id, from: c.from, lang: c.lang, text: c.message + (c.situations && c.situations.length ? `  [account: ${c.situations.join(", ").replace(/_/g, " ")}]` : ""), sip: c.sip ? "SIP " + c.sip : "", expect: (c.topic || []).join(" / "), alt: [], main: (c.must || []).concat((c.forbid || []).map(x => "not " + x)).concat(c.no_actions ? ["no action"] : []) }),
  run: async (env, c, db) => {
    const st = stateWith(c.situations || []);
    if (c.patch) for (const [id, v] of Object.entries(c.patch)) Object.assign(sipById(st, id), v);
    const r = await runAgentAI(env, st, c.message, c.lang, [], db);
    const sc = agentScore(c, r.out, r.flags, r.plan);
    const acts = r.plan.auto.map(a => a.type + "(auto)").concat(r.plan.proposals.map(p => p.type + "(confirm)"));
    return { situation: r.out.topic + (r.out.sip_id ? " · " + r.out.sip_id : ""), actions: acts.join(", "), ok: sc.ok ? 1 : 0, reasons: sc.reasons.join(" | "), breaks: sc.breaks, summary: [r.out.answer, r.out.found.join(" / "), r.out.next.join(" / ")].join(" || ").slice(0, 500) };
  },
};
const suiteOf = v => SUITES[v] ? v : "helper";

async function evalStart(req, env, db) {
  const b = await readJson(req);
  const S = SUITES[suiteOf(b.suite)];
  // Runs where every AI call failed (e.g. key missing) used no AI quota, so they don't start the cooldown.
  const recent = await db.prepare(`SELECT ts FROM eval_runs WHERE prompt_version = ? AND NOT (complete = 1 AND errors >= n) ORDER BY ts DESC LIMIT 1`).bind(S.version).first();
  if (recent && Date.now() - Date.parse(recent.ts) < EVAL_COOLDOWN_MIN * 60000) {
    const wait = Math.ceil((EVAL_COOLDOWN_MIN * 60000 - (Date.now() - Date.parse(recent.ts))) / 60000);
    return json({ ok: false, error: `A check ran recently. To save the free AI limit, the next one can start in ${wait} min.` }, 429);
  }
  const id = uid();
  await db.prepare(`INSERT INTO eval_runs (id, ts, model, prompt_version, n, passed, breaks, score, gate, complete, errors) VALUES (?,?,?,?,?,0,0,0,0,0,0)`).bind(id, now(), env.MODEL || DEFAULT_MODEL, S.version, S.cases.length).run();
  return json({ ok: true, run_id: id, cases: S.cases.map(c => c.id) });
}

const suiteForRun = run => Object.values(SUITES).find(x => x.version === run.prompt_version) || SUITES.helper;

async function evalCase(req, env, db) {
  const b = await readJson(req);
  const run = await db.prepare(`SELECT * FROM eval_runs WHERE id = ?`).bind(String(b.run_id || "")).first();
  if (!run || run.complete) return json({ ok: false, error: "unknown or finished run" }, 400);
  const S = suiteForRun(run);
  const c = S.cases.find(x => x.id === b.case_id);
  if (!c) return json({ ok: false, error: "unknown case" }, 400);
  const done = await db.prepare(`SELECT * FROM eval_cases WHERE run_id = ? AND case_id = ?`).bind(run.id, c.id).first();
  if (done && !done.error) return json({ ok: true, case: done });
  await bump(db, "eval");
  let row;
  try {
    row = Object.assign(await S.run(env, c, db), { error: "" });
  } catch (e) {
    row = { situation: "", actions: "", ok: 0, reasons: "AI call failed", breaks: 0, summary: "", error: String(e.message || e).slice(0, 300) };
  }
  await db.prepare(`INSERT OR REPLACE INTO eval_cases (run_id, case_id, situation, actions, ok, reasons, breaks, summary, error) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(run.id, c.id, row.situation, row.actions, row.ok, row.reasons, row.breaks, row.summary, row.error).run();
  return json({ ok: true, case: Object.assign({ run_id: run.id, case_id: c.id }, row) });
}

async function evalFinish(req, env, db) {
  const b = await readJson(req);
  const run = await db.prepare(`SELECT * FROM eval_runs WHERE id = ?`).bind(String(b.run_id || "")).first();
  if (!run) return json({ ok: false, error: "unknown run" }, 400);
  const S = suiteForRun(run);
  const rows = (await db.prepare(`SELECT * FROM eval_cases WHERE run_id = ?`).bind(run.id).all()).results || [];
  const passed = rows.filter(r => r.ok).length, breaks = rows.reduce((a, r) => a + (r.breaks || 0), 0), errors = rows.filter(r => r.error).length;
  const n = S.cases.length;
  const score = n ? passed / n : 0;
  const gate = rows.length === n && errors === 0 && breaks === 0 && score >= GATE_MIN_SCORE ? 1 : 0;
  await db.prepare(`UPDATE eval_runs SET passed = ?, breaks = ?, score = ?, gate = ?, complete = 1, errors = ? WHERE id = ?`).bind(passed, breaks, score, gate, errors, run.id).run();
  return json({ ok: true, run_id: run.id, n, done: rows.length, passed, breaks, errors, score, gate: !!gate });
}

async function evalLatest(req, env, db, url) {
  const suite = suiteOf(url.searchParams.get("suite"));
  const S = SUITES[suite];
  const id = url.searchParams.get("id");
  const runs = (await db.prepare(`SELECT * FROM eval_runs WHERE prompt_version = ? ORDER BY ts DESC LIMIT 10`).bind(S.version).all()).results || [];
  const pick = id ? runs.find(r => r.id === id) || (await db.prepare(`SELECT * FROM eval_runs WHERE id = ?`).bind(id).first()) : runs.find(r => r.complete);
  const cases = pick ? ((await db.prepare(`SELECT * FROM eval_cases WHERE run_id = ? ORDER BY case_id`).bind(pick.id).all()).results || []) : [];
  return json({ ok: true, suite, gate: await gateStatus(db, env, S.version), runs, run: pick || null, cases, case_meta: S.cases.map(S.meta) });
}

// ---------- SIP Care agent ----------
async function runCareAI(env, state, lang) {
  const t0 = Date.now();
  state = Object.assign({}, state, { bank_message: redact(state.bank_message).text });
  const raw = await callGemini(env, { state, lang }, { system: careSystemPrompt(), user: careUserPrompt(state, lang), schema: CARE_SCHEMA, mock: env.GEMINI_CARE_MOCK });
  const out = careNormalise(raw);
  const g = careGuard(out, state);
  return { out, safe: g.clean, flags: g.flags, latency: Date.now() - t0 };
}

const LANGS = ["en", "hinglish", "hi"];
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" };
const cjson = (obj, status = 200) => { const r = json(obj, status); for (const [k, v] of Object.entries(CORS)) r.headers.set(k, v); return r; };
const CARE_CACHE_MIN = 30;

// ---------- SIP Care agent routes ----------
// Background guideline check: SIP Care may look up current rules on the web to keep answers accurate.
// Only plain facts are kept; links, site names and brands are removed and never shown to the user.
const RESEARCH_TOPICS = { payment_failed: "what happens when a mutual fund SIP instalment fails in India, penalties, auto-cancellation after consecutive failures, and how to pay a missed instalment", not_reflecting: "how long mutual fund units take to show after a SIP debit in India, NAV cut-off rules and refunds for failed orders", stop_sip: "how to stop or cancel a mutual fund SIP in India, processing time, and what happens to units already held", growth: "how mutual fund SIP value changes over time, NAV, market-linked returns and why returns are not guaranteed", withdraw: "how to redeem mutual fund units in India, cut-off time, how many working days for money to reach the bank for equity and liquid funds, exit load", tax: "current capital gains tax on equity mutual fund redemptions in India, short-term and long-term rates and exemption limit, SIP holding period per instalment", exit_load: "how exit load works on equity mutual fund SIPs in India and holding period per instalment", change_sip: "how to change SIP date or amount, skip or pause a SIP in India and when it takes effect", autopay: "how SIP AutoPay mandates work in India, why they expire or fail, and how long a new mandate takes", missed_instalment: "what happens when a mutual fund SIP instalment is missed in India", will_sip_cancel: "when a mutual fund SIP gets cancelled automatically in India after failed instalments" };
function cleanNotes(t) {
  return String(t || "").split(/\n+/).map(l => l.replace(/\[[^\]]*\]\([^)]*\)/g, "").replace(/https?:\/\/\S+|www\.\S+/g, "").replace(/\(([^)]*\.(com|in|org)[^)]*)\)/gi, "").trim())
    .filter(l => l && !SOURCE_LEAK.test(l)).join("\n").slice(0, 1500);
}
async function researchNotes(env, db, topic, gate) {
  if (!RESEARCH_TOPICS[topic] || env.RESEARCH === "off" || !gate.passed) return "";
  const key = `research:v1:${topic}`;
  try {
    const hit = await db.prepare(`SELECT ts, body FROM care_cache WHERE k = ?`).bind(key).first();
    if (hit && Date.now() - Date.parse(hit.ts) < 7 * 86400000) return hit.body;
    if ((await bump(db, "research")) > 60) return hit ? hit.body : "";
    const raw = await callGemini(env, { topic }, { plain: true, tools: [{ google_search: {} }], mock: env.GEMINI_RESEARCH_MOCK,
      system: "You check current Indian mutual fund rules for an internal knowledge base. Reply with 4-8 short plain-text bullet facts (numbers, timelines, steps). No links, no website, company or regulator names, no advice.",
      user: `Current rules (${new Date().getFullYear()}): ${RESEARCH_TOPICS[topic]}.` });
    const notes = cleanNotes(raw);
    if (notes) await db.prepare(`INSERT OR REPLACE INTO care_cache (k, ts, body) VALUES (?,?,?)`).bind(key, now(), notes).run();
    return notes;
  } catch (e) { return ""; }
}

async function runAgentAI(env, st, message, lang, history, db) {
  const red = redact(message);
  const t0 = Date.now();
  let notes = "";
  if (db) { const gate = await gateStatus(db, env, AGENT_VERSION); const topic = agentRules(red.text, st).topic; notes = await researchNotes(env, db, topic, { passed: gate.passed || env.RESEARCH === "always" }); }
  const raw = await callGemini(env, { st, message: red.text, lang }, { system: agentSystemPrompt(), user: agentUserPrompt(st, red.text, lang, history, notes), schema: AGENT_SCHEMA, mock: env.GEMINI_AGENT_MOCK });
  const out = agentNormalise(raw, st);
  const flags = agentGuard(out, st, red.text);
  const plan = agentPlan(out, st);
  return { out, flags, plan, redacted: red.found, latency: Date.now() - t0, researched: !!notes };
}

async function loadSession(db, id) {
  const row = id ? await db.prepare(`SELECT * FROM agent_sessions WHERE id = ?`).bind(id).first() : null;
  if (!row) return null;
  const st = JSON.parse(row.state);
  if (st.v !== AGENT_VERSION) return null; // session from an older version: start fresh
  return { id: row.id, state: st, history: JSON.parse(row.history || "[]"), pending: JSON.parse(row.pending || "[]"), msgs: row.msgs || 0, created: row.created };
}
async function saveSession(db, s) {
  await db.prepare(`INSERT OR REPLACE INTO agent_sessions (id, created, updated, state, history, pending, msgs) VALUES (?,?,?,?,?,?,?)`)
    .bind(s.id, s.created || now(), now(), JSON.stringify(s.state), JSON.stringify(s.history.slice(-12)), JSON.stringify(s.pending), s.msgs || 0).run();
}
async function newSession(db, env) { const st = demoState(env.NOW_MS ? Number(env.NOW_MS) : undefined); st.v = AGENT_VERSION; st.last_tick = Date.now(); st.last_check = now(); const s = { id: uid(), created: now(), state: st, history: [], pending: [], msgs: 0 }; await saveSession(db, s); return s; }

async function agentStart(req, env, db) {
  const b = await readJson(req);
  let s = b.reset ? null : await loadSession(db, String(b.session_id || ""));
  if (!s) { s = await newSession(db, env); if (AGENT_LANGS.includes(b.lang)) s.state.lang = b.lang; await saveSession(db, s); }
  const gate = await gateStatus(db, env, AGENT_VERSION);
  await careLog(db, s.id, b.reset ? "reset" : "start", {});
  return cjson(Object.assign(agentPayload(s, gate), { fresh: [] }));
}

function obsSummary(o) { return { id: o.id, kind: o.kind, title: o.title, notify: o.notify, level: o.level, status: o.status, ask: o.ask || "" }; }
function agentPayload(s, gate) {
  return { ok: true, session_id: s.id, view: agentView(s.state), pending: s.pending, history: s.history, situations: Object.entries(SITUATIONS_DEMO).map(([k, v]) => ({ id: k, label: v.label })), gate: { passed: gate.passed, score: gate.last ? gate.last.score : null } };
}

const hashStr = t => { let h = 5381; for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };

function record(s, list) {
  const st = s.state;
  for (const o of list) {
    st.observations.unshift(o);
    st.inbox.unshift({ id: "n" + o.id, title: o.title, body: o.notify, obs_id: o.id, level: o.level, ask: o.ask || "", read: false, at: now() });
  }
  st.observations = st.observations.slice(0, 60); st.inbox = st.inbox.slice(0, 60);
}

// The always-on check: runs from the open app and from Cloudflare Cron.
async function tickSession(env, db, s) {
  const st = s.state;
  const fresh = monitorTick(st);
  record(s, fresh);
  for (const o of fresh) await careLog(db, s.id, "observe", { kind: o.kind });
  s.pending = s.pending.filter(p => !validateAction(p, st));
  st.last_tick = Date.now(); st.last_check = now();
  return fresh;
}

const TICK_MIN_MS = 12000;
async function agentTick(req, env, db) {
  const b = await readJson(req);
  const s = await loadSession(db, String(b.session_id || ""));
  if (!s) return cjson({ ok: false, error: "session not found; reload the app" }, 400);
  let fresh = [];
  const since = Date.now() - (s.state.last_tick || 0);
  if ((b.force && since > (env.TICK_FORCE_MS ?? 1500)) || (s.state.autoplay && since > TICK_MIN_MS)) { fresh = await tickSession(env, db, s); await saveSession(db, s); }
  const gate = await gateStatus(db, env, AGENT_VERSION);
  return cjson(Object.assign(agentPayload(s, gate), { fresh: fresh.map(obsSummary), next_tick_ms: TICK_MIN_MS }));
}

async function agentSituation(req, env, db) {
  const b = await readJson(req);
  const s = await loadSession(db, String(b.session_id || ""));
  if (!s) return cjson({ ok: false, error: "session not found; reload the app" }, 400);
  if (!SITUATIONS_DEMO[b.kind]) return cjson({ ok: false, error: "unknown situation" }, 400);
  const fresh = injectSituation(s.state, b.kind);
  record(s, fresh);
  await saveSession(db, s);
  await careLog(db, s.id, "situation", { kind: b.kind, made: fresh.length });
  const sub = fresh.length ? await db.prepare(`SELECT * FROM push_subs WHERE session_id = ?`).bind(s.id).first() : null;
  if (sub) { try { await sendPush(env, db, sub); } catch (e) {} }
  return cjson(Object.assign(agentPayload(s, await gateStatus(db, env, AGENT_VERSION)), { fresh: fresh.map(obsSummary), note: fresh.length ? "" : "That situation is already on (or can't apply right now)." }));
}

async function agentSettings(req, env, db) {
  const b = await readJson(req);
  const s = await loadSession(db, String(b.session_id || ""));
  if (!s) return cjson({ ok: false, error: "session not found" }, 400);
  if (typeof b.autoplay === "boolean") s.state.autoplay = b.autoplay;
  if (AGENT_LANGS.includes(b.lang)) s.state.lang = b.lang;
  if (b.read === "all") s.state.inbox.forEach(i => { i.read = true; });
  else if (Array.isArray(b.read)) s.state.inbox.forEach(i => { if (b.read.includes(i.id)) i.read = true; });
  await saveSession(db, s);
  return cjson(agentPayload(s, await gateStatus(db, env, AGENT_VERSION)));
}

// ---------- Web Push (no payload: the service worker fetches the latest alert) ----------
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function vapidKeys(db) {
  const row = await db.prepare(`SELECT v FROM kv WHERE k = 'vapid'`).first();
  if (row) return JSON.parse(row.v);
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const keys = { priv: await crypto.subtle.exportKey("jwk", kp.privateKey), pub: b64u(await crypto.subtle.exportKey("raw", kp.publicKey)) };
  await db.prepare(`INSERT OR IGNORE INTO kv (k, v) VALUES ('vapid', ?)`).bind(JSON.stringify(keys)).run();
  return JSON.parse((await db.prepare(`SELECT v FROM kv WHERE k = 'vapid'`).first()).v);
}
async function vapidJwt(keys, endpoint, subject) {
  const enc = o => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = enc({ typ: "JWT", alg: "ES256" }) + "." + enc({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject });
  const key = await crypto.subtle.importKey("jwk", keys.priv, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(unsigned));
  return unsigned + "." + b64u(sig);
}
async function sendPush(env, db, sub) {
  const keys = await vapidKeys(db);
  const jwt = await vapidJwt(keys, sub.endpoint, sub.origin || "mailto:sip-care-demo@example.com");
  const r = await (env.PUSH_FETCH || fetch)(sub.endpoint, { method: "POST", headers: { TTL: "3600", Urgency: "normal", Authorization: `vapid t=${jwt}, k=${keys.pub}`, "Content-Length": "0" } });
  if (r.status === 404 || r.status === 410) await db.prepare(`DELETE FROM push_subs WHERE session_id = ?`).bind(sub.session_id).run();
  return r.status;
}
async function agentPushKey(req, env, db) { return cjson({ ok: true, key: (await vapidKeys(db)).pub }); }
async function agentPushSubscribe(req, env, db) {
  const b = await readJson(req);
  const s = await loadSession(db, String(b.session_id || ""));
  if (!s) return cjson({ ok: false, error: "session not found" }, 400);
  const ep = b.subscription && b.subscription.endpoint;
  if (!ep || !/^https:\/\//.test(ep)) return cjson({ ok: false, error: "bad subscription" }, 400);
  await db.prepare(`INSERT OR REPLACE INTO push_subs (session_id, endpoint, origin, created) VALUES (?,?,?,?)`).bind(s.id, ep, new URL(req.url).origin, now()).run();
  return cjson({ ok: true });
}
async function agentLatest(req, env, db, url) {
  const ep = url.searchParams.get("endpoint") || "";
  const sid = url.searchParams.get("session") || (ep ? ((await db.prepare(`SELECT session_id FROM push_subs WHERE endpoint = ?`).bind(ep).first()) || {}).session_id : "");
  const s = sid ? await loadSession(db, sid) : null;
  if (!s) return cjson({ ok: false, error: "no session" }, 404);
  const n = s.state.inbox.find(i => !i.read && i.level !== "quiet") || s.state.inbox[0];
  return cjson({ ok: true, notification: n || null, unread: s.state.inbox.filter(i => !i.read).length });
}

// Cloudflare Cron: keeps SIP Care checking for everyone, even with the app closed.
async function cronTick(env) {
  const db = env.DB; if (!db) return;
  await ensureSchema(db);
  const cutoff = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
  const rows = (await db.prepare(`SELECT id FROM agent_sessions WHERE updated > ? ORDER BY updated DESC LIMIT 40`).bind(cutoff).all()).results || [];
  let ticked = 0, pushed = 0;
  for (const r of rows) {
    const s = await loadSession(db, r.id);
    if (!s || !s.state.autoplay || Date.now() - (s.state.last_tick || 0) < 55000) continue;
    const fresh = await tickSession(env, db, s);
    await saveSession(db, s); ticked++;
    if (fresh.length) {
      const sub = await db.prepare(`SELECT * FROM push_subs WHERE session_id = ?`).bind(s.id).first();
      if (sub) { try { await sendPush(env, db, sub); pushed++; } catch (e) {} }
    }
  }
  return { ticked, pushed };
}

const AGENT_MSG_CAP = 40;
async function agentMessage(req, env, db) {
  const b = await readJson(req);
  const s = await loadSession(db, String(b.session_id || ""));
  if (!s) return cjson({ ok: false, error: "session not found; reload the app" }, 400);
  const lang = AGENT_LANGS.includes(b.lang) ? b.lang : (s.state.lang || "en");
  const message = String(b.message || "").slice(0, 600).trim();
  if (!message) return cjson({ ok: false, error: "empty message" }, 400);
  const gate = await gateStatus(db, env, AGENT_VERSION);
  let out, flags = [], plan, used_ai = false, notice = "", err = "", latency = 0;
  const red = redact(message);
  if (gate.passed && s.msgs < AGENT_MSG_CAP && (await bump(db, "agent")) <= HELP_DAILY_CAP) {
    try {
      const r = await runAgentAI(env, s.state, message, lang, s.history, db);
      out = r.out; flags = r.flags; plan = r.plan; latency = r.latency; used_ai = true;
      if (flags.length) {
        // Unsafe text: keep the user safe by switching this answer to the rule-based agent.
        out = agentNormalise(agentRules(red.text, s.state), s.state);
        plan = agentPlan(out, s.state); used_ai = false;
        notice = "Part of the AI answer broke a safety rule, so SIP Care used its standard answer.";
      }
    } catch (e) { err = String(e.message || e); notice = `AI is unavailable right now (${err}). SIP Care used its standard answer.`; }
  } else if (!gate.passed) notice = "AI is off until SIP Care passes its quality check. Using standard answers.";
  else notice = "Today's free AI limit is used up. Using standard answers.";
  if (!out) { out = agentNormalise(agentRules(red.text, s.state), s.state); plan = agentPlan(out, s.state); }
  if (red.found.length && !/share|PAN|OTP/i.test(out.answer)) out.answer = "Please don't share personal details like PAN, OTP or account numbers here; I've removed them. " + out.answer;
  const done = plan.auto.map(a => applyAction(a, s.state));
  const dupes = s.pending.filter(p => plan.proposals.some(q => q.type === p.type && q.sip_id === p.sip_id));
  plan.proposals = plan.proposals.map(q => dupes.find(p => p.type === q.type && p.sip_id === q.sip_id) || q);
  s.pending = s.pending.filter(p => !dupes.includes(p)).concat(plan.proposals);
  s.history.push({ role: "user", text: red.text }, { role: "agent", text: out.answer });
  s.msgs++;
  await saveSession(db, s);
  await careLog(db, s.id, "message", { topic: out.topic, used_ai: used_ai ? 1 : 0, flags: flags.join(" | "), error: err.slice(0, 200), latency, auto: plan.auto.map(a => a.type).join(","), proposed: plan.proposals.map(p => p.type).join(","), lang, redacted: red.found.join(",") });
  return cjson({ ok: true, shown: red.text, used_ai, notice, topic: out.topic, intent: out.topic, sip_id: out.sip_id, found: out.found, answer: out.answer, reply: out.answer, next: out.next, followups: out.followups, done, proposals: plan.proposals, skipped: plan.skipped, redacted: red.found, pending: s.pending, view: agentView(s.state) });
}

async function agentConfirm(req, env, db) {
  const b = await readJson(req);
  const s = await loadSession(db, String(b.session_id || ""));
  if (!s) return cjson({ ok: false, error: "session not found; reload the app" }, 400);
  const ids = Array.isArray(b.proposal_ids) ? b.proposal_ids : [];
  const chosen = s.pending.filter(p => ids.includes(p.id));
  if (!chosen.length) return cjson({ ok: false, error: "nothing to confirm" }, 400);
  const steps = ["Checked your SIP and bank details"], failed = [];
  for (const p of chosen) {
    const why = validateAction(p, s.state);
    if (why) { failed.push({ title: p.title, why }); continue; }
    steps.push(applyAction(p, s.state));
  }
  s.pending = s.pending.filter(p => !ids.includes(p.id));
  const msg = homeMessage(steps.slice(1));
  s.history.push({ role: "agent", text: msg });
  await saveSession(db, s);
  await careLog(db, s.id, "confirm", { actions: chosen.map(p => p.type).join(","), failed: failed.length });
  return cjson({ ok: true, steps, failed, home_message: msg, pending: s.pending, view: agentView(s.state) });
}

async function agentDecline(req, env, db) {
  const b = await readJson(req);
  const s = await loadSession(db, String(b.session_id || ""));
  if (!s) return cjson({ ok: false, error: "session not found" }, 400);
  const before = s.pending.length;
  s.pending = s.pending.filter(p => p.id !== b.proposal_id);
  await saveSession(db, s);
  await careLog(db, s.id, "decline", {});
  return cjson({ ok: true, removed: before - s.pending.length, pending: s.pending, view: agentView(s.state) });
}

async function agentStats(req, env, db) {
  const rows = (await db.prepare(`SELECT session_id, event, ts, data FROM care_events WHERE event IN ('start','reset','message','confirm','decline','feedback') ORDER BY ts`).all()).results || [];
  const by = {}; for (const r of rows) (by[r.session_id] = by[r.session_id] || []).push(r);
  const ss = Object.values(by).filter(ev => ev.some(e => e.event === "start" || e.event === "reset"));
  const fixed = ss.filter(ev => ev.some(e => e.event === "confirm"));
  const times = fixed.map(ev => (Date.parse(ev.find(e => e.event === "confirm").ts) - Date.parse(ev[0].ts)) / 1000).filter(x => x >= 0 && x < 3600).sort((a, b) => a - b);
  const msgs = rows.filter(r => r.event === "message").map(r => JSON.parse(r.data || "{}"));
  const fb = (await db.prepare(`SELECT understood, chosen, clarity, helpful FROM feedback WHERE scenario = 'agent'`).all()).results || [];
  return cjson({ ok: true, gate: await gateStatus(db, env, AGENT_VERSION), sessions: ss.length, confirmed_a_fix: fixed.length, fix_rate: ss.length ? fixed.length / ss.length : null,
    median_seconds_to_fix: times.length ? times[Math.floor(times.length / 2)] : null, messages: msgs.length, ai_answers: msgs.filter(m => m.used_ai).length, safety_fallbacks: msgs.filter(m => m.flags).length, ai_errors: msgs.filter(m => m.error).length,
    declined: rows.filter(r => r.event === "decline").length,
    feedback: { n: fb.length, understood_yes: fb.filter(f => f.understood === "yes").length, fixed_yes: fb.filter(f => f.helpful === "yes").length, avg_clarity: fb.length ? fb.reduce((a, f) => a + (f.clarity || 0), 0) / fb.length : null } });
}

async function agentFeedback(req, env, db) {
  const b = await readJson(req);
  if (!b.session_id) return cjson({ ok: false, error: "missing session" }, 400);
  const understood = ["yes", "partly", "no"].includes(b.understood) ? b.understood : "";
  const fixed = ["yes", "no"].includes(b.fixed) ? b.fixed : "";
  const clarity = Math.max(0, Math.min(5, parseInt(b.clarity, 10) || 0));
  await db.prepare(`INSERT INTO feedback (session_id, ts, understood, chosen, clarity, helpful, seconds, tester, scenario) VALUES (?,?,?,?,?,?,?,?,?)`).bind(String(b.session_id).slice(0, 64), now(), understood, "", clarity, fixed, 0, 1, "agent").run();
  await careLog(db, String(b.session_id).slice(0, 64), "feedback", {});
  return cjson({ ok: true });
}

async function careDiagnose(req, env, db, url) {
  const b = req.method === "POST" ? await readJson(req) : {};
  const scenario = CARE_SCENARIOS[b.scenario || url.searchParams.get("scenario")] ? (b.scenario || url.searchParams.get("scenario")) : "riya";
  const lang = LANGS.includes(b.lang || url.searchParams.get("lang")) ? (b.lang || url.searchParams.get("lang")) : "en";
  const s = CARE_SCENARIOS[scenario];
  const session = String(b.session_id || url.searchParams.get("session") || uid()).slice(0, 64);
  const gate = await gateStatus(db, env, CARE_VERSION);
  const key = `${scenario}:${lang}:${gate.model}:${CARE_VERSION}`;
  let answer, flags = [], err = "", latency = 0, cached = false;
  if (!gate.passed) {
    answer = careBuild(s, null, { scenario, lang, used_ai: false, notice: "AI is off until SIP Care passes its quality check. Showing the standard fix." });
  } else {
    const hit = await db.prepare(`SELECT ts, body FROM care_cache WHERE k = ?`).bind(key).first();
    if (hit && Date.now() - Date.parse(hit.ts) < CARE_CACHE_MIN * 60000 && !url.searchParams.get("fresh")) {
      answer = JSON.parse(hit.body); cached = true;
    } else if ((await bump(db, "care")) > HELP_DAILY_CAP) {
      answer = careBuild(s, null, { scenario, lang, used_ai: false, notice: "Today's free AI limit is used up. Showing the standard fix." });
    } else {
      try {
        const ai = await runCareAI(env, s, lang);
        flags = ai.flags; latency = ai.latency;
        answer = careBuild(s, ai.safe, { scenario, lang, used_ai: true, notice: flags.length ? "Part of the AI text broke a safety rule and was replaced with standard text." : "" });
        await db.prepare(`INSERT OR REPLACE INTO care_cache (k, ts, body) VALUES (?,?,?)`).bind(key, now(), JSON.stringify(answer)).run();
      } catch (e) {
        err = String(e.message || e);
        answer = careBuild(s, null, { scenario, lang, used_ai: false, notice: `AI is unavailable right now (${err}). Showing the standard fix.` });
      }
    }
  }
  answer.session_id = session; answer.cached = cached;
  answer.gate = { passed: gate.passed, score: gate.last ? gate.last.score : null, breaks: gate.last ? gate.last.breaks : null, checked: gate.last ? gate.last.ts : null };
  await careLog(db, session, "diagnose", { lang, used_ai: answer.used_ai ? 1 : 0, cause: answer.cause, flags: flags.join(" | "), error: err.slice(0, 200), latency });
  return cjson(answer);
}

async function careFix(req, env, db) {
  const b = await readJson(req);
  const scenario = CARE_SCENARIOS[b.scenario] ? b.scenario : "riya";
  const s = CARE_SCENARIOS[scenario];
  const plan = (Array.isArray(b.plan) ? b.plan : []).filter(a => CARE_ACTIONS.includes(a)).slice(0, 3);
  if (!plan.length) return cjson({ ok: false, error: "choose at least one fix" }, 400);
  const steps = ["Checked your SIP and bank details"].concat(plan.map(a => careActionView(a, s).step));
  if (plan.includes("retry_on_payday")) steps.push(`Set a reminder to keep ${inr(s.amount)} ready on ${careNumbers(s).retryDay} ${s.month}`);
  const session = String(b.session_id || uid()).slice(0, 64);
  await careLog(db, session, "fix", { plan: plan.join(",") });
  return cjson({ ok: true, session_id: session, steps, sip_active: true, simulated: true });
}

async function careEvent(req, env, db) {
  const b = await readJson(req);
  const ev = ["home_view", "open_care", "diagnose_view", "fix_tap", "confirm", "fixed_view", "home_fixed_view", "go_back"].includes(b.event) ? b.event : "";
  if (!ev || !b.session_id) return cjson({ ok: false, error: "bad event" }, 400);
  await careLog(db, String(b.session_id).slice(0, 64), ev, { ms: Math.max(0, parseInt(b.ms, 10) || 0) });
  return cjson({ ok: true });
}

async function careLog(db, session, event, data) {
  await db.prepare(`INSERT INTO care_events (session_id, ts, event, data) VALUES (?,?,?,?)`).bind(session, now(), event, JSON.stringify(data || {})).run();
}

async function careStats(req, env, db) {
  const rows = (await db.prepare(`SELECT session_id, event, ts, data FROM care_events ORDER BY ts`).all()).results || [];
  const by = {};
  for (const r of rows) { (by[r.session_id] = by[r.session_id] || []).push(r); }
  const sessions = Object.values(by);
  const has = (ev, e) => ev.some(x => x.event === e);
  const started = sessions.filter(ev => has(ev, "home_view") || has(ev, "diagnose"));
  const opened = started.filter(ev => has(ev, "diagnose"));
  const fixed = started.filter(ev => has(ev, "fix"));
  const times = fixed.map(ev => { const a = ev.find(x => x.event === "home_view") || ev[0]; const z = ev.find(x => x.event === "fix"); return (Date.parse(z.ts) - Date.parse(a.ts)) / 1000; }).filter(x => x >= 0 && x < 3600).sort((a, b) => a - b);
  const diag = rows.filter(r => r.event === "diagnose").map(r => JSON.parse(r.data || "{}"));
  return cjson({
    ok: true, gate: await gateStatus(db, env, CARE_VERSION),
    sessions: started.length, opened_sip_care: opened.length, fixed: fixed.length,
    fix_rate: started.length ? fixed.length / started.length : null,
    median_seconds_to_fix: times.length ? times[Math.floor(times.length / 2)] : null,
    ai_answers: diag.filter(d => d.used_ai).length, ai_flagged: diag.filter(d => d.flags).length, ai_errors: diag.filter(d => d.error).length,
  });
}

async function results(req, env, db) {
  const q = async s => (await db.prepare(s).all()).results || [];
  return json({
    ok: true,
    gate: await gateStatus(db, env),
    sessions: (await db.prepare(`SELECT COUNT(*) AS n, SUM(used_ai) AS ai, SUM(CASE WHEN flags != '' THEN 1 ELSE 0 END) AS flagged, SUM(CASE WHEN redacted != '' THEN 1 ELSE 0 END) AS redacted, SUM(CASE WHEN error != '' THEN 1 ELSE 0 END) AS errors, AVG(CASE WHEN used_ai = 1 THEN latency_ms END) AS avg_ms FROM sessions`).first()),
    by_situation: await q(`SELECT situation, COUNT(*) AS n FROM sessions GROUP BY situation ORDER BY n DESC`),
    feedback: await q(`SELECT tester, scenario, understood, chosen, clarity, helpful, seconds, ts FROM feedback WHERE scenario != 'agent' ORDER BY ts DESC LIMIT 200`),
    usage_today: await q(`SELECT kind, n FROM usage WHERE day = '${day()}'`),
  });
}

async function route(req, env) {
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/+$/, "") || "/";
  if (p === "/" && req.method === "GET") return new Response(APP_PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  if (p === "/sw.js") return new Response(SW_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "service-worker-allowed": "/" } });
  if (p === "/manifest.webmanifest") return new Response(JSON.stringify({ name: "Groww SIP Care (Concept)", short_name: "SIP Care", start_url: "/", display: "standalone", background_color: "#ffffff", theme_color: "#00b386", icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }] }), { headers: { "content-type": "application/manifest+json" } });
  if (p === "/icon.svg") return new Response(ICON_SVG, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });
  if (p === "/helper" && req.method === "GET") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  if (p === "/quality" && req.method === "GET") return new Response(QUALITY_PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  if (req.method === "OPTIONS" && p.startsWith("/api/")) return new Response(null, { status: 204, headers: CORS });
  if (!env.DB) return json({ ok: false, error: "No database bound (add a D1 binding named DB)" }, 500);
  const db = env.DB;
  await ensureSchema(db);
  try {
    if (p === "/api/help" && req.method === "POST") return await handleHelp(req, env, db);
    if (p === "/api/feedback" && req.method === "POST") return await handleFeedback(req, env, db);
    if (p === "/api/gate") return json({ ok: true, gate: await gateStatus(db, env) });
    if (p === "/api/eval/start" && req.method === "POST") return await evalStart(req, env, db);
    if (p === "/api/eval/case" && req.method === "POST") return await evalCase(req, env, db);
    if (p === "/api/eval/finish" && req.method === "POST") return await evalFinish(req, env, db);
    if (p === "/api/eval") return await evalLatest(req, env, db, url);
    if (p === "/api/results") return await results(req, env, db);
    if (p === "/api/agent/start" && req.method === "POST") return await agentStart(req, env, db);
    if (p === "/api/agent/tick" && req.method === "POST") return await agentTick(req, env, db);
    if (p === "/api/agent/settings" && req.method === "POST") return await agentSettings(req, env, db);
    if (p === "/api/agent/push-key") return await agentPushKey(req, env, db);
    if (p === "/api/agent/push-subscribe" && req.method === "POST") return await agentPushSubscribe(req, env, db);
    if (p === "/api/agent/latest") return await agentLatest(req, env, db, url);
    if (p === "/api/agent/situation" && req.method === "POST") return await agentSituation(req, env, db);
    if (p === "/api/agent/message" && req.method === "POST") return await agentMessage(req, env, db);
    if (p === "/api/agent/confirm" && req.method === "POST") return await agentConfirm(req, env, db);
    if (p === "/api/agent/decline" && req.method === "POST") return await agentDecline(req, env, db);
    if (p === "/api/agent/feedback" && req.method === "POST") return await agentFeedback(req, env, db);
    if (p === "/api/agent/stats") return await agentStats(req, env, db);
    if (p === "/api/care/diagnose") return await careDiagnose(req, env, db, url);
    if (p === "/api/care/fix" && req.method === "POST") return await careFix(req, env, db);
    if (p === "/api/care/event" && req.method === "POST") return await careEvent(req, env, db);
    if (p === "/api/care/stats") return await careStats(req, env, db);
    if (p === "/api/care/facts") return cjson({ ok: true, version: CARE_VERSION, causes: CARE_CAUSES, allowed: CARE_ALLOWED, scenario: CARE_SCENARIOS.riya, sources: SOURCES });
    if (p === "/api/facts") return json({ ok: true, prompt_version: PROMPT_VERSION, situations: SITUATIONS, actions: ACTIONS, facts: FACTS, sources: SOURCES });
    return json({ ok: false, error: "not found" }, 404);
  } catch (e) {
    return (p.startsWith("/api/care") || p.startsWith("/api/agent") ? cjson : json)({ ok: false, error: String(e.message || e) }, 500);
  }
}

export default { fetch: route, scheduled: (event, env, ctx) => ctx.waitUntil(cronTick(env)) };
