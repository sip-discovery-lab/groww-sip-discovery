// Browser test of SIP Care v4 (mock AI, gate off -> standard answers). Needs the dev server on :8788.
const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch(); let pass = 0, fail = 0; const F = [];
  const t = (n, c, i) => { if (c) pass++; else { fail++; F.push(n + (i ? " :: " + String(i).slice(0, 500) : "")); } };
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage(); const errs = []; p.on("pageerror", e => errs.push(e.message)); p.on("console", m => { if (m.type() === "error" && !/fonts\.g|ERR_|net::|status of 400/.test(m.text())) errs.push(m.text()); });
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
  // SIP day: payment fails -> instant alert -> options -> fix flow
  await p.click("details.tester summary"); await p.click('[data-sit="sip_low_balance"]'); await p.waitForSelector(".issue");
  body = await p.textContent("#app");
  t("SIP day: instant alert + toast + demo date", /₹2,000 SIP payment failed today/.test(body) && /Demo date 26/.test(body) && await p.isVisible(".toast"), body.slice(0, 600));
  await p.screenshot({ path: "shots/v4_1_failed_alert.png", fullPage: true });
  await p.click('.issue [data-note]'); await p.waitForSelector('[data-opt="fix"]');
  body = await p.textContent("#app");
  t("failure screen: why + options", /Insufficient balance/.test(body) && /salary usually arrives on the 1st/.test(body) && /What would you like to do\?/.test(body) && /Keep my SIP going/.test(body) && /Cancel this SIP/.test(body), body.slice(0, 900));
  await p.screenshot({ path: "shots/v4_2_options.png", fullPage: true });
  await p.click('[data-opt="fix"]'); await answer();
  body = await p.textContent(".thread");
  t("fix flow: diagnosis, reminder, date change, link", /Move SIP date to the 3rd/.test(body) && /reminder/i.test(body) && /Open Flexi Cap SIP/.test(body), body);
  await p.screenshot({ path: "shots/v4_3_fix.png", fullPage: true });
  await p.click('.ans button:has-text("Open Flexi Cap SIP")'); await p.waitForSelector('[data-page="date"]');
  t("link opens SIP details page", /Instalments/.test(await p.textContent("#app")) && /Fix with SIP Care/.test(await p.textContent("#app")));
  await p.screenshot({ path: "shots/v4_4_sip_page.png", fullPage: true });
  // cancel flow from the SIP page
  await p.click('[data-opt="cancel"]'); await p.waitForSelector('input[name="cr"]');
  t("cancel asks why first", /can I ask what's making you want to stop/.test(await p.textContent("#app")) && await p.isDisabled("#crGo"));
  await p.screenshot({ path: "shots/v4_5_cancel_why.png", fullPage: true });
  await p.check('input[value="growth"]'); await p.fill("#crText", "returns look too small");
  await p.click("#crGo"); await answer();
  body = await p.textContent(".thread");
  t("cancel recommendation: explains, alternatives, cancel last", /normal to see little change early/.test(body) && /Pause for 1 month/.test(body) && /Cancel this SIP/.test(body) && body.indexOf("Pause for 1 month") < body.indexOf("Cancel this SIP"), body);
  await p.screenshot({ path: "shots/v4_6_cancel_reco.png", fullPage: true });
  // pages from nav
  await p.click('nav [data-go="sips"]'); await p.waitForSelector(".rowbtn");
  t("SIPs tab works", (await p.$$(".rowbtn")).length === 3);
  await p.click('nav [data-go="bank"]'); await p.waitForSelector(".kv");
  t("Account page shows salary day", /Salary usually arrives\s*1st/.test(await p.textContent("#app")));
  await p.goto(base + "/#/orders"); await p.waitForSelector(".fund");
  t("orders page shows failed payment with fix", /Failed/.test(await p.textContent("#app")) && /Fix with SIP Care/.test(await p.textContent("#app")));
  await p.goto(base + "/#/withdraw/A"); await p.waitForSelector("#wdAmt");
  await p.fill("#wdAmt", "1000"); await p.click('[data-page="withdraw"]'); await p.waitForSelector("#cfGo");
  t("withdraw page -> confirm sheet", /Withdraw ₹1,000/.test(await p.textContent("#sheet")));
  await p.click("#cfBack");
  await p.goto(base + "/#/sip/C"); await p.waitForSelector("#newAmt");
  await p.fill("#newAmt", "50"); await p.click('[data-page="amount"]'); await p.waitForTimeout(400);
  t("page validation message", /at least/.test(await p.textContent("#toasts")));
  await p.goto(base + "/#/care"); await p.waitForSelector("#q");
  await p.click('[data-act="reset"]').catch(() => {});
  await p.goto(base + "/"); await p.waitForSelector(".strip"); await p.click('[data-act="reset"]'); await p.waitForTimeout(600);
  await p.click("details.tester summary"); await p.click('[data-sit="sip_autopay"]'); await p.waitForSelector(".issue");
  await p.click('.issue [data-note]'); await p.click('[data-opt="fix"]'); await answer();
  await p.click('.ans button:has-text("Open AutoPay settings")'); await p.waitForSelector(".card");
  t("AutoPay fix links to AutoPay page", /AutoPay is not active|Waiting for your approval/.test(await p.textContent("#app")));
  await p.goto(base + "/#/care"); await p.waitForSelector("#q");
  // language
  if (await p.$('[data-act="topics"]')) await p.click('[data-act="topics"]');
  await p.click('[data-lang="hinglish"]'); await p.waitForSelector(".topics");
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
