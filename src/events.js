// SIP Care background monitor (v3). The account starts normal. Each check, the agent looks at
// everything in progress (units on the way, withdrawals, stop requests, AutoPay requests) and
// reports when something changes. Testers can also switch on a demo situation to see the agent react.
const OBS_KINDS = ["units_allotted", "redemption_credited", "sip_stopped", "autopay_active", "payment_failed", "units_pending", "autopay_expired"];

const SITUATIONS_DEMO = {
  payment_failed: { label: "A payment fails", ask: "My SIP payment failed. What happened and what should I do?" },
  units_pending: { label: "Money debited, units not showing", ask: "Money was debited but my investment is not showing in the app." },
  autopay_expired: { label: "AutoPay stops working", ask: "Why did my AutoPay stop and what do I need to do?" },
};

let OBS_SEQ = 0;
function makeObs(st, kind, s, f) {
  return Object.assign({ id: "o" + Date.now().toString(36) + (OBS_SEQ++).toString(36), kind, sip_id: s ? s.id : "", fund: s ? s.fund : "", at_day: st.today, level: "info", status: "info",
    title: "", what: "", why: [], impact: "", notify: "", done: [], proposals: [], proposal_ids: [], ask: "" }, f);
}

// Demo situations (opt-in, for testers): change the account so the agent has something to react to.
function injectSituation(st, kind) {
  const out = [];
  if (kind === "payment_failed") {
    const s = sipById(st, "B"); const inst = s.instalments.filter(i => i.status === "paid").slice(-1)[0];
    if (!inst || failedInst(s) || s.status !== "active") return out;
    inst.status = "failed"; inst.bank_message = "Insufficient balance in the bank account";
    const frac = s.amount / s.invested; s.units = +(s.units * (1 - frac)).toFixed(3); s.value = Math.round(s.value * (1 - frac)); s.invested -= s.amount;
    out.push(makeObs(st, kind, s, { level: "alert", status: "open", title: `${inst.date} instalment not paid`, what: `The ${rupees(s.amount)} instalment for ${s.fund} on ${inst.date} didn't go through.`, why: [`Bank said: ${inst.bank_message}`], impact: "No units were bought for that month. Units you already hold are safe, and one missed instalment doesn't cancel the SIP.", notify: `${s.fund}: the ${inst.date} instalment of ${rupees(s.amount)} didn't go through. Your invested money is safe. Tap to see what you can do.`, ask: SITUATIONS_DEMO.payment_failed.ask }));
  }
  if (kind === "units_pending") {
    const s = sipById(st, "A"); if ((s.order && s.order.status !== "allotted") || s.status !== "active") return out;
    s.order = { id: `OT-A${Date.now() % 100000}`, status: "delayed", debited: st.today, expected: "1-3 working days", ticks: 3, kind: "one_time", amount: s.amount };
    st.balance -= s.amount;
    out.push(makeObs(st, kind, s, { level: "alert", status: "open", title: "Money debited, units not showing yet", what: `${rupees(s.amount)} was debited from ${st.bank} for ${s.fund} today, but the units aren't in your portfolio yet.`, why: ["The order is still being processed by the fund house"], impact: "Your money is not lost. Units usually show 1-3 working days after the debit; if the order fails, the money comes back to your bank.", notify: `${rupees(s.amount)} was debited for ${s.fund}; units aren't showing yet. Tap and I'll check.`, ask: SITUATIONS_DEMO.units_pending.ask }));
  }
  if (kind === "autopay_expired") {
    const s = sipById(st, "C"); if (s.autopay !== "active" || s.status !== "active") return out;
    s.autopay = "expired";
    out.push(makeObs(st, kind, s, { level: "alert", status: "open", title: "AutoPay not active", what: `AutoPay for ${s.fund} is no longer active.`, why: ["The AutoPay request expired in your UPI app"], impact: `Your ${st.next_sip} instalment won't be debited automatically until AutoPay is set up again.`, notify: `AutoPay for ${s.fund} isn't active, so the ${st.next_sip} instalment won't run by itself. Tap to fix it.`, ask: SITUATIONS_DEMO.autopay_expired.ask }));
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
        if (inst) { inst.status = "paid"; delete inst.bank_message; }
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
  // A failed payment that has since been paid resolves its alert.
  for (const o of st.observations) if (o.status === "open" && o.kind === "payment_failed") { const s = sipById(st, o.sip_id); if (s && !failedInst(s)) o.status = "resolved"; }
  return out;
}

// For tests and the quality gate: a normal account, optionally with demo situations switched on.
function stateWith(situations, nowMs) {
  const st = demoState(nowMs);
  for (const k of situations || []) st.observations.unshift(...injectSituation(st, k));
  return st;
}
