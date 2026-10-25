const CASES = /*@@CASES*/[];
const CARE_CASES = /*@@CARE_CASES*/[];
const AGENT_CASES = /*@@AGENT_CASES*/[];
const APP_PAGE = /*@@APP*/"";
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
  meta: c => ({ id: c.id, from: c.from, lang: c.lang, text: c.message, sip: c.sip ? "SIP " + c.sip : "", expect: (c.intent || []).join(" / "), alt: [], main: (c.must || []).concat((c.forbid || []).map(x => "not " + x)).concat(c.no_actions ? ["no action"] : []) }),
  run: async (env, c) => {
    const st = demoState();
    if (c.patch) for (const [id, v] of Object.entries(c.patch)) Object.assign(sipById(st, id), v);
    const r = await runAgentAI(env, st, c.message, c.lang, []);
    const sc = agentScore(c, r.out, r.flags, r.plan);
    const acts = r.plan.auto.map(a => a.type + "(auto)").concat(r.plan.proposals.map(p => p.type + "(confirm)"));
    return { situation: r.out.intent + (r.out.sip_id ? " · " + r.out.sip_id : ""), actions: acts.join(", "), ok: sc.ok ? 1 : 0, reasons: sc.reasons.join(" | "), breaks: sc.breaks, summary: r.out.reply.slice(0, 400) };
  },
};
const suiteOf = v => SUITES[v] ? v : "helper";

async function evalStart(req, env, db) {
  const b = await readJson(req);
  const S = SUITES[suiteOf(b.suite)];
  const recent = await db.prepare(`SELECT ts FROM eval_runs WHERE prompt_version = ? ORDER BY ts DESC LIMIT 1`).bind(S.version).first();
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
    row = Object.assign(await S.run(env, c), { error: "" });
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
async function runAgentAI(env, st, message, lang, history) {
  const red = redact(message);
  const t0 = Date.now();
  const raw = await callGemini(env, { st, message: red.text, lang }, { system: agentSystemPrompt(), user: agentUserPrompt(st, red.text, lang, history), schema: AGENT_SCHEMA, mock: env.GEMINI_AGENT_MOCK });
  const out = agentNormalise(raw, st);
  const flags = agentGuard(out, st, red.text);
  const plan = agentPlan(out, st);
  return { out, flags, plan, redacted: red.found, latency: Date.now() - t0 };
}

async function loadSession(db, id) {
  const row = id ? await db.prepare(`SELECT * FROM agent_sessions WHERE id = ?`).bind(id).first() : null;
  if (!row) return null;
  return { id: row.id, state: JSON.parse(row.state), history: JSON.parse(row.history || "[]"), pending: JSON.parse(row.pending || "[]"), msgs: row.msgs || 0, created: row.created };
}
async function saveSession(db, s) {
  await db.prepare(`INSERT OR REPLACE INTO agent_sessions (id, created, updated, state, history, pending, msgs) VALUES (?,?,?,?,?,?,?)`)
    .bind(s.id, s.created || now(), now(), JSON.stringify(s.state), JSON.stringify(s.history.slice(-12)), JSON.stringify(s.pending), s.msgs || 0).run();
}
async function newSession(db) { const s = { id: uid(), created: now(), state: demoState(), history: [], pending: [], msgs: 0 }; await saveSession(db, s); return s; }

async function agentStart(req, env, db) {
  const b = await readJson(req);
  let s = b.reset ? null : await loadSession(db, String(b.session_id || ""));
  if (!s) s = await newSession(db);
  const gate = await gateStatus(db, env, AGENT_VERSION);
  await careLog(db, s.id, b.reset ? "reset" : "start", {});
  return cjson({ ok: true, session_id: s.id, view: agentView(s.state), pending: s.pending, history: s.history, gate: { passed: gate.passed, score: gate.last ? gate.last.score : null } });
}

const AGENT_MSG_CAP = 40;
async function agentMessage(req, env, db) {
  const b = await readJson(req);
  const s = await loadSession(db, String(b.session_id || ""));
  if (!s) return cjson({ ok: false, error: "session not found; reload the app" }, 400);
  const lang = AGENT_LANGS.includes(b.lang) ? b.lang : "en";
  const message = String(b.message || "").slice(0, 600).trim();
  if (!message) return cjson({ ok: false, error: "empty message" }, 400);
  const gate = await gateStatus(db, env, AGENT_VERSION);
  let out, flags = [], plan, used_ai = false, notice = "", err = "", latency = 0;
  const red = redact(message);
  if (gate.passed && s.msgs < AGENT_MSG_CAP && (await bump(db, "agent")) <= HELP_DAILY_CAP) {
    try {
      const r = await runAgentAI(env, s.state, message, lang, s.history);
      out = r.out; flags = r.flags; plan = r.plan; latency = r.latency; used_ai = true;
      if (flags.length) {
        // Unsafe text: keep the user safe by switching this answer to the rule-based agent.
        const rb = agentNormalise(agentRules(red.text, s.state), s.state);
        out = Object.assign(rb, { intent: out.intent });
        plan = agentPlan(out, s.state); used_ai = false;
        notice = "Part of the AI answer broke a safety rule, so SIP Care used its standard answer.";
      }
    } catch (e) { err = String(e.message || e); notice = `AI is unavailable right now (${err}). SIP Care used its standard answer.`; }
  } else if (!gate.passed) notice = "AI is off until SIP Care passes its quality check. Using standard answers.";
  else notice = "Today's free AI limit is used up. Using standard answers.";
  if (!out) { out = agentNormalise(agentRules(red.text, s.state), s.state); plan = agentPlan(out, s.state); }
  const done = plan.auto.map(a => applyAction(a, s.state));
  s.pending = s.pending.filter(p => !plan.proposals.some(q => q.type === p.type && q.sip_id === p.sip_id)).concat(plan.proposals);
  const shown = message.startsWith("__fix__:") ? `Fix ${sipById(s.state, message.slice(8).toUpperCase())?.fund || "this SIP"}` : red.text;
  s.history.push({ role: "user", text: shown }, { role: "agent", text: out.reply });
  s.msgs++;
  await saveSession(db, s);
  await careLog(db, s.id, "message", { intent: out.intent, used_ai: used_ai ? 1 : 0, flags: flags.join(" | "), error: err.slice(0, 200), latency, auto: plan.auto.map(a => a.type).join(","), proposed: plan.proposals.map(p => p.type).join(","), lang, redacted: red.found.join(",") });
  return cjson({ ok: true, used_ai, notice, intent: out.intent, sip_id: out.sip_id, reply: out.reply, done, proposals: plan.proposals, skipped: plan.skipped, redacted: red.found, pending: s.pending, view: agentView(s.state) });
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
  s.state.resolved.unshift({ text: msg, at: now() });
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
  return cjson({ ok: true, removed: before - s.pending.length, pending: s.pending });
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

export default { fetch: route };
