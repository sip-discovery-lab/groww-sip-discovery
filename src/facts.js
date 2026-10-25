// Fixed, signed-off facts and actions. The AI never writes these; it only picks them and adds a personal note.
// Each has a public source so the deck/Evidence Log can cite it.
const SOURCES = {
  groww_fail: { title: "Groww Help: Why did my instalment fail?", url: "https://groww.in/help/mutual-funds/order/why-did-my-installment-fail--25" },
  groww_refund: { title: "Groww Help: My refund failed, what to do now", url: "https://groww.in/help/payments/payments/my-refund-failed-what-to-do-now" },
  groww_skip: { title: "Groww Help: Can I pause SIP for next month", url: "https://groww.in/help/mutual-funds/order/can-i-pause-sip-for-next-month" },
  groww_edit: { title: "Groww Blog: How to edit an SIP on Groww", url: "https://groww.in/blog/how-to-edit-sip-on-groww" },
  groww_autopay: { title: "Groww Help: Switch biller mandate to Groww AutoPay", url: "https://groww.in/help/payments-&-withdrawals/discoverable/how-to-switch-biller-mandate-to-groww-autopay--64" },
  kotak_fail: { title: "Kotak MF: Why did my SIP instalment fail", url: "https://www.kotakmf.com/Information/blogs/why-did-sip-installment-failed" },
  torus_units: { title: "Torus FAQ: SIP deducted but holding not updated", url: "https://www.torusdigital.com/faqs/mutual-fund/sip-instalment-was-deducted-but-the-holding-not-updated-in-portfolio-cS07lg" },
  kuvera_stop: { title: "Kuvera: How to restart a SIP after stopping it", url: "https://kuvera.in/blog/how-to-restart-a-sip-after-stopping-it/" },
};

// Plain-language facts shown with answers.
const FACTS = {
  units_safe: { text: "Money you already invested stays invested. A failed or missed instalment does not touch units you already hold.", src: "kotak_fail" },
  no_amc_penalty: { text: "The fund house does not charge a penalty for one failed instalment. Your bank may charge its own bounce fee; the amount depends on the bank.", src: "kotak_fail" },
  three_strikes: { text: "One failed month does not end a monthly SIP. It is usually cancelled only after 3 failures in a row, and one successful payment resets that count.", src: "kotak_fail" },
  refund_window: { text: "If money left your bank but the order failed, it goes back to the same bank account within 5-7 business days. Your money is not at risk.", src: "groww_refund" },
  units_timing: { text: "When a payment goes through, units usually show up 1-3 working days later.", src: "torus_units" },
  balance_4_days: { text: "Keep the SIP amount in your bank account from 4 days before the SIP date.", src: "groww_fail" },
  nav_on_payment: { text: "If you pay a missed instalment yourself, units are bought at the price on the day you pay, not the original date.", src: "groww_fail" },
  autopay_change_time: { text: "Changing which AutoPay a SIP uses takes 2-7 days to process.", src: "groww_autopay" },
  stop_keeps_units: { text: "Stopping a SIP only stops future instalments. Units you already hold stay invested until you choose to sell them.", src: "kuvera_stop" },
};

// Actions the person can choose. Steps are fixed text; the AI may add one personal note.
const ACTIONS = {
  wait_refund: { title: "Wait for the refund, then check", steps: ["In the Groww app, open Orders and look at this SIP's order status.", "If it says failed, the money returns to your bank within 5-7 business days.", "If it has not come back after 7 business days, contact support (message below)."], facts: ["refund_window"] },
  check_units: { title: "Check if units are on the way", steps: ["In the Groww app, open Orders and look at this SIP's order status.", "If it says processing, units usually show up in 1-3 working days.", "If nothing shows after 3 working days, contact support (message below)."], facts: ["units_timing"] },
  pay_one_time: { title: "Pay this month's instalment yourself", steps: ["In the Groww app, open My SIPs and select this SIP.", "Tap 'Pay one-time' and enter the SIP amount.", "Complete the payment."], facts: ["nav_on_payment"] },
  fix_autopay: { title: "Check and fix AutoPay", steps: ["In the Groww app, open My SIPs, select this SIP and look at the AutoPay section.", "If AutoPay is not approved or not linked, set it up again or link an active AutoPay.", "Until it shows active, pay this month with 'Pay one-time' if you want this month invested."], facts: ["autopay_change_time"] },
  keep_balance: { title: "Keep the amount ready before the date", steps: ["Note your SIP date.", "Keep the SIP amount in the linked bank account from 4 days before it."], facts: ["balance_4_days"] },
  move_date: { title: "Move the SIP date to after payday", steps: ["In the Groww app, open My SIPs, select this SIP and tap 'Edit SIP'.", "Choose 'Edit Amount & Date' and pick a date a few days after your income arrives.", "Save, and check the date shown on the confirmation screen."], facts: [] },
  skip_one: { title: "Skip just this month", steps: ["In the Groww app, open My SIPs, select this SIP and tap 'Edit SIP'.", "Choose 'Skip Instalment' and check which month it skips.", "Confirm. Later instalments continue as scheduled. If the app says it is too close to the date, use another option."], facts: [] },
  reduce_amount: { title: "Lower the amount for now", steps: ["In the Groww app, open My SIPs, select this SIP and tap 'Edit SIP'.", "Choose 'Edit Amount & Date' and enter an amount that fits this month.", "You can raise it again later the same way."], facts: [] },
  let_next_run: { title: "Do nothing this month", steps: ["Leave the SIP as it is.", "Next month's instalment runs as normal if the balance is there."], facts: ["three_strikes"] },
  stop_sip: { title: "Stop the SIP", steps: ["In the Groww app, open My SIPs, select this SIP and tap 'Edit SIP'.", "Choose the option to cancel or stop the SIP and confirm."], facts: ["stop_keeps_units"] },
  contact_support: { title: "Contact support", steps: ["In the Groww app, use Help & Support or the customer care page.", "Copy the message below. Do not share your PAN, bank account number, OTP or PIN in chat."], facts: [] },
};

// Situations the AI can choose, with the actions shown for each (first = main action).
const SITUATIONS = {
  money_stuck: { label: "Money left my bank, but no units yet", actions: ["check_units", "wait_refund", "contact_support"], facts: ["units_safe"] },
  instalment_failed: { label: "My instalment failed", actions: ["pay_one_time", "let_next_run", "keep_balance", "move_date", "stop_sip"], facts: ["units_safe", "no_amc_penalty", "three_strikes"] },
  autopay_problem: { label: "AutoPay is not working", actions: ["fix_autopay", "pay_one_time", "contact_support"], facts: ["units_safe", "three_strikes"] },
  low_balance_ahead: { label: "My balance may be short before the SIP date", actions: ["keep_balance", "skip_one", "move_date", "reduce_amount", "let_next_run", "stop_sip"], facts: ["units_safe", "no_amc_penalty", "three_strikes"] },
  out_of_scope: { label: "Something this helper does not cover", actions: [], facts: [] },
  unclear: { label: "Not sure yet", actions: [], facts: [] },
};

const SITUATION_IDS = Object.keys(SITUATIONS);
const ACTION_IDS = Object.keys(ACTIONS);
