// admin/netlify/functions/admin-suppliers.js
//
// FUNCTION — Clicka Admin: Suppliers list (bi_brands — same table the BI
// reports already use for Tiger Brands / Unilever). Categories and
// Supplier Products are both scoped by supplier, so this is the picker
// list for both, plus the "add a new supplier" action.
//
// GET   -> list every supplier
// POST  -> add a new supplier {name}
//
// Admin-only.
//
// Self-test (no auth needed, no data touched):
//   /.netlify/functions/admin-suppliers?selftest=1

const { json, sb, getCaller } = require("./_auth");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

  const qs = event.queryStringParameters || {};
  if (qs.selftest === "1") return json(200, { ok: true, world: "CLICKA-ADMIN" });

  const caller = await getCaller(event);
  if (!caller || !caller.staff) return json(401, { ok: false, error: "Not signed in." });
  if (caller.staff.status === "inactive") return json(403, { ok: false, error: "Account deactivated." });
  if (caller.staff.role !== "admin") return json(403, { ok: false, error: "Admin access only." });

  if (event.httpMethod === "GET") {
    const res = await sb("/rest/v1/bi_brands?select=*&order=name");
    const suppliers = await res.json();
    return json(200, { ok: true, suppliers: suppliers || [] });
  }

  if (event.httpMethod === "POST") {
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { ok: false, error: "Invalid JSON body." }); }
    if (!body.name || !String(body.name).trim()) return json(400, { ok: false, error: "Supplier name is required." });

    const res = await sb("/rest/v1/bi_brands", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify([{ name: String(body.name).trim() }]),
    });
    const rows = await res.json();
    if (!res.ok) return json(200, { ok: false, error: JSON.stringify(rows).slice(0, 300) });
    return json(200, { ok: true, supplier: rows[0] });
  }

  return json(405, { ok: false, error: "Method not allowed." });
};
