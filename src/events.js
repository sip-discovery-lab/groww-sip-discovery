// SIP Care background monitor (v3). The account starts normal. Each check, the agent looks at
// everything in progress (units on the way, withdrawals, stop requests, AutoPay requests) and
// reports when something changes. Testers can also switch on a demo situation to see the agent react.
const OBS_KINDS = ["sip_debited", "units_allotted", "redemption_credited", "sip_stopped", "autopay_active", "payment_failed", "units_pending", "autopay_expired"];

const SITUATIONS_DEMO = {
  sip_low_balance: { label: "SIP day: payment fails (low balance)", ask: "My SIP payment failed today. What happened?" },
  sip_autopay: { label: "SIP day: payment fails (AutoPay expired)", ask: "My SIP payment failed today. What happened?" },
  sip_bank_error: { label: "SIP day: payment fails (bank error)", ask: "My SIP payment failed today. What happened?" },
  sip_ok: { label: "SIP day: all payments go through", ask: "" },
  units_pending: { label: "Money debited, units not showing", ask: "Money was debited but my investment is not showing in the app." },
};

let OBS_SEQ = 0;
function makeObs(st, kind, s, f) {
  return Object.assign({ id: "o" + Date.now().toString(36) + (OBS_SEQ++).toString(36), kind, sip_id: s ? s.id : "", fund: s ? s.fund : "", at_day: st.today, level: "info", status: "info",
    title: "", what: "", why: [], impact: "", notify: "", done: [], proposals: [], proposal_ids: [], ask: "" }, f);
}

// SIP day: the agent watches every debit and reports a failure the moment it happens.
// outcome: "ok" (all paid) or a failure reason for the Flexi Cap SIP (low_balance, autopay_expired, bank_error).
function runSipDay(st, outcome) {
  const out = [];
  const date = st.next_sip;
  if (st.sip_day_done === date) return out;
  const [d, mon, y] = date.split(" "); const m = MONTHS.indexOf(mon);
  st.demo = { d: +d, m, y: +y }; st.today = date; st.today_day = +d; st.next_sip_is_today = false; st.sip_day_done = date;
  if (outcome === "low_balance") { st.salary_ticks = 4; st.balance = 2740; st.ledger.push({ text: "Rent and bills paid this month", amount: -39760 }); }
  const paid = [];
  let failObs = null;
  for (const s of st.sips) {
    if (s.status !== "active") continue;
    if (s.new_amount) { s.amount = s.new_amount; s.new_amount = null; }
    if (s.skip_next) { s.skip_next = false; s.instalments.push({ date, status: "skipped", amount: s.amount }); continue; }
    const fails = s.id === "B" && outcome && outcome !== "ok";
    if (fails && outcome === "autopay_expired") s.autopay = "expired";
    if (fails || (outcome === "low_balance" && st.balance < s.amount)) {
      const reason = outcome === "low_balance" ? "low_balance" : outcome;
      s.instalments.push({ date, status: "failed", amount: s.amount, reason, bank_message: FAIL_REASONS[reason] });
      const nFailed = s.instalments.slice().reverse().findIndex(i => i.status !== "failed");
      const why = [`Bank said: ${FAIL_REASONS[reason]}`];
      if (reason === "low_balance") why.push(`Balance at the time of the debit: ${rupees(st.balance)}, below the ${rupees(s.amount)} instalment`, `Your salary usually arrives on the ${nth(st.salary_day)}, after your SIP date (the ${nth(s.day)})`);
      if (reason === "autopay_expired") why.push("AutoPay for this SIP expired, so the debit wasn't sent to your bank");
      if (reason === "bank_error") why.push(`Your balance (${rupees(st.balance)}) and AutoPay were fine`);
      failObs = makeObs(st, "payment_failed", s, { level: "alert", status: "open", options: true, reason,
        title: `${rupees(s.amount)} SIP payment failed today`,
        what: `Your ${s.fund} instalment of ${rupees(s.amount)} on ${date} didn't go through, so no units were bought for this month.`,
        why, impact: `Your ${rupees(s.value)} already invested is safe and your SIP is still active. ${nFailed === -1 || nFailed >= 3 ? "" : "One missed month doesn't cancel it; 3 in a row would."}`.trim(),
        notify: `Your ${s.fund} payment of ${rupees(s.amount)} failed today. Your invested money is safe. Tap to see why and what you can do.`, ask: "" });
      continue;
    }
    st.balance -= s.amount;
    s.instalments.push({ date, status: "processing", amount: s.amount });
    s.order = { id: `SIP-${s.id}${y}${m + 1}${d}`, status: "processing", debited: date, expected: "1-3 working days", ticks: 2, scheduled: true, amount: s.amount };
    paid.push(s);
  }
  if (paid.length) { st.last_sip = date; out.push(makeObs(st, "sip_debited", null, { title: `${rupees(paid.reduce((a, s) => a + s.amount, 0))} invested today`, what: `${paid.map(s => `${s.fund}: ${rupees(s.amount)}`).join("; ")} debited from ${st.bank}.`, why: ["Your SIP date"], impact: "Units usually show in 1-3 working days. SIP Care will tell you when they're added.", notify: `${paid.length} SIP${paid.length > 1 ? "s" : ""} paid today (${rupees(paid.reduce((a, s) => a + s.amount, 0))}). Units on the way.`, status: "done", level: "info" })); }
  if (failObs) out.unshift(failObs);
  const nx = addMonths(m, +y, 1); st.next_sip = dlabel(SIP_DAY, nx.m, nx.y);
  return out;
}

