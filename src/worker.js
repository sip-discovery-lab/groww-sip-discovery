const CASES = /*@@CASES*/[];
const PAGE = /*@@PAGE*/"";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, ts TEXT, chip TEXT, ai_situation TEXT, situation TEXT, confidence REAL, lang TEXT, actions TEXT, used_ai INTEGER, flags TEXT, redacted TEXT, latency_ms INTEGER, model TEXT, prompt_version TEXT, tester INTEGER, scenario TEXT, error TEXT)`,
  `CREATE TABLE IF NOT EXISTS feedback (session_id TEXT, ts TEXT, understood TEXT, chosen TEXT, clarity INTEGER, helpful TEXT, seconds INTEGER, tester INTEGER, scenario TEXT)`,
  `CREATE TABLE IF NOT EXISTS eval_runs (id TEXT PRIMARY KEY, ts TEXT, model TEXT, prompt_version TEXT, n INTEGER, passed INTEGER, breaks INTEGER, score REAL, gate INTEGER, complete INTEGER, errors INTEGER)`,
  `CREATE TABLE IF NOT EXISTS eval_cases (run_id TEXT, case_id TEXT, situation TEXT, actions TEXT, ok INTEGER, reasons TEXT, breaks INTEGER, summary TEXT, error TEXT, PRIMARY KEY (run_id, case_id))`,
  `CREATE TABLE IF NOT EXISTS usage (day TEXT, kind TEXT, n INTEGER, PRIMARY KEY (day, kind))`,
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

async function gateStatus(db, env) {
  const model = env.MODEL || DEFAULT_MODEL;
  const last = await db.prepare(`SELECT * FROM eval_runs WHERE complete = 1 AND model = ? AND prompt_version = ? ORDER BY ts DESC LIMIT 1`).bind(model, PROMPT_VERSION).first();
  return { model, prompt_version: PROMPT_VERSION, passed: !!(last && last.gate), last: last || null, min_score: GATE_MIN_SCORE };
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

async function evalStart(req, env, db) {
  const recent = await db.prepare(`SELECT ts FROM eval_runs ORDER BY ts DESC LIMIT 1`).first();
  if (recent && Date.now() - Date.parse(recent.ts) < EVAL_COOLDOWN_MIN * 60000) {
    const wait = Math.ceil((EVAL_COOLDOWN_MIN * 60000 - (Date.now() - Date.parse(recent.ts))) / 60000);
    return json({ ok: false, error: `A check ran recently. To save the free AI limit, the next one can start in ${wait} min.` }, 429);
  }
  const id = uid();
  await db.prepare(`INSERT INTO eval_runs (id, ts, model, prompt_version, n, passed, breaks, score, gate, complete, errors) VALUES (?,?,?,?,?,0,0,0,0,0,0)`).bind(id, now(), env.MODEL || DEFAULT_MODEL, PROMPT_VERSION, CASES.length).run();
  return json({ ok: true, run_id: id, cases: CASES.map(c => c.id) });
}

async function evalCase(req, env, db) {
  const b = await readJson(req);
  const run = await db.prepare(`SELECT * FROM eval_runs WHERE id = ?`).bind(String(b.run_id || "")).first();
  if (!run || run.complete) return json({ ok: false, error: "unknown or finished run" }, 400);
  const c = CASES.find(x => x.id === b.case_id);
  if (!c) return json({ ok: false, error: "unknown case" }, 400);
  const done = await db.prepare(`SELECT * FROM eval_cases WHERE run_id = ? AND case_id = ?`).bind(run.id, c.id).first();
  if (done && !done.error) return json({ ok: true, case: done });
  await bump(db, "eval");
  let row;
  try {
    const ai = await runAI(env, { text: c.text, sip_day: c.sip_day, salary_day: c.salary_day });
    const s = scoreCase(c, ai.out, ai.flags, { redacted: ai.clean.redacted });
    row = { situation: ai.out.situation, actions: ai.out.action_order.join(","), ok: s.ok ? 1 : 0, reasons: s.reasons.join(" | "), breaks: s.breaks, summary: ai.out.summary.slice(0, 300), error: "" };
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
  const rows = (await db.prepare(`SELECT * FROM eval_cases WHERE run_id = ?`).bind(run.id).all()).results || [];
  const passed = rows.filter(r => r.ok).length, breaks = rows.reduce((a, r) => a + (r.breaks || 0), 0), errors = rows.filter(r => r.error).length;
  const score = CASES.length ? passed / CASES.length : 0;
  const gate = rows.length === CASES.length && errors === 0 && breaks === 0 && score >= GATE_MIN_SCORE ? 1 : 0;
  await db.prepare(`UPDATE eval_runs SET passed = ?, breaks = ?, score = ?, gate = ?, complete = 1, errors = ? WHERE id = ?`).bind(passed, breaks, score, gate, errors, run.id).run();
  return json({ ok: true, run_id: run.id, n: CASES.length, done: rows.length, passed, breaks, errors, score, gate: !!gate });
}

async function evalLatest(req, env, db, url) {
  const id = url.searchParams.get("id");
  const runs = (await db.prepare(`SELECT * FROM eval_runs ORDER BY ts DESC LIMIT 10`).all()).results || [];
  const pick = id ? runs.find(r => r.id === id) || (await db.prepare(`SELECT * FROM eval_runs WHERE id = ?`).bind(id).first()) : runs.find(r => r.complete);
  const cases = pick ? ((await db.prepare(`SELECT * FROM eval_cases WHERE run_id = ? ORDER BY case_id`).bind(pick.id).all()).results || []) : [];
  const meta = CASES.map(c => ({ id: c.id, from: c.from, lang: c.lang, text: c.text, expect: c.expect, alt: c.alt || [], main: c.main }));
  return json({ ok: true, gate: await gateStatus(db, env), runs, run: pick || null, cases, case_meta: meta });
}

async function results(req, env, db) {
  const q = async s => (await db.prepare(s).all()).results || [];
  return json({
    ok: true,
    gate: await gateStatus(db, env),
    sessions: (await db.prepare(`SELECT COUNT(*) AS n, SUM(used_ai) AS ai, SUM(CASE WHEN flags != '' THEN 1 ELSE 0 END) AS flagged, SUM(CASE WHEN redacted != '' THEN 1 ELSE 0 END) AS redacted, SUM(CASE WHEN error != '' THEN 1 ELSE 0 END) AS errors, AVG(CASE WHEN used_ai = 1 THEN latency_ms END) AS avg_ms FROM sessions`).first()),
    by_situation: await q(`SELECT situation, COUNT(*) AS n FROM sessions GROUP BY situation ORDER BY n DESC`),
    feedback: await q(`SELECT tester, scenario, understood, chosen, clarity, helpful, seconds, ts FROM feedback ORDER BY ts DESC LIMIT 200`),
    usage_today: await q(`SELECT kind, n FROM usage WHERE day = '${day()}'`),
  });
}

async function route(req, env) {
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/+$/, "") || "/";
  if (p === "/" && req.method === "GET") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
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
    if (p === "/api/facts") return json({ ok: true, prompt_version: PROMPT_VERSION, situations: SITUATIONS, actions: ACTIONS, facts: FACTS, sources: SOURCES });
    return json({ ok: false, error: "not found" }, 404);
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
}

export default { fetch: route };
