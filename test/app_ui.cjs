// A–Z browser test of the SIP Care app (mock AI). Run with the dev server on :8788.
const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch(); let pass = 0, fail = 0; const F = [];
  const t = (n, c, i) => { if (c) pass++; else { fail++; F.push(n + (i ? " :: " + String(i).slice(0, 300) : "")); } };
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage(); const errs = []; p.on("pageerror", e => errs.push(e.message)); p.on("console", m => { if (m.type() === "error" && !/fonts\.g|ERR_|net::/.test(m.text())) errs.push(m.text()); });
  const base = "http://localhost:8788";
  await p.goto(base + "/"); await p.waitForSelector("#fixBtn");
  let body = await p.textContent("#app");
  t("home issue card", /SIP Care found 3 issues/.test(body) && /Your invested money is safe. A fix is ready./.test(body));
  t("concept label", /not an official Groww product/.test(body));
  t("statuses", /Not paid · 3 Nov/.test(body) && /In progress/.test(body) && /AutoPay not active/.test(body));
  await p.screenshot({ path: "shots/app_1_home.png", fullPage: true });
  // inert nav
  await p.click("nav.bottom div:nth-child(2)"); t("nav inert", await p.isVisible("#fixBtn"));
  // fix flow
  await p.click("#fixBtn"); await p.waitForSelector("#review", { timeout: 8000 });
  body = await p.textContent("#app");
  t("agent replied", /salary comes on the 7th/.test(body), body.slice(0, 600));
  t("two proposals", (await p.$$(".prop")).length === 2 && /Retry ₹1,000 on 7 Nov/.test(body) && /Move SIP date to the 9th/.test(body));
  t("standard tag (gate off)", /Standard/.test(body));
  await p.screenshot({ path: "shots/app_2_care.png", fullPage: true });
  await p.click("#review"); await p.waitForSelector("#cfGo");
  t("sheet lists 2", (await p.$$("[data-pid]")).length === 2);
  await p.screenshot({ path: "shots/app_3_confirm.png" });
  await p.click("#cfGo"); await p.waitForSelector("#toHome", { state: "visible", timeout: 8000 });
  body = await p.textContent("#app");
  t("fixing steps", /Scheduled a retry of ₹1,000 on 7 Nov/.test(body) && /3 \/ 3 complete/.test(body), body);
  await p.screenshot({ path: "shots/app_4_fixing.png", fullPage: true });
  await p.click("#toHome"); await p.waitForSelector("#successCard");
  body = await p.textContent("#app");
  t("home success", /SIP Care fixed your SIP/.test(body) && /Retry on 7 Nov/.test(body) && /SIP Care found 2 issues/.test(body), body.slice(0, 800));
  t("feedback card", await p.isVisible("#fb"));
  await p.screenshot({ path: "shots/app_5_home_fixed.png", fullPage: true });
  await p.click("#viewDid"); await p.waitForSelector(".sheet"); t("what SIP Care did", /You confirmed/.test(await p.textContent(".sheet"))); await p.click("#gotIt");
  await p.click("#fbSend"); t("feedback validation", /answer all three/.test(await p.textContent("#fbMsg")));
  await p.click('[data-k="understood"][data-v="yes"]'); await p.click('[data-k="fixed"][data-v="yes"]'); await p.click('[data-k="clarity"][data-v="5"]'); await p.click("#fbSend"); await p.waitForTimeout(300);
  t("feedback saved", !(await p.$("#fb")));
  // other issue: AutoPay, decline
  await p.click("#qaCare"); await p.waitForSelector('[data-fix="C"]');
  await p.click('[data-fix="C"]'); await p.waitForFunction(() => document.querySelectorAll("[data-decline]").length > 0, null, { timeout: 8000 });
  body = await p.textContent("#app"); t("autopay auto reminder", /Done automatically/.test(body) && /Set up AutoPay again/.test(body));
  await p.click("[data-decline]"); await p.waitForTimeout(300); t("declined", /Not done/.test(await p.textContent("#app")));
  // free text + language
  await p.click('[data-lang="hinglish"]'); t("lang toggle", (await p.getAttribute('[data-lang="hinglish"]', "aria-pressed")) === "true");
  await p.fill("#q", "Change my Flexi Cap SIP amount to 3000"); await p.click("#ask button"); await p.waitForFunction(() => /Change amount to ₹3,000/.test(document.body.textContent), null, { timeout: 8000 });
  t("free text proposal", true);
  await p.fill("#q", "My PAN is ABCDE1234F, why did my SIP fail?"); await p.click("#ask button"); await p.waitForTimeout(800);
  body = await p.textContent("#app"); t("PII notice", /removed what looked like your PAN/.test(body) && !/ABCDE1234F/.test(body.replace(/My PAN is ABCDE1234F, why did my SIP fail\?/, "")), body.slice(-500));
  t("no horizontal scroll", await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await p.screenshot({ path: "shots/app_6_chat.png", fullPage: true });
  // back + reset
  await p.click("#back"); await p.waitForSelector("#reset"); await p.click("#reset"); await p.waitForSelector("#fixBtn");
  t("reset", /SIP Care found 3 issues/.test(await p.textContent("#app")) && !(await p.$("#successCard")));
  // dark
  const d = await b.newPage({ colorScheme: "dark", viewport: { width: 390, height: 844 } }); await d.goto(base + "/"); await d.waitForSelector("#fixBtn"); await d.screenshot({ path: "shots/app_7_dark.png" });
  // desktop width
  const w = await b.newPage({ viewport: { width: 1280, height: 800 } }); await w.goto(base + "/"); await w.waitForSelector("#fixBtn"); await w.screenshot({ path: "shots/app_8_desktop.png" });
  t("no page errors", errs.length === 0, errs.join(" | "));
  console.log(`app UI tests: ${pass} passed, ${fail} failed`); F.forEach(f => console.log("FAIL", f)); await b.close(); process.exit(fail ? 1 : 0);
})();