// Other demo situations (opt-in, for testers).
function injectSituation(st, kind) {
  const out = [];
  if (kind.startsWith("sip_") && st.observations.some(o => ["payment_failed", "salary_in"].includes(o.kind) && ["open", "in_progress"].includes(o.status))) return out; // one failed payment at a time
  if (kind === "sip_low_balance") return runSipDay(st, "low_balance");
  if (kind === "sip_autopay") return runSipDay(st, "autopay_expired");
  if (kind === "sip_bank_error") return runSipDay(st, "bank_error");
  if (kind === "sip_ok") return runSipDay(st, "ok");
  if (kind === "units_pending") {
    const s = sipById(st, "A"); if ((s.order && s.order.status !== "allotted") || s.status !== "active") return out;
    s.order = { id: `OT-A${Date.now() % 100000}`, status: "delayed", debited: st.today, expected: "1-3 working days", ticks: 3, kind: "one_time", amount: s.amount };
    st.balance -= s.amount;
    out.push(makeObs(st, kind, s, { level: "alert", status: "open", title: "Money debited, units not showing yet", what: `${rupees(s.amount)} was debited from ${st.bank} for ${s.fund} today, but the units aren't in your portfolio yet.`, why: ["The order is still being processed by the fund house"], impact: "Your money is not lost. Units usually show 1-3 working days after the debit; if the order fails, the money comes back to your bank.", notify: `${rupees(s.amount)} was debited for ${s.fund}; units aren't showing yet. Tap and I'll check.`, ask: SITUATIONS_DEMO.units_pending.ask }));
  }
  return out;
}

