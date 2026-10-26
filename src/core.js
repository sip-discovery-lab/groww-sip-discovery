const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const GATE_MIN_SCORE = 0.9;
const HELP_DAILY_CAP = 300;
const EVAL_COOLDOWN_MIN = 20;

function errText(status, body) {
  let msg = "";
  try { const j = JSON.parse(body); msg = (j.error && (j.error.message || j.error.status)) || ""; } catch (e) { msg = String(body || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 200); }
  let hint = "";
  if (status === 400 && /api key/i.test(msg)) hint = " (the Gemini key is missing or wrong)";
  else if (status === 403) hint = " (the Gemini key is not allowed to use this model)";
  else if (status === 404) hint = " (model name not found: check the MODEL setting)";
  else if (status === 429) hint = " (free-tier limit reached: try again later)";
  return `HTTP ${status} · ${msg.slice(0, 220)}${hint}`;
}

async function callGemini(env, input, task) {
  task = task || { system: systemPrompt(), user: userPrompt(input), schema: RESPONSE_SCHEMA, mock: env.GEMINI_MOCK };
  if (task.mock) return task.mock(input);
  if (!env.GEMINI_API_KEY) throw new Error("No Gemini key set (add the GEMINI_API_KEY secret)");
  const model = env.MODEL || DEFAULT_MODEL;
  const body = {
    systemInstruction: { parts: [{ text: task.system }] },
    contents: [{ role: "user", parts: [{ text: task.user }] }],
    generationConfig: task.plain ? { temperature: 0.1, maxOutputTokens: 900 } : { responseMimeType: "application/json", responseSchema: task.schema, temperature: 0.2, maxOutputTokens: 1200 },
  };
  if (task.tools) body.tools = task.tools;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY }, body: JSON.stringify(body) });
    const t = await r.text();
    if (r.ok) {
      let j; try { j = JSON.parse(t); } catch (e) { throw new Error("Gemini sent a reply that is not JSON"); }
      const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
      const text = parts.map(p => p.text || "").join("");
      if (task.plain) return text;
      if (!text) throw new Error("Gemini sent an empty answer" + (j.promptFeedback ? ` (${JSON.stringify(j.promptFeedback).slice(0, 120)})` : ""));
      try { return JSON.parse(text); } catch (e) { const m = text.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); throw new Error("Gemini answer was not valid JSON"); }
    }
    last = errText(r.status, t);
    if (r.status !== 429 && r.status < 500) break;
    await new Promise(res => setTimeout(res, r.status === 429 ? 6000 * (attempt + 1) : 2500));
  }
  throw new Error(last);
}

// Shape whatever the model returned into something safe to show.
function normalise(raw, input) {
  const out = Object.assign({ summary: "", worry_answer: "", question: "", support_message: "", notes: [], action_order: [] }, raw || {});
  if (!SITUATIONS[out.situation]) out.situation = "unclear";
  const allowed = SITUATIONS[out.situation].actions;
  let order = (Array.isArray(out.action_order) ? out.action_order : []).filter((a, i, arr) => allowed.includes(a) && arr.indexOf(a) === i);
  if (!order.length && allowed.length) order = allowed.filter(a => a !== "stop_sip").slice(0, 3);
  if (order[0] === "stop_sip" && order.length > 1) order.push(order.shift());
  if (order.length === 1 && order[0] === "stop_sip") order = allowed.filter(a => a !== "stop_sip").slice(0, 2).concat("stop_sip");
  out.action_order = order.slice(0, 4);
  out.notes = (Array.isArray(out.notes) ? out.notes : []).filter(n => n && out.action_order.includes(n.action) && typeof n.note === "string").map(n => ({ action: n.action, note: n.note.slice(0, 240) }));
  out.confidence = Math.max(0, Math.min(1, Number(out.confidence) || 0));
  for (const f of ["summary", "worry_answer", "question", "support_message"]) out[f] = String(out[f] || "").slice(0, 600);
  return out;
}

// Rule-based fallback used when the AI is off (gate not passed) or unavailable.
function keywordSituation(input) {
  if (input.chip && SITUATIONS[input.chip]) return input.chip;
  const t = String(input.text || "").toLowerCase();
  if (/debit|deduct|kat gaya|kat gya|cut|refund|units?|allot|duplicate|twice|wapas/.test(t)) return "money_stuck";
  if (/auto ?pay|mandate|nach/.test(t)) return "autopay_problem";
  if (/(low|kam|short|less).{0,20}(balance|paise|money)|balance.{0,15}(low|kam)|emergency|bounce charge nahi/.test(t)) return "low_balance_ahead";
  if (/fail|miss|bounce|pending|nahi hua/.test(t)) return "instalment_failed";
  if (/return|withdraw|which fund|tax|stock/.test(t)) return "out_of_scope";
  return "unclear";
}

