import http from "node:http";
import { makeD1 } from "./d1.mjs";
import fs from "node:fs";
import { makeAgentMock } from "./agent_mock.mjs";
const W = (await import("../dist/worker.js?" + Date.now())).default;
const cases = JSON.parse(fs.readFileSync(new URL("../eval/cases.json", import.meta.url), "utf8"));
export let MODE = { m: process.env.MOCK || "oracle" };
const mock = async input => {
  if (MODE.m === "down") throw new Error("HTTP 429 · Resource exhausted (free-tier limit reached: try again later)");
  const c = cases.find(c => input.text && c.text.replace(/[A-Z]{5}\d{4}[A-Z]|\d{9,18}/g, "[removed]").slice(0, 40) === input.text.slice(0, 40));
  if (c) return { situation: c.expect, confidence: 0.9, language: c.lang, summary: c.lang === "hi" ? "आपकी किस्त नहीं कटी।" : c.lang === "hinglish" ? "Aapka paisa safe hai, yeh instalment process nahi hua." : "Your instalment did not go through, but invested money is safe.", worry_answer: c.worry ? "No, money already invested stays invested." : "", action_order: c.main.slice(0, 2), notes: [] };
  const sit = input.chip || "instalment_failed";
  return { situation: sit, confidence: 0.8, language: "en", summary: "Mock AI summary for " + sit + ".", worry_answer: "", action_order: [], notes: [], support_message: "" };
};
const careCases = JSON.parse(fs.readFileSync(new URL("../eval/care_cases.json", import.meta.url), "utf8"));
const careMock = async ({ state, lang }) => {
  if (MODE.m === "down") throw new Error("HTTP 429 · Resource exhausted");
  const c = careCases.find(c => c.state.sip_day === state.sip_day && c.state.salary_day === state.salary_day && c.lang === lang && c.state.bank_message.slice(0, 15) === state.bank_message.slice(0, 15));
  const L = c ? c.lang : lang;
  const plan = c ? (c.first ? [c.first].concat(c.must_plan.filter(a => a !== c.first)) : c.must_plan).slice(0, 2) : ["retry_on_payday", "move_date_after_payday"];
  const f = { en: ["Your salary comes on the 7th but the SIP runs on the 3rd, so the balance was short.", "Retry set for 7 Nov. Your SIP is active."], hinglish: ["Aapki salary 7 ko aati hai par SIP 3 ko hai, isliye balance kam tha.", "7 Nov ko retry set hai. Aapka SIP active hai."], hi: ["आपकी सैलरी 7 तारीख को आती है, पर SIP 3 तारीख को कटता है।", "7 Nov को फिर से कोशिश होगी। आपका SIP चालू है।"] }[L];
  return { cause: c ? c.expect_cause : "salary_after_sip_date", plan, found: f[0], home_message: f[1], notes: [] };
};
const lib = new Function(["guard", "facts", "core", "agent", "events"].map(f => fs.readFileSync(new URL(`../src/${f}.js`, import.meta.url), "utf8")).join("\n") + "; return { agentRules };")();
const env = { DB: makeD1(), GEMINI_MOCK: mock, GEMINI_CARE_MOCK: careMock, GEMINI_AGENT_MOCK: makeAgentMock(lib.agentRules, MODE), GEMINI_OBS_MOCK: null, TICK_FORCE_MS: Number(process.env.TICK_FORCE_MS ?? 300) };
const port = +(process.env.PORT || 8788);
http.createServer(async (req, res) => {
  let body = ""; req.on("data", c => body += c); await new Promise(r => req.on("end", r));
  const r = await W.fetch(new Request("http://localhost:" + port + req.url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, () => console.log("listening " + port));