// One background check: move anything in progress along and report changes.
function monitorTick(st) {
  const out = [];
  for (const s of st.sips) {
    if (s.order && ["processing", "delayed"].includes(s.order.status)) {
      s.order.ticks = (s.order.ticks || 1) - 1;
      if (s.order.ticks <= 0) {
        const amt = s.order.amount || s.amount;
        s.order.status = "allotted";
        const inst = s.instalments.find(i => i.status === "processing");
        if (inst) { inst.status = "paid"; delete inst.bank_message; delete inst.reason; }
        s.invested += amt; s.value += amt; s.units = +(s.units + amt / s.nav).toFixed(3);
        out.push(makeObs(st, "units_allotted", s, { title: "Units added to your portfolio", what: `Units for your ${rupees(amt)} in ${s.fund} are now in your portfolio.`, why: [`Order ${s.order.id} completed`], impact: "Nothing else to do.", notify: `Units for ${rupees(amt)} in ${s.fund} are now in your portfolio.`, status: "done" }));
        for (const o of st.observations) if (o.status === "open" && o.sip_id === s.id && (o.kind === "units_pending" || o.kind === "payment_failed")) o.status = "resolved";
      }
    }
    if (s.status === "stop_requested") {
      s.stop_ticks = (s.stop_ticks || 1) - 1;
      if (s.stop_ticks <= 0) { s.status = "stopped"; out.push(makeObs(st, "sip_stopped", s, { title: "SIP stopped", what: `${s.fund} is stopped; no more instalments will be debited.`, why: ["Your stop request was processed"], impact: `Your ${rupees(s.value)} stays invested until you withdraw it. You can start a new SIP any time.`, notify: `${s.fund} is stopped. Your ${rupees(s.value)} stays invested.`, status: "done" })); }
    }
    if (s.autopay === "pending_approval") {
      s.autopay_ticks = (s.autopay_ticks || 1) - 1;
      if (s.autopay_ticks <= 0) { s.autopay = "active"; out.push(makeObs(st, "autopay_active", s, { title: "AutoPay active again", what: `AutoPay for ${s.fund} is active.`, why: ["You approved the new request"], impact: `The ${st.next_sip} instalment will be debited automatically.`, notify: `AutoPay for ${s.fund} is active again.`, status: "done" }));
        for (const o of st.observations) if (o.status === "open" && o.sip_id === s.id && o.kind === "autopay_expired") o.status = "resolved"; }
    }
  }
  for (const r of st.redemptions) if (r.status === "processing") {
    r.ticks = (r.ticks || 1) - 1;
    if (r.ticks <= 0) { r.status = "credited"; const net = r.amount - (r.load || 0); st.balance += net; const s = sipById(st, r.sip_id);
      out.push(makeObs(st, "redemption_credited", s, { title: "Withdrawal credited", what: `${rupees(net)} from ${s.fund} reached ${st.bank}.`, why: [r.load ? `Exit load of ${rupees(r.load)} was deducted` : "No exit load"], impact: s.status === "active" ? "Your SIP continues as usual." : "", notify: `${rupees(net)} from ${s.fund} is in ${st.bank}.`, status: "done" })); }
  }
  // Salary arrives a few checks after a low-balance failure: tell the user they can now pay the missed instalment.
  if (st.salary_ticks) { st.salary_ticks--; if (!st.salary_ticks) { st.balance += 45000; const s = st.sips.find(x => failedInst(x)); const t2 = st.demo ? addMonths(st.demo.m, st.demo.y, 1) : null; const lbl = t2 ? dlabel(st.salary_day, t2.m, t2.y) : "today";
    out.push(makeObs(st, "salary_in", s, s ? { level: "alert", status: "open", options: true, fix: true, title: "Salary received: you can pay the missed instalment", what: `Your salary was credited on ${lbl}; balance is now ${rupees(st.balance)}.`, why: [`${s.fund}: ${rupees(s.amount)} instalment still unpaid`], impact: "Paying it now buys this month's units at today's NAV and keeps your SIP on track.", notify: `Salary received. You can now pay the missed ${rupees(s.amount)} for ${s.fund}. Tap to pay.` } : { title: "Salary received", what: `Balance is now ${rupees(st.balance)}.`, notify: `Salary received. Balance ${rupees(st.balance)}.`, status: "done" })); } }
  // A failed payment that has since been paid resolves its alert.
  for (const o of st.observations) if (["open", "in_progress"].includes(o.status) && ["payment_failed", "salary_in"].includes(o.kind)) { const s = sipById(st, o.sip_id); if (s && !failedInst(s)) o.status = "resolved"; }
  return out;
}

// For tests and the quality gate: a normal account, optionally with demo situations switched on.
function stateWith(situations, nowMs) {
  const st = demoState(nowMs);
  for (const k of situations || []) st.observations.unshift(...injectSituation(st, k));
  return st;
}
