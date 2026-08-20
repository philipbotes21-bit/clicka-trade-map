// admin/netlify/functions/admin-lookups.js
//
// FUNCTION — Reference data for the Users form's scope pickers.
// Reads the same shared bi_regions / bi_midis tables the BI reports use
// (read-only, no PII in either table), so scope assignment always lines
// up with real provinces / sub-regions / Midis.
//
// Query params:
//   type=provinces   -> distinct province names
//   type=regions     -> {id, name, province} for every sub-region
//   type=midis       -> {id, name, province, region} for every Midi/wholesaler
//
// Requires a signed-in Clicka Admin session (any active role) — this is
// reference data, not a data-mutation endpoint, so any logged-in staff
// member can read it.

const { json, sb, getCaller } = require("./_auth");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

  const caller = await getCaller(event);
  if (!caller || !caller.staff) return json(401, { ok: false, error: "Not signed in." });
  if (caller.staff.status === "inactive") return json(403, { ok: false, error: "Account deactivated." });

  const qs = event.queryStringParameters || {};
  const type = qs.type || "";

  try {
    if (type === "provinces") {
      const res = await sb("/rest/v1/bi_regions?select=province&order=province");
      const rows = await res.json();
      const provinces = [...new Set(rows.map((r) => r.province).filter(Boolean))].sort();
      return json(200, { ok: true, provinces });
    }

    if (type === "regions") {
      const res = await sb("/rest/v1/bi_regions?select=id,name,province&order=province,name");
      const regions = await res.json();
      return json(200, { ok: true, regions });
    }

    if (type === "midis") {
      const res = await sb("/rest/v1/bi_midis?select=id,name,province,region&order=province,name");
      const midis = await res.json();
      return json(200, { ok: true, midis });
    }

    return json(400, { ok: false, error: "Unknown type. Use provinces, regions, or midis." });
  } catch (e) {
    return json(500, { ok: false, error: String(e.message || e) });
  }
};
