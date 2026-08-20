// admin/netlify/functions/admin-midis.js
//
// FUNCTION — Clicka Admin: Midi / Wholesaler master list.
// Deliberately a NEW table (clicka_midis + service-region + brand-scope
// join tables), separate from bi_midis (which the BI Sales In/Out reports
// read from, derived from Tiger/Unilever's own order-system exports and
// left untouched here). This one is the operational list Admin/Supervisor/
// Regional Manager curate directly: where a Midi is based, which
// sub-regions it actually services (can differ — e.g. based in Tembisa,
// services Diepsloot/Alex/Pretoria), and which supplier(s) it carries.
//
// GET   -> list every Midi with its home region, serviced regions, and
//          brand scope resolved to readable names.
// POST  -> create one {name, home_region_id, services_all_brands, service_region_ids: [...], brand_ids: [...] }
//
// Visible to Admin, Supervisor, and Regional Manager (same trio as Stores).
// Agents and PPM Agents don't get this list from the onboarding app yet.
//
// Self-test (no auth needed, no data touched):
//   /.netlify/functions/admin-midis?selftest=1

const { json, sb, getCaller } = require("./_auth");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

  const qs = event.queryStringParameters || {};
  if (qs.selftest === "1") return json(200, { ok: true, world: "CLICKA-ADMIN" });

  const caller = await getCaller(event);
  if (!caller || !caller.staff) return json(401, { ok: false, error: "Not signed in." });
  if (caller.staff.status === "inactive") return json(403, { ok: false, error: "Account deactivated." });
  if (!["admin", "supervisor", "regional_manager"].includes(caller.staff.role)) {
    return json(403, { ok: false, error: "Midi / Wholesaler access is limited to Admin, Supervisor, and Regional Manager roles." });
  }

  if (event.httpMethod === "GET") {
    const midisRes = await sb("/rest/v1/clicka_midis?select=*&order=name");
    const midis = await midisRes.json();

    const regionsRes = await sb("/rest/v1/bi_regions?select=id,name,province");
    const regions = await regionsRes.json();
    const regionsById = Object.fromEntries((regions || []).map((r) => [r.id, r]));

    const brandsRes = await sb("/rest/v1/bi_brands?select=id,name");
    const brands = await brandsRes.json();
    const brandsById = Object.fromEntries((brands || []).map((b) => [b.id, b]));

    const serviceRes = await sb("/rest/v1/clicka_midi_service_regions?select=*");
    const serviceRows = await serviceRes.json();
    const serviceByMidi = {};
    for (const s of serviceRows || []) {
      if (!serviceByMidi[s.midi_id]) serviceByMidi[s.midi_id] = [];
      if (regionsById[s.region_id]) serviceByMidi[s.midi_id].push(regionsById[s.region_id]);
    }

    const midiBrandsRes = await sb("/rest/v1/clicka_midi_brands?select=*");
    const midiBrandRows = await midiBrandsRes.json();
    const brandsByMidi = {};
    for (const b of midiBrandRows || []) {
      if (!brandsByMidi[b.midi_id]) brandsByMidi[b.midi_id] = [];
      if (brandsById[b.brand_id]) brandsByMidi[b.midi_id].push(brandsById[b.brand_id]);
    }

    const enriched = (midis || []).map((m) => ({
      ...m,
      home_region: regionsById[m.home_region_id] || null,
      service_regions: serviceByMidi[m.id] || [],
      brands: m.services_all_brands ? "All" : (brandsByMidi[m.id] || []).map((b) => b.name),
    }));

    return json(200, { ok: true, midis: enriched });
  }

  if (event.httpMethod === "POST") {
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { ok: false, error: "Invalid JSON body." }); }
    if (!body.name || !String(body.name).trim()) return json(400, { ok: false, error: "Name is required." });

    const insertRes = await sb("/rest/v1/clicka_midis", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify([{
        name: String(body.name).trim(),
        home_region_id: body.home_region_id || null,
        services_all_brands: body.services_all_brands !== false,
      }]),
    });
    const rows = await insertRes.json();
    if (!insertRes.ok) return json(200, { ok: false, error: JSON.stringify(rows).slice(0, 300) });
    const midi = rows[0];

    const serviceIds = Array.isArray(body.service_region_ids) ? body.service_region_ids.filter(Boolean) : [];
    if (serviceIds.length) {
      await sb("/rest/v1/clicka_midi_service_regions", {
        method: "POST",
        body: JSON.stringify(serviceIds.map((region_id) => ({ midi_id: midi.id, region_id }))),
      });
    }

    if (body.services_all_brands === false) {
      const brandIds = Array.isArray(body.brand_ids) ? body.brand_ids.filter(Boolean) : [];
      if (brandIds.length) {
        await sb("/rest/v1/clicka_midi_brands", {
          method: "POST",
          body: JSON.stringify(brandIds.map((brand_id) => ({ midi_id: midi.id, brand_id }))),
        });
      }
    }

    return json(200, { ok: true, midi });
  }

  return json(405, { ok: false, error: "Method not allowed." });
};
