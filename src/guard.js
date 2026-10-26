// Redact personal data BEFORE anything is sent to the model or stored.
function redact(text) {
  let t = String(text || "").slice(0, 1200);
  const found = [];
  const rules = [
    ["PAN", /\b[A-Za-z]{5}\d{4}[A-Za-z]\b/g],
    ["Aadhaar or account number", /\b\d{4}\s?\d{4}\s?\d{4}\b/g],
    ["account or phone number", /\b\d{9,18}\b/g],
    ["UPI ID", /\b[\w.\-]{2,}@[a-zA-Z]{2,}\b/g],
    ["OTP or PIN", /\b(otp|pin|upi pin|password)\s*(is|:|-)?\s*\d{4,6}\b/gi],
    ["IFSC", /\b[A-Za-z]{4}0[A-Za-z0-9]{6}\b/g],
  ];
  for (const [name, re] of rules) {
    if (re.test(t)) { found.push(name); t = t.replace(re, "[removed]"); }
  }
  return { text: t, found };
}

const BANNED = [
  ["advice", /\b(you should (invest|buy|sell|switch|redeem|continue|stop)|i (would )?recommend|we recommend|better to (invest|buy|switch)|switch to (a|an|another|other|the)? ?[\w-]* ?(fund|scheme)|invest more|invest in (a |an |another |other |the )?[\w-]+ ?(fund|scheme|stock)s?|buy (more|units)|sell (your|the) (units|fund))\b/i],
  ["fund or category named", /\b(nifty|sensex|index fund|small ?cap|mid ?cap|large ?cap|flexi ?cap|multi ?cap|elss|liquid fund|debt fund|hybrid fund|gold fund|parag parikh|mirae|nippon|motilal|quant (mutual|fund)|aditya birla sun life)\b/i],
  ["fund house named", /\b(hdfc|sbi|icici|axis|kotak|uti|tata|dsp|edelweiss|franklin)\s+(mutual fund|mf|amc|\w+\s+fund|fund)\b/i],
  ["return or market prediction", /\b(guarantee[sd]?|will (grow|rise|recover|go up|double|give)|market will|returns? will|expected returns?|\d+\s?%\s*(return|cagr|p\.?a))\b/i],
  ["fear or urgency", /\b(immediately|right away|act now|hurry|urgent(ly)?|before it'?s too late|last chance|don'?t miss|you will lose|lose (all|everything)|asap|turant|jaldi|jald se jald)\b|तुरंत|जल्दी/i],
  ["asks for personal data", /\b(share|send|give|provide|enter|batao|bhejo)\s+(me\s+)?(your|apna|apni)?\s*(pan|account number|bank account|otp|pin|password|screenshot|aadhaar)\b/i],
  ["repeats personal data", /\b[A-Z]{5}\d{4}[A-Z]\b|\b\d{9,18}\b/],
];
const NEGATION = /(do not|don't|dont|never|please don't|won't|wont|will not|cannot|can't|not|mat|na karein|nahi|nahin)\s+(\w+\s+){0,2}$/i;

function checkText(text) {
  const flags = [];
  const s = String(text || "");
  for (const [name, re] of BANNED) {
    const m = s.match(re);
    if (!m) continue;
    if (["asks for personal data", "fear or urgency", "advice", "return or market prediction"].includes(name)) {
      const before = s.slice(Math.max(0, m.index - 24), m.index);
      if (NEGATION.test(before)) continue;
      // "No one can promise when your money will grow" is the safe answer, not a prediction.
      if (name === "return or market prediction") { const sent = s.slice(0, m.index).split(/[.!?।]\s/).pop(); if (/\b(no one|nobody|can'?t|cannot|can not|not possible|impossible|no guarantee|isn'?t|is not|not)\b|koi nahi|नहीं/i.test(sent)) continue; }
    }
    flags.push(name);
  }
  return flags;
}

// Check every AI-written field. Returns {flags, clean} where clean has failing fields removed.
function guardOutput(out) {
  const fields = ["summary", "worry_answer", "question", "support_message"];
  const flags = [];
  const clean = Object.assign({}, out);
  for (const f of fields) {
    const fl = checkText(out[f]);
    if (fl.length) { flags.push(...fl.map(x => `${f}: ${x}`)); clean[f] = ""; }
  }
  clean.notes = [];
  for (const n of out.notes || []) {
    const fl = checkText(n.note);
    if (fl.length) flags.push(...fl.map(x => `note(${n.action}): ${x}`));
    else clean.notes.push(n);
  }
  return { flags, clean };
}
