// admin/netlify/functions/admin-categories.js
//
// FUNCTION — Clicka Admin: product Categories, scoped per supplier.
// Categories are per-supplier (Tiger Brands' category list is entirely
// separate from Unilever's) — this is deliberately a NEW table
// (clicka_categories), not the shared bi_categories the BI reports read
// from, so curating this master list can never disturb the already-working
// Products BI tab.
//
// GET  ?brand_id=1      -> categories for that supplier
// POST                  -> create a category {brand_id, name}
//
// Admin-only for now (same as Users).
//
// Self-test (no auth needed, no data touched):
//   /.netlify/functions/admin-categories?selftest=1

const { json, sb, getCaller } = require("./_auth");

async function requireAdmin(event) {
  const caller = await getCaller(event);
  if (!caller || !caller.staff) return { error: json(401, { ok: false, error: "Not signed in." }) };
  if (caller.staff.status === "inactive") return { error: json(403, { ok: false, error: "Account deactivated." }) };
  if (caller.staff.role !== "admin") return { error: json(403, { ok: false, error: "Admin access only." }) };
  return { caller };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

  const qs = event.queryStringParameters || {};
  if (qs.selftest === "1") return json(200, { ok: true, world: "CLICKA-ADMIN" });

  const gate = await requireAdmin(event);
  if (gate.error) return gate.error;

  if (event.httpMethod === "GET") {
    let url = "/rest/v1/clicka_categories?select=*&order=name";
    if (qs.brand_id) url += "&brand_id=eq." + encodeURIComponent(qs.brand_id);
    const res = await sb(url);
    const categories = await res.json();
    return json(200, { ok: true, categories: categories || [] });
  }

  if (event.httpMethod === "POST") {
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { ok: false, error: "Invalid JSON body." }); }
    if (!body.brand_id || !body.name) return json(400, { ok: false, error: "brand_id and name are required." });

    const res = await sb("/rest/v1/clicka_categories?on_conflict=brand_id,name", {
      method: "POST",
      headers: { Prefer: "return=representation,resolution=merge-duplicates" },
      body: JSON.stringify([{ brand_id: body.brand_id, name: String(body.name).trim() }]),
    });
    const rows = await res.json();
    if (!res.ok) return json(200, { ok: false, error: JSON.stringify(rows).slice(0, 300) });
    return json(200, { ok: true, category: rows[0] });
  }

  return json(405, { ok: false, error: "Method not allowed." });
};
