const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch(); let pass = 0, fail = 0; const F = [];
  const t = (n, c, i) => { if (c) pass++; else { fail++; F.push(n + (i ? " :: " + String(i).slice(0, 200) : "")); } };
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage(); const errs = []; p.on("pageerror", e => errs.push(e.message)); p.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
  await p.addInitScript(() => { window.EVAL_DELAY = 0; });
  await p.goto("http://localhost:8788/helper"); await p.waitForTimeout(400);
  t("banner", (await p.textContent(".banner")).includes("Not an official Groww product"));
  t("AI off line", /AI off/.test(await p.textContent("#gateLine")));
  await p.click("#go"); t("empty submit asks", /Tap what happened/.test(await p.textContent("#answer")));
  await p.click('[data-chip="money_stuck"]'); await p.click("#go"); await p.waitForSelector(".summary");
  let a = await p.textContent("#answer");
  t("standard help shown", /Standard help/.test(a) && /Your money right now/.test(a) && /Source:/.test(a), a);
  t("support box", await p.isVisible("#supMsg") || (await p.$("#supMsg")) !== null);
  await p.screenshot({ path: "shots/1_standard.png", fullPage: true });
  await p.click("#sendFb"); t("feedback needs all", /answer all three/.test(await p.textContent("#fbMsg")));
  await p.click('[data-fb="understood"][data-v="yes"]'); await p.click('[data-fb="chosen"][data-v="check_units"]'); await p.click('[data-fb="clarity"][data-v="4"]'); await p.click("#sendFb"); await p.waitForTimeout(300);
  t("feedback saved", /saved/.test(await p.textContent("#fbMsg")));
  await p.click('[data-chip="money_stuck"]');
  await p.fill("#text", "SIP failed, my PAN ABCDE1234F"); await p.click("#go"); await p.waitForTimeout(500);
  t("PII notice", /removed what looked like your PAN/.test(await p.textContent("#answer")));
  // quality
  await p.click('nav [data-tab="quality"]'); await p.waitForTimeout(400);
  t("no check yet", /No check run yet/.test(await p.textContent("#gateBox")));
  t("25 rows", (await p.$$("#caseTable tbody tr")).length === 25);
  await p.click("#runEval"); await p.waitForFunction(() => /Done:|recently|limit/.test(document.querySelector("#evalMsg").textContent), null, { timeout: 60000 });
  const em = await p.textContent("#evalMsg"); t("eval passes", /100% right, 0 rule breaks.*Gate passed/.test(em), em);
  await p.waitForTimeout(500);
  t("all pass pills", (await p.$$("#caseTable .pill.ok")).length === 25);
  t("gate pill on", /Gate passed/.test(await p.textContent("#gateBox")));
  await p.screenshot({ path: "shots/2_quality.png", fullPage: true });
  await p.click("#runEval"); await p.waitForTimeout(500); t("cooldown message", /next one can start/.test(await p.textContent("#evalMsg")));
  // AI on
  await p.click('nav [data-tab="help"]'); await p.waitForTimeout(300);
  t("AI on line", /AI on/.test(await p.textContent("#gateLine")));
  await p.fill("#text", "Mera feb ki sip miss ho gayi, to ab mujhe kya karna chahiye?"); await p.click('[data-chip="money_stuck"]'); await p.click("#go"); await p.waitForTimeout(600);
  a = await p.textContent("#answer"); t("AI answer", /AI/.test(a) && /Aapka paisa safe hai/.test(a), a);
  t("first option pay", /1\. Pay this month/.test(a), a);
  await p.screenshot({ path: "shots/3_ai.png", fullPage: true });
  // scenario
  await p.click('nav [data-tab="test"]'); await p.click('[data-scen="T3-tight"]'); await p.waitForTimeout(200);
  t("scenario card", await p.isVisible("#scenarioCard") && /Short this month/.test(await p.textContent("#scenarioCard")));
  await p.click('[data-chip="low_balance_ahead"]'); await p.fill("#sipDay", "3"); await p.fill("#salDay", "7"); await p.click("#go"); await p.waitForTimeout(500);
  t("tester questions", /Three quick questions/.test(await p.textContent("#answer")));
  await p.click('[data-fb="understood"][data-v="yes"]'); await p.click('[data-fb="chosen"] >> nth=0'); await p.click('[data-fb="clarity"][data-v="5"]'); await p.click("#sendFb"); await p.waitForTimeout(300);
  await p.click('nav [data-tab="results"]'); await p.waitForTimeout(500);
  const rs = await p.textContent("#resBox"); t("results show tester", /Tester scenarios \(1\)/.test(rs) && /T3-tight/.test(rs), rs);
  await p.screenshot({ path: "shots/4_results.png", fullPage: true });
  await p.click('nav [data-tab="how"]'); await p.waitForTimeout(400);
  t("facts with links", (await p.$$("#factList a")).length === 9);
  t("no horizontal scroll", await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  // dark mode
  const d = await b.newPage({ colorScheme: "dark", viewport: { width: 390, height: 844 } }); await d.goto("http://localhost:8788/helper"); await d.click('[data-chip="instalment_failed"]'); await d.click("#go"); await d.waitForTimeout(600); await d.screenshot({ path: "shots/5_dark.png", fullPage: true });
  const real = errs.filter(e => !/429/.test(e)); t("no console errors (except expected cooldown 429)", real.length === 0, real.join(" | "));
  console.log(`UI tests: ${pass} passed, ${fail} failed`); F.forEach(f => console.log("FAIL", f)); await b.close();
})();
