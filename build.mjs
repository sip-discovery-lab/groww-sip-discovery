// Builds dist/worker.js: one self-contained Cloudflare Worker file.
import fs from "node:fs";
const read = f => fs.readFileSync(new URL(f, import.meta.url), "utf8");
const parts = ["src/facts.js", "src/prompt.js", "src/guard.js", "src/core.js", "src/care.js", "src/agent.js"].map(read);
const cases = JSON.parse(read("eval/cases.json"));
const page = read("src/page.html");
const careCases = JSON.parse(read("eval/care_cases.json"));
const quality = read("src/quality.html");
const agentCases = JSON.parse(read("eval/agent_cases.json"));
const app = read("src/app.html");
let w = read("src/worker.js");
w = w.replace("/*@@CASES*/[]", () => JSON.stringify(cases)).replace("/*@@CARE_CASES*/[]", () => JSON.stringify(careCases)).replace("/*@@AGENT_CASES*/[]", () => JSON.stringify(agentCases)).replace('/*@@APP*/""', () => JSON.stringify(app)).replace('/*@@QUALITY*/""', () => JSON.stringify(quality)).replace('/*@@PAGE*/""', () => JSON.stringify(page));
const out = "// SIP Recovery Helper: single-file Cloudflare Worker (built by build.mjs)\n" + parts.join("\n") + "\n" + w;
fs.mkdirSync(new URL("dist/", import.meta.url), { recursive: true });
fs.writeFileSync(new URL("dist/worker.js", import.meta.url), out);
console.log("dist/worker.js", Buffer.byteLength(out), "bytes");
