// SIP Care background monitor (v3). The account starts normal. Each check, the agent looks at
// everything in progress (units on the way, withdrawals, stop requests, AutoPay requests) and
// reports when something changes. Testers can also switch on a demo situation to see the agent react.
const OBS_KINDS = ["sip_debited", "refunded", "units_allotted", "redemption_credited", "sip_stopped", "autopay_active", "payment_failed", "units_pending", "autopay_expired"];

const SITUATIONS_DEMO = {
  sip_low_balance: { label: "Payment fails: insufficient funds" },
  sip_autopay: { label: "Payment fails: AutoPay expired" },
  sip_not_approved: { label: "Payment fails: AutoPay never approved" },
  sip_mandate_limit: { label: "Payment fails: AutoPay limit too low" },
  sip_mandate_cancelled: { label: "Payment fails: AutoPay cancelled from bank app" },
  sip_bank_error: { label: "Payment fails: bank technical error" },
  sip_debited: { label: "Money debited, units not added" },
  sip_ok: { label: "No problem: all payments go through" },
  units_pending: { label: "Money debited, units not showing", ask: "Money was debited but my investment is not showing in the app." },
};
const SCENARIO_REASON = { sip_low_balance: "low_balance", sip_autopay: "autopay_expired", sip_not_approved: "autopay_not_approved", sip_mandate_limit: "mandate_limit", sip_mandate_cancelled: "mandate_cancelled", sip_bank_error: "bank_error", sip_debited: "debited_not_allotted", sip_ok: "ok" };
const FAIL_SCENARIOS = Object.keys(SCENARIO_REASON).filter(k => k !== "sip_ok");

let OBS_SEQ = 0;
function makeObs(st, kind, s, f) {
  return Object.assign({ id: "o" + Date.now().toString(36) + (OBS_SEQ++).toString(36), kind, sip_id: s ? s.id : "", fund: s ? s.fund : "", at_day: st.today, level: "info", status: "info",
    title: "", what: "", why: [], impact: "", notify: "", done: [], proposals: [], proposal_ids: [], ask: "" }, f);
}

// SIP day: the agent watches every debit and reports a failure the moment it happens.
// outcome: "ok" (all paid) or a failure reason (FAIL_REASONS) for the Flexi Cap SIP. Everything here is known to the app
// from the bank's response, the AutoPay (mandate) status or the order status; never from the user's bank balance.
function runSipDay(st, outcome) {
  const out = [];
  const date = st.next_sip;
  if (st.sip_day_done === date) return out;
  const [d, mon, y] = date.split(" "); const m = MONTHS.indexOf(mon);
  st.demo = { d: +d, m, y: +y }; st.today = date; st.today_day = +d; st.next_sip_is_today = false; st.sip_day_done = date;
  const B = sipById(st, "B");
  if (outcome === "mandate_limit") { B.mandate_limit = 1500; B.note = `SIP amount raised from ${rupees(1500)} to ${rupees(B.amount)} last month; AutoPay limit stayed at ${rupees(1500)}`; }
  if (outcome === "autopay_expired") B.autopay = "expired";
  if (outcome === "mandate_cancelled") B.autopay = "cancelled";
  if (outcome === "autopay_not_approved") B.autopay = "not_approved";
  const paid = [];
  let failObs = null;
  for (const s of st.sips) {
    if (s.status !== "active") continue;
    if (s.new_amount) { s.amount = s.new_amount; s.new_amount = null; }
    if (s.skip_next) { s.skip_next = false; s.instalments.push({ date, status: "skipped", amount: s.amount }); continue; }
    if (s.id === "B" && outcome && outcome !== "ok") {
      const reason = outcome;
      const msg = reason === "mandate_limit" ? `SIP amount ${rupees(s.amount)} is higher than your AutoPay limit of ${rupees(s.mandate_limit)}` : FAIL_REASONS[reason];
      s.instalments.push({ date, status: "failed", amount: s.amount, reason, bank_message: msg });
      const why = [`${reason === "debited_not_allotted" ? "Order status" : reason.startsWith("autopay") || reason.startsWith("mandate") ? "AutoPay status" : "Bank response"}: ${msg}`];
      if (reason === "low_balance" || reason === "bank_error") why.push("AutoPay for this SIP is active");
      if (reason === "mandate_limit") why.push(s.note);
      if (reason === "debited_not_allotted") { why.push(`${rupees(s.amount)} left your bank account on ${date}`); s.order = { id: `SIP-B${y}${m + 1}${d}`, status: "refund_pending", debited: date, ticks: 4, amount: s.amount }; }
      const debited = reason === "debited_not_allotted";
      failObs = makeObs(st, "payment_failed", s, { level: "alert", status: "open", options: true, reason, year1: firstYear(s, st).line,
        title: debited ? `${rupees(s.amount)} debited, units not added` : `${rupees(s.amount)} SIP payment failed today`,
        what: debited ? `Your ${s.fund} instalment of ${rupees(s.amount)} was debited on ${date}, but the fund house didn't confirm the order, so no units were added.` : `Your ${s.fund} instalment of ${rupees(s.amount)} on ${date} didn't go through, so no units were bought for this month.`,
        why, impact: debited ? `Your money isn't lost: if the order isn't confirmed it's refunded to ${st.bank} in 5-7 business days. Your ${rupees(s.value)} already invested is safe.` : `Your ${rupees(s.value)} already invested is safe and your SIP is still active. One missed month doesn't cancel it; 3 in a row would.`,
        notify: debited ? `${rupees(s.amount)} was debited for ${s.fund} but units weren't added. Your money is safe. See what SIP Care is doing.` : `Your ${s.fund} payment of ${rupees(s.amount)} failed today. Your invested money is safe. See why and what you can do.`, ask: "" });
      continue;
    }
    s.instalments.push({ date, status: "processing", amount: s.amount });
    s.order = { id: `SIP-${s.id}${y}${m + 1}${d}`, status: "processing", debited: date, expected: "1-3 working days", ticks: 2, scheduled: true, amount: s.amount };
    paid.push(s);
  }
  if (paid.length) { st.last_sip = date; out.push(makeObs(st, "sip_debited", null, { title: `${rupees(paid.reduce((a, s) => a + s.amount, 0))} invested today`, what: `${paid.map(s => `${s.fund}: ${rupees(s.amount)}`).join("; ")} debited from ${st.bank}.`, why: ["Your SIP date"], impact: "Units usually show in 1-3 working days. SIP Care will tell you when they're added.", notify: `${paid.length} SIP${paid.length > 1 ? "s" : ""} paid today (${rupees(paid.reduce((a, s) => a + s.amount, 0))}). Units on the way.`, status: "done", level: "info" })); }
  if (failObs) out.unshift(failObs);
  const nx = addMonths(m, +y, 1); st.next_sip = dlabel(SIP_DAY, nx.m, nx.y);
  return out;
}

