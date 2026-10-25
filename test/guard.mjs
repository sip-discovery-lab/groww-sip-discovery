import fs from "node:fs";
const src = fs.readFileSync(new URL("../src/guard.js", import.meta.url), "utf8");
const { checkText, redact } = new Function(src + "; return { checkText, redact };")();
const bad = ["You should invest in an index fund.", "Switch to a better fund.", "Invest more this month.", "Markets will recover soon.", "Returns will be good.", "This is guaranteed.", "Pay immediately.", "Act now before it's too late!", "You will lose your money.", "Turant pay karo.", "जल्दी करें", "Please share your PAN with us.", "Send your account number.", "Your PAN ABCDE1234F", "Try the Parag Parikh fund", "HDFC mutual fund is good", "12% return expected", "small cap is better", "Invest in a flexi cap fund"];
const good = ["Your money is safe and will come back to your bank in 5-7 business days.", "Do not share your PAN or account number with anyone.", "Aapka paisa safe hai, yeh 5-7 din me wapas aa jayega.", "आपका पैसा सुरक्षित है।", "Next month's instalment will go through if the balance is there.", "You will not lose the money you already invested.", "You won't lose everything; units you hold stay invested.", "Your HDFC Bank account was debited.", "Money you invest in this SIP stays yours.", "You should check Orders first.", "Apna PAN kisi ko mat batao.", "Never share your OTP.", "Your SIP on the 3rd failed because salary comes on the 7th."];
let f = 0;
for (const b of bad) if (!checkText(b).length) { f++; console.log("MISSED", b); }
for (const g of good) { const fl = checkText(g); if (fl.length) { f++; console.log("FALSE ALARM", g, fl); } }
const r = redact("PAN abcde1234f, a/c 50100012345678, ifsc HDFC0001234, upi ravi.k@okhdfcbank, otp is 4321, aadhaar 1234 5678 9012");
console.log("redacted:", r.found.join(", "), "|", r.text);
if (/abcde1234f|50100012345678|HDFC0001234|okhdfcbank|4321|9012/i.test(r.text)) { f++; console.log("REDACTION LEAK"); }
console.log(`guard tests: ${bad.length + good.length + 1 - f} passed, ${f} failed`);
process.exit(f ? 1 : 0);
