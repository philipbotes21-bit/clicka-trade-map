// admin/netlify/functions/admin-cashless-payments.js
//
// FUNCTION — Clicka Admin: Cashless payments TO Wholesalers.
// Manual capture for now — Warren wants this tracked before the Shop2Shop
// (S2S) integration exists to feed it automatically. Someone back-office
// (Admin/Supervisor/Regional Manager) loads each payment by hand: the date
// it was paid, which Midi/Wholesaler it was paid to, which brand/client it
// relates to, and the amount. Once S2S integration exists, this table and
// this capture screen are the same place that data will land — nothing
// downstream (the BI report) needs to change.
//
// GET  -> list payments (brand-scoped — see below), with Wholesaler and
//         Brand names resolved. Filters: &midi_id=&brand_id=&from=&to=&search=
// POST -> capture one payment.
//   body: { payment_date, midi_id, brand_id, amount_paid }
//
// Per-brand / per-client visibility: same rule as Invoices
// (admin-invoices.js) — a caller with a clicka_staff_scope row of
// scope_type "brand" only ever sees/creates payments for that brand.
// Admin is never brand-restricted. Supervisor/Regional Manager without a
// brand scope assigned see everything.
//
// Role: Admin, Supervisor, Regional Manager only — this is a back-office
// bookkeeping screen, not a field-agent tool.
//
// Self-test (no auth needed, no data touched):
//   /.netlify/functions/admin-cashless-payments?selftest=1

const { json, sb, getCaller } = require("./_auth");

const ALLOWED_ROLES = ["admin", "supervisor", "regional_manager"];

// The one brand a caller is locked to, if any — null means "not brand-
// restricted" (Admin always; anyone else who simply has no brand assigned).
function callerBrandLock(caller) {
  if (caller.staff.role === "admin") return null;
  const row = (caller.scope || []).find((s) => s.scope_type === "brand");
  return row ? row.brand_id : null;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

  const qs = event.queryStringParameters || {};
  if (qs.selftest === "1") return json(200, { ok: true, world: "CLICKA-ADMIN" });

  const caller = await getCaller(event);
  if (!caller || !caller.staff) return json(401, { ok: false, error: "Not signed in." });
  if (caller.staff.status === "inactive") return json(403, { ok: false, error: "Account deactivated." });
  if (!ALLOWED_ROLES.includes(caller.staff.role)) {
    return json(403, { ok: false, error: "Cashless payments are managed by Admin, Supervisor, and Regional Manager accounts." });
  }

  const brandLock = callerBrandLock(caller);

  if (event.httpMethod === "POST") {
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { ok: false, error: "Invalid JSON body." }); }
    const { payment_date, midi_id, brand_id, amount_paid } = body;
    if (!payment_date) return json(400, { ok: false, error: "Payment date is required." });
    if (!midi_id) return json(400, { ok: false, error: "Pick which Wholesaler this payment went to." });
    if (!brand_id) return json(400, { ok: false, error: "Pick which brand/client this payment relates to." });
    if (amount_paid === undefined || amount_paid === null || isNaN(Number(amount_paid)) || Number(amount_paid) <= 0) {
      return json(400, { ok: false, error: "Amount paid must be a positive number." });
    }
    if (brandLock && String(brand_id) !== String(brandLock)) {
      return json(403, { ok: false, error: "You can only capture payments for your assigned brand." });
    }

    const res = await sb("/rest/v1/clicka_wholesaler_cashless_payments", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify([{
        payment_date,
        midi_id,
        brand_id,
        amount_paid: Number(amount_paid),
        captured_by_staff_id: caller.staff.id,
      }]),
    });
    const rows = await res.json();
    if (!res.ok || !Array.isArray(rows) || !rows.length) {
      return json(200, { ok: false, error: "Couldn't save this payment: " + JSON.stringify(rows).slice(0, 300) });
    }
    return json(200, { ok: true, payment: rows[0] });
  }

  if (event.httpMethod !== "GET") return json(405, { ok: false, error: "Method not allowed." });

  const effectiveBrandId = caller.staff.role === "admin" ? (qs.brand_id || null) : (brandLock || qs.brand_id || null);

  let url = "/rest/v1/clicka_wholesaler_cashless_payments?select=*&order=payment_date.desc&limit=2000";
  if (qs.midi_id) url += "&midi_id=eq." + qs.midi_id;
  if (effectiveBrandId) url += "&brand_id=eq." + effectiveBrandId;
  if (qs.from) url += "&payment_date=gte." + qs.from;
  if (qs.to) url += "&payment_date=lte." + qs.to;

  const res = await sb(url);
  const rows = await res.json();
  if (!res.ok) return json(200, { ok: false, error: JSON.stringify(rows).slice(0, 300) });
  let payments = Array.isArray(rows) ? rows : [];
  if (!payments.length) return json(200, { ok: true, payments: [] });

  const midiIds = [...new Set(payments.map((p) => p.midi_id).filter(Boolean))];
  let midisById = {};
  if (midiIds.length) {
    const midiRes = await sb("/rest/v1/clicka_midis?id=in.(" + midiIds.join(",") + ")&select=id,name");
    const midiRows = await midiRes.json();
    midisById = Object.fromEntries((Array.isArray(midiRows) ? midiRows : []).map((m) => [m.id, m.name]));
  }

  const brandIds = [...new Set(payments.map((p) => p.brand_id).filter(Boolean))];
  let brandsById = {};
  if (brandIds.length) {
    const brandRes = await sb("/rest/v1/bi_brands?id=in.(" + brandIds.join(",") + ")&select=id,name");
    const brandRows = await brandRes.json();
    brandsById = Object.fromEntries((Array.isArray(brandRows) ? brandRows : []).map((b) => [b.id, b.name]));
  }

  const staffIds = [...new Set(payments.map((p) => p.captured_by_staff_id).filter(Boolean))];
  let staffById = {};
  if (staffIds.length) {
    const staffRes = await sb("/rest/v1/clicka_staff?id=in.(" + staffIds.join(",") + ")&select=id,first_name,last_name");
    const staffRows = await staffRes.json();
    staffById = Object.fromEntries((Array.isArray(staffRows) ? staffRows : []).map((s) => [s.id, s.first_name + " " + s.last_name]));
  }

  let enriched = payments.map((p) => ({
    id: p.id,
    payment_date: p.payment_date,
    midi_id: p.midi_id,
    midi_name: midisById[p.midi_id] || "Unknown",
    brand_id: p.brand_id,
    brand_name: brandsById[p.brand_id] || "Unknown",
    amount_paid: Number(p.amount_paid) || 0,
    captured_by: staffById[p.captured_by_staff_id] || "Unknown",
    created_at: p.created_at,
  }));

  if (qs.search) {
    const s = qs.search.toLowerCase();
    enriched = enriched.filter((p) =>
      p.midi_name.toLowerCase().includes(s) || p.brand_name.toLowerCase().includes(s)
    );
  }

  return json(200, {
    ok: true,
    payments: enriched,
    total: enriched.reduce((sum, p) => sum + p.amount_paid, 0),
  });
};