// Demo situations (opt-in, for testers).
function injectSituation(st, kind) {
  const out = [];
  if (kind.startsWith("sip_") && st.observations.some(o => o.kind === "payment_failed" && ["open", "in_progress"].includes(o.status))) return out; // one failed payment at a time
  if (SCENARIO_REASON[kind]) return runSipDay(st, SCENARIO_REASON[kind]);
  if (kind === "units_pending") {
    const s = sipById(st, "A"); if ((s.order && s.order.status !== "allotted") || s.status !== "active") return out;
    s.order = { id: `OT-A${Date.now() % 100000}`, status: "delayed", debited: st.today, expected: "1-3 working days", ticks: 3, kind: "one_time", amount: s.amount };
    out.push(makeObs(st, kind, s, { level: "alert", status: "open", title: "Money debited, units not showing yet", what: `${rupees(s.amount)} was debited from ${st.bank} for ${s.fund} today, but the units aren't in your portfolio yet.`, why: ["The order is still being processed by the fund house"], impact: "Your money is not lost. Units usually show 1-3 working days after the debit; if the order fails, the money comes back to your bank.", notify: `${rupees(s.amount)} was debited for ${s.fund}; units aren't showing yet. Open it and I'll check.`, ask: SITUATIONS_DEMO.units_pending.ask }));
  }
  return out;
}

// One background check: move anything in progress along and report changes.
function monitorTick(st) {
  const out = [];
  for (const s of st.sips) {
    if (s.order && s.order.status === "refund_pending") {
      s.order.ticks = (s.order.ticks || 1) - 1;
      if (s.order.ticks <= 0) { s.order.status = "refunded"; const f = failedInst(s); if (f) { f.refunded = true; f.bank_message = "Order not confirmed; amount refunded to your bank"; }
        out.push(makeObs(st, "refunded", s, { title: `${rupees(s.amount)} refunded`, what: `The fund house didn't confirm the order, so ${rupees(s.amount)} was refunded to ${st.bank}.`, why: [`Order ${s.order.id} was not confirmed`], impact: "You can now pay this month's instalment again if you want to keep it.", notify: `${rupees(s.amount)} for ${s.fund} was refunded to ${st.bank}. You can pay this month's instalment again.`, status: "done", level: "info" })); }
    }
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
    if (r.ticks <= 0) { r.status = "credited"; const net = r.amount - (r.load || 0); const s = sipById(st, r.sip_id);
      out.push(makeObs(st, "redemption_credited", s, { title: "Withdrawal credited", what: `${rupees(net)} from ${s.fund} reached ${st.bank}.`, why: [r.load ? `Exit load of ${rupees(r.load)} was deducted` : "No exit load"], impact: s.status === "active" ? "Your SIP continues as usual." : "", notify: `${rupees(net)} from ${s.fund} is in ${st.bank}.`, status: "done" })); }
  }
  // A failed payment that has since been paid resolves its alert.
  for (const o of st.observations) if (["open", "in_progress"].includes(o.status) && o.kind === "payment_failed") { const s = sipById(st, o.sip_id); if (s && !failedInst(s)) o.status = "resolved"; }
  return out;
}

// For tests and the quality gate: a normal account, optionally with demo situations switched on.
function stateWith(situations, nowMs) {
  const st = demoState(nowMs);
  for (const k of situations || []) st.observations.unshift(...injectSituation(st, k));
  return st;
}
