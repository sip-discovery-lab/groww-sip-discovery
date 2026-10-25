// Browser test of SIP Care v3 (mock AI, gate off -> standard answers). Needs the dev server on :8788.
const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch(); let pass = 0, fail = 0; const F = [];
  const t = (n, c, i) => { if (c) pass++; else { fail++; F.push(n + (i ? " :: " + String(i).slice(0, 500) : "")); } };
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage(); const errs = []; p.on("pageerror", e => errs.push(e.message)); p.on("console", m => { if (m.type() === "error" && !/fonts\.g|ERR_|net::/.test(m.text())) errs.push(m.text()); });
  const base = "http://localhost:8788";
  const answer = async () => { await p.waitForFunction(() => !document.querySelector(".work") && document.querySelectorAll(".ans").length > 0, null, { timeout: 8000 }); await p.waitForTimeout(150); };
  await p.goto(base + "/"); await p.waitForSelector(".strip");
  let body = await p.textContent("#app");
  t("launch: all on track, no errors", /All SIPs on track/.test(body) && !(await p.$(".issue")) && !(await p.$(".nbadge")) && !(await p.isVisible(".toast")), body.slice(0, 400));
  t("last invested 26th", /Last invested\s*26 (Sep|Oct)/.test(body) && /Last SIP date\s*26/.test(body), body.slice(0, 900));
  t("portfolio value shown", /₹15,112/.test(body) && /Invested\s*₹15,000/.test(body));
  t("no demo-day controls", !/Next day|Demo date/.test(body));
  t("topics on home", (await p.$$(".topic")).length === 4);
  await p.screenshot({ path: "shots/v3_1_home.png", fullPage: true });
  await p.click('[data-act="toggle"]'); await p.waitForTimeout(250);
  // SIP Care: user decides
  await p.click('.qa [data-go="care"]'); await p.waitForSelector(".topics");
  body = await p.textContent("#app");
  t("care opens with picker", /What would you like to check\?/.test(body) && (await p.$$(".topic")).length === 10);
  await p.screenshot({ path: "shots/v3_2_care_picker.png", fullPage: true });
  await p.click('.topic:has-text("When will it grow?")'); await answer();
  body = await p.textContent(".thread");
  t("growth answer structured", /What I found in your account/.test(body) && /can't be promised/.test(body) && /₹15,000/.test(body) && /Standard/.test(body), body);
  await p.screenshot({ path: "shots/v3_3_growth.png", fullPage: true });
  await p.fill("#q", "Withdraw 2000 from my Bluechip fund"); await p.press("#q", "Enter"); await answer();
  body = await p.textContent(".thread");
  t("withdraw proposal", /Needs your OK/.test(body) && /Withdraw ₹2,000/.test(body), body.slice(-800));
  await p.click('.ans:last-of-type [data-confirm]'); await p.waitForSelector("#cfGo");
  body = await p.textContent("#sheet");
  t("confirm sheet shows exit load + bank", /Exit load/.test(body) && /Credited to/.test(body) && /within 2 working days/.test(body), body);
  await p.screenshot({ path: "shots/v3_4_confirm.png" });
  await p.click("#cfGo"); await p.waitForSelector("#toHome", { state: "visible", timeout: 6000 });
  t("done screen", /Placed a withdrawal of ₹2,000/.test(await p.textContent("#steps")));
  await p.click("#toHome"); await p.waitForSelector(".strip");
  body = await p.textContent("#app");
  t("home shows done card + new value", /Done by SIP Care/.test(body) && /₹4,192/.test(body), body.slice(0, 800));
  // follow-up notifications (force ticks via API)
  const sid = await p.evaluate(() => localStorage.getItem("sipcare_session"));
  for (let i = 0; i < 2; i++) { await p.evaluate(s => fetch("/api/agent/tick", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: s, force: true }) }), sid); await p.waitForTimeout(400); }
  await p.reload(); await p.waitForSelector(".strip");
  t("bell badge after credit", (await p.textContent(".nbadge")) === "1");
  await p.click('[data-go="inbox"]'); await p.waitForSelector(".obs");
  t("inbox: withdrawal credited", /Withdrawal credited/.test(await p.textContent("#app")) && /₹1,980/.test(await p.textContent("#app")));
  await p.click('.obs'); await p.waitForSelector(".an");
  t("note screen", /What happened/.test(await p.textContent("#app")));
  await p.goto(base + "/#/"); await p.waitForSelector(".strip");
  // tester situation
  await p.click("details.tester summary"); await p.click('[data-sit="payment_failed"]'); await p.waitForSelector(".issue");
  body = await p.textContent("#app");
  t("situation: alert card + toast", /SIP Care spotted something/.test(body) && /instalment not paid/.test(body) && /Not paid/.test(body) && await p.isVisible(".toast"), body.slice(0, 700));
  await p.screenshot({ path: "shots/v3_5_situation.png", fullPage: true });
  await p.click('.issue [data-note]'); await p.waitForSelector("[data-ask]");
  await p.click("[data-ask]"); await answer();
  body = await p.textContent(".thread");
  t("asks agent: bank reason + pay proposal", /Insufficient balance/.test(body) && /Pay ₹2,000 now/.test(body), body);
  await p.screenshot({ path: "shots/v3_6_failed_answer.png", fullPage: true });
  await p.click('.ans [data-decline]'); await p.waitForTimeout(400);
  t("decline -> not done", /Not done/.test(await p.textContent(".thread")));
  await p.click('.fups button'); await answer();
  t("follow-up chip asks", (await p.$$(".ans")).length === 2);
  // language
  await p.click('[data-lang="hinglish"]'); await p.click('[data-act="topics"]'); await p.waitForSelector(".topics");
  await p.click('.topic:has-text("Is my money safe?")'); await answer();
  t("hinglish question sent", /Kya mera paisa safe hai\?/.test(await p.textContent(".thread")));
  // PII
  await p.fill("#q", "My PAN is ABCDE1234F why did my SIP fail"); await p.press("#q", "Enter"); await answer();
  body = await p.textContent("#app");
  t("pii removed", !/ABCDE1234F/.test(body) && /removed/.test(body));
  // source never shown
  t("no source names anywhere", !/sebi|amfi|according to|https?:\/\/(?!localhost)/i.test(await p.textContent("body")));
  await p.setViewportSize({ width: 360, height: 780 }); await p.goto(base + "/"); await p.waitForSelector(".strip");
  t("no horizontal scroll", await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  t("no JS errors", errs.length === 0, errs.join(" | "));
  await b.close();
  console.log(`app ui: ${pass} passed, ${fail} failed`); if (fail) { console.log(F.join("\n")); process.exit(1); }
})();
