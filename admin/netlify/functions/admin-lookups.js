// admin/netlify/functions/admin-lookups.js
//
// FUNCTION — Reference data for the Users form's scope pickers.
// Provinces/regions come from bi_regions (the BI reports' shared
// geography table). Midis come from clicka_midis — the LIVE, operational
// Midi/Wholesaler table that clicka_orders / clicka_midi_products /
// clicka_midi_service_regions actually key off (NOT bi_midis, which is a
// separate Trade Map/BI snapshot with its own disconnected ids — a PPM
// Agent scoped to a bi_midis row would never match a real order).
//
// Query params:
//   type=provinces   -> distinct province names
//   type=regions     -> {id, name, province} for every sub-region
//   type=midis       -> {id, name, province, region} for every Midi/wholesaler,
//                        sorted by name so a long list is easy to scan/search
//   type=drivers     -> {id, first_name, last_name, cell_number} for every
//                        active clicka_staff row with role 'driver' — for the
//                        "assign a driver" picker on a Ready to Collect order
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
      const res = await sb("/rest/v1/clicka_midis?select=id,name,address,home_region_id&order=name");
      const midis = await res.json();

      const regionIds = [...new Set((Array.isArray(midis) ? midis : []).map((m) => m.home_region_id).filter(Boolean))];
      let regionsById = {};
      if (regionIds.length) {
        const regionRes = await sb("/rest/v1/bi_regions?id=in.(" + regionIds.join(",") + ")&select=id,name,province");
        const regions = await regionRes.json();
        regionsById = Object.fromEntries((Array.isArray(regions) ? regions : []).map((r) => [r.id, r]));
      }

      const enriched = (Array.isArray(midis) ? midis : []).map((m) => {
        const r = regionsById[m.home_region_id];
        return {
          id: m.id,
          name: m.name,
          province: r ? r.province : null,
          region: r ? r.name : null,
        };
      });
      return json(200, { ok: true, midis: enriched });
    }

    if (type === "drivers") {
      const res = await sb("/rest/v1/clicka_staff?role=eq.driver&status=eq.active&select=id,first_name,last_name,cell_number&order=first_name.asc,last_name.asc");
      const drivers = await res.json();
      return json(200, { ok: true, drivers: Array.isArray(drivers) ? drivers : [] });
    }

    return json(400, { ok: false, error: "Unknown type. Use provinces, regions, midis, or drivers." });
  } catch (e) {
    return json(500, { ok: false, error: String(e.message || e) });
  }
};
