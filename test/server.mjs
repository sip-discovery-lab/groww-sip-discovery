import http from "node:http";
import { makeD1 } from "./d1.mjs";
import fs from "node:fs";
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
const env = { DB: makeD1(), GEMINI_MOCK: mock };
const port = +(process.env.PORT || 8788);
http.createServer(async (req, res) => {
  let body = ""; req.on("data", c => body += c); await new Promise(r => req.on("end", r));
  const r = await W.fetch(new Request("http://localhost:" + port + req.url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, () => console.log("listening " + port));
