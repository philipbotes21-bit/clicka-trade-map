// admin/netlify/functions/_s2s_pay.js
//
// Builds the Shop2Shop "specific" payment link for ONE order: fixed amount,
// fixed reference, paid into Clicka's own Shop2Shop wallet. Per the Shop2Shop
// integration doc (v2.3):
//   https://shop.shoptoshop.co.za/qr-code/send?requestPayment=<Base64(&code=..&amount=<cents>&reference=..)>
// The payer cannot edit amount or reference, so the payment that comes back
// on the Rabbit feed carries our order number and matches itself.
//
// Clicka's wallet shop code is NOT hardcoded: set CLICKA_WALLET_SHOP_CODE in
// this Netlify site's environment variables. Until it is set, no link is
// produced and the app simply shows "payment link not set up yet".
//
// Base64 can contain + / = so the value is percent-encoded. Confirm with
// Shop2Shop on UAT that their page accepts that (see vault note).

// Clicka Pay — Clicka's own Shop2Shop wallet (the only wallet traders pay into).
// Hardcoded default per Philip; CLICKA_WALLET_SHOP_CODE overrides it if it ever changes.
const WALLET_CODE = (process.env.CLICKA_WALLET_SHOP_CODE || "3QWTJF").trim().toUpperCase();
const PAY_BASE = process.env.S2S_PAY_BASE || "https://shop.shoptoshop.co.za/qr-code/send";

function buildPayment(orderNumber, amountDueRands) {
  const amount = Math.round(Number(amountDueRands) * 100) / 100;
  if (!WALLET_CODE) return { configured: false };
  if (!orderNumber || !(amount > 0)) return { configured: true, link: null, amount };
  const cents = Math.round(amount * 100);
  const raw = "&code=" + WALLET_CODE + "&amount=" + cents + "&reference=" + orderNumber;
  const encoded = Buffer.from(raw, "utf8").toString("base64");
  return {
    configured: true,
    wallet_code: WALLET_CODE,
    amount,
    reference: orderNumber,
    link: PAY_BASE + "?requestPayment=" + encodeURIComponent(encoded),
  };
}

module.exports = { buildPayment, WALLET_CODE };