function factOut(id) { const f = FACTS[id]; return { id, text: f.text, source: SOURCES[f.src] }; }

function buildAnswer(sit, ai, meta) {
  const S = SITUATIONS[sit];
  const notes = {}; (ai && ai.notes || []).forEach(n => { notes[n.action] = n.note; });
  const order = ai && ai.action_order && ai.action_order.length ? ai.action_order : S.actions.filter(a => a !== "stop_sip").slice(0, 3);
  const showStop = S.actions.includes("stop_sip") && !order.includes("stop_sip");
  const options = order.map(id => ({ id, title: ACTIONS[id].title, steps: ACTIONS[id].steps, facts: ACTIONS[id].facts.map(factOut), note: notes[id] || "" }));
  if (showStop) options.push({ id: "stop_sip", title: ACTIONS.stop_sip.title, steps: ACTIONS.stop_sip.steps, facts: ACTIONS.stop_sip.facts.map(factOut), note: "", neutral: true });
  let support = (ai && ai.support_message) || "";
  if (order.includes("contact_support") && !support) support = `My SIP instalment has a problem: ${S.label.toLowerCase()}. Please check the order status for my latest SIP instalment and tell me what happens next.`;
  return {
    situation: sit, label: S.label,
    summary: (ai && ai.summary) || defaultSummary(sit),
    worry_answer: (ai && ai.worry_answer) || "",
    question: (ai && ai.question) || (sit === "unclear" ? "What happened with your SIP? For example: money left your bank but no units, the instalment failed, AutoPay is not working, or your balance may be short before the date." : ""),
    money_now: S.facts.map(factOut),
    options, support_message: order.includes("contact_support") ? support : "",
    used_ai: !!meta.used_ai, notice: meta.notice || "", confidence: ai ? ai.confidence : null, language: ai ? ai.language : "en",
  };
}

function defaultSummary(sit) {
  return {
    money_stuck: "Money left your bank but the order has not finished yet. It either becomes units in a few days or comes back to your bank.",
    instalment_failed: "This month's instalment did not go through. Your SIP and the money you already invested are still there.",
    autopay_problem: "Your AutoPay is not debiting the SIP, so instalments do not go through until it is fixed or you pay yourself.",
    low_balance_ahead: "Your SIP date is coming and the balance may be short. You have a few ways to handle this month.",
    out_of_scope: "This helper only covers failed, stuck or upcoming SIP instalments. For other questions, use the app's Help section.",
    unclear: "",
  }[sit];
}

// Score one golden case. Pass = right situation (or allowed alternative), a main action first or among the top 2, no rule breaks, plus case-specific checks.
function scoreCase(c, out, flags, meta) {
  const reasons = [];
  const okSit = out.situation === c.expect || (c.alt || []).includes(out.situation);
  if (!okSit) reasons.push(`situation ${out.situation}, expected ${c.expect}`);
  if (c.main && c.main.length) {
    const top = out.action_order.slice(0, 2);
    if (!top.some(a => c.main.includes(a))) reasons.push(`top actions [${top.join(", ")}] miss [${c.main.join(", ")}]`);
    if (out.action_order[0] === "stop_sip") reasons.push("stop shown first");
  }
  if (!out.summary) reasons.push("no summary");
  if (c.worry && !out.worry_answer) reasons.push("worry not answered");
  if (c.lang === "hi" && !/[ऀ-ॿ]/.test(out.summary)) reasons.push("not answered in Hindi");
  if (c.lang === "hinglish" && !/\b(hai|aap|aapka|aapki|nahi|hoga|kar|ke|ka|ki|mein|me|se|ho|gaya|gayi|paisa)\b|[ऀ-ॿ]/i.test(out.summary)) reasons.push("not answered in Hinglish/Hindi");
  if (c.pii && !(meta && meta.redacted && meta.redacted.length)) reasons.push("personal data was not removed");
  if (c.pii && /\b[A-Z]{5}\d{4}[A-Z]\b|\b\d{9,18}\b/.test(JSON.stringify(out))) reasons.push("personal data repeated");
  if (flags.length) reasons.push(`rule breaks: ${flags.join("; ")}`);
  return { ok: reasons.length === 0, reasons, breaks: flags.length };
}
