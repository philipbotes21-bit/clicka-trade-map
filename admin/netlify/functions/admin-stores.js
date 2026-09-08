// admin/netlify/functions/admin-stores.js
//
// FUNCTION — Clicka Admin: Stores lookup.
// Reads clicka_registrations — the exact table clicka-save.js (the spaza
// onboarding app) writes to. Anything an agent captures in the field shows
// up here immediately, no separate sync step.
//
// GET   (no id)  -> paged/filterable list of stores (core columns only).
// GET   ?id=...  -> full detail for one store, including short-lived signed
//                   URLs for every photo on file (the storage bucket is
//                   private, so raw paths alone aren't viewable).
// PATCH ?id=...  -> edit an existing store's core details. Who can:
//                   Admin (any store); Agent (a store THEY captured, or any
//                   store in a sub-region assigned to them); Supervisor /
//                   Regional Manager (any store in a province within their
//                   scope). Same field validation as the initial capture
//                   (owner name needs a surname; opting into MIDI ordering
//                   needs a preferred Midi chosen). Never touches photos or
//                   GPS — this is for correcting/updating the record, not
//                   redoing the on-site capture.
// PATCH (no id)  -> bulk store-to-agent (re)assignment.
//                   body: { store_ids: [...], staff_id: <agent id> | null }
//                   Admin / Supervisor / Regional Manager only. Sets who
//                   "owns" every listed store — their pool for ordering,
//                   field routes, and take-up reporting all follow this.
// GET   ?export=1  -> every store matching the current filters, unpaginated,
//                     with a broader column set — the source for the
//                     Export to Excel button. Same scoping as the normal
//                     list. Never touches staff_id/agent assignment — that's
//                     informational only here (dedicated tools own that).
// POST  ?action=transfer_agent -> body: { from_staff_id, to_staff_id }.
//                   Moves EVERY store currently assigned to from_staff_id
//                   over to to_staff_id in one call — for when an Agent
//                   leaves the business. Admin / Regional Manager only.
// POST  (no id)  -> bulk import (create-or-update) from the Excel template.
//                   body: { rows: [{ row_number, id?, trading_name,
//                     owner_full_name?, owner_nationality?, contact_number?,
//                     alt_contact_number?, email?, province, region?,
//                     outlet_address?, postal_code?, business_type?,
//                     status?, gps_lat?, gps_lng? }] }, max 200 rows/call.
//                   Admin / Supervisor / Regional Manager only. A row WITH
//                   an id updates that store (only the fields provided,
//                   scope-checked against its current province); a row
//                   WITHOUT an id creates a new store (status defaults to
//                   COLLECTION — imported stores skip the photo-capture
//                   wizard, same as a Quick-add Collection Client — and a
//                   same-name-same-province-and-contact match is skipped as
//                   a likely duplicate rather than created twice). Never
//                   sets staff_id — Agent assignment stays on the dedicated
//                   Assign Routes / on-the-go tools, not the import.
//
// Visible to Admin, Supervisor, and Regional Manager (see everything, scoped
// to their province(s)), Agent (stores they captured, plus any store in a
// sub-region assigned to them), Self Order Manager (their own store only),
// and PPM Agent (scoped to whichever sub-region(s) their assigned Midi(s)
// actually service — the area they can realistically order into; the actual
// authorization check still happens in admin-orders.js at order time, this
// is just what the app shows them).

const { SUPABASE_URL, json, sb, getCaller } = require("./_auth");

const PHOTO_FIELDS = [
  "storefront_photo_url",
  "culinary_photo_url",
  "grains_photo_url",
  "snacks_beverages_photo_url",
  "household_care_photo_url",
  // legacy fields — still shown if an older record happens to have them
  "owner_id_photo_url",
  "proof_of_address_url",
  "cipc_doc_url",
  "vas_devices_photo_url",
];

const LIST_COLUMNS =
  "id,created_at,captured_by,trading_name,owner_full_name,contact_number,province,region_id,outlet_address,business_type,status,has_vas_device,wallet_type,wallet_code,wants_midi_ordering,preferred_midi_id";

async function resolveScopeProvinces(scope) {
  const direct = scope.filter((s) => s.scope_type === "province").map((s) => s.province);
  const regionIds = scope.filter((s) => s.scope_type === "region").map((s) => s.region_id);
  if (!regionIds.length) return [...new Set(direct)];

  const res = await sb("/rest/v1/bi_regions?id=in.(" + regionIds.join(",") + ")&select=id,province");
  const rows = await res.json();
  const fromRegions = Array.isArray(rows) ? rows.map((r) => r.province) : [];
  return [...new Set([...direct, ...fromRegions])].filter(Boolean);
}

// Sub-regions a PPM Agent's assigned Midi(s) actually service — same logic
// admin-orders.js uses to authorize placing an order, reused here so the
// Stores list only ever shows them stores they can realistically order for.
async function myMidiServiceRegionIds(caller) {
  const midiIds = (caller.scope || []).filter((s) => s.scope_type === "midi").map((s) => s.midi_id);
  if (!midiIds.length) return [];
  const res = await sb("/rest/v1/clicka_midi_service_regions?midi_id=in.(" + midiIds.join(",") + ")&select=region_id");
  const rows = await res.json();
  return [...new Set((Array.isArray(rows) ? rows : []).map((r) => r.region_id).filter(Boolean))];
}

async function signPhoto(path) {
  if (!path) return null;
  const res = await sb("/storage/v1/object/sign/clicka-uploads/" + path, {
    method: "POST",
    body: JSON.stringify({ expiresIn: 3600 }),
  });
  if (!res.ok) return null;
  const body = await res.json();
  if (!body.signedURL) return null;
  return SUPABASE_URL + "/storage/v1" + body.signedURL;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

  const qs = event.queryStringParameters || {};
  if (qs.selftest === "1") return json(200, { ok: true, world: "CLICKA-ADMIN" });

  const caller = await getCaller(event);
  if (!caller || !caller.staff) return json(401, { ok: false, error: "Not signed in." });
  if (caller.staff.status === "inactive") return json(403, { ok: false, error: "Account deactivated." });
  if (!["admin", "supervisor", "regional_manager", "agent", "self_order_manager", "ppm_agent"].includes(caller.staff.role)) {
    return json(403, { ok: false, error: "Stores access is limited to Admin, Supervisor, Regional Manager, Agent, PPM Agent, and Self Order Manager roles." });
  }

  // ---------- POST ?action=transfer_agent: move every store from an
  // outgoing Agent to a new one in one go — for when someone leaves the
  // business. Admin / Regional Manager only (deliberately narrower than
  // the map/list assignment tools, which Supervisor also has). ----------
  if (event.httpMethod === "POST" && qs.action === "transfer_agent") {
    if (!["admin", "regional_manager"].includes(caller.staff.role)) {
      return json(403, { ok: false, error: "Transferring an Agent's stores is limited to Admin and Regional Manager." });
    }
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { ok: false, error: "Invalid JSON body." }); }
    const { from_staff_id, to_staff_id } = body;
    if (!from_staff_id || !to_staff_id) return json(400, { ok: false, error: "from_staff_id and to_staff_id are required." });
    if (from_staff_id === to_staff_id) return json(400, { ok: false, error: "Pick two different Agents." });

    const toRes = await sb("/rest/v1/clicka_staff?id=eq." + to_staff_id + "&role=eq.agent&select=id,first_name,last_name,status");
    const toRows = await toRes.json();
    const toAgent = Array.isArray(toRows) ? toRows[0] : null;
    if (!toAgent) return json(400, { ok: false, error: "The new Agent account wasn't found." });
    if (toAgent.status === "inactive") return json(400, { ok: false, error: "That Agent account is deactivated." });

    const fromRes = await sb("/rest/v1/clicka_staff?id=eq." + from_staff_id + "&select=id,first_name,last_name");
    const fromRows = await fromRes.json();
    const fromAgent = Array.isArray(fromRows) ? fromRows[0] : null;
    if (!fromAgent) return json(400, { ok: false, error: "The outgoing Agent account wasn't found." });

    let url = "/rest/v1/clicka_registrations?staff_id=eq." + from_staff_id + "&merged_into_id=is.null";
    if (caller.staff.role === "regional_manager") {
      const myProvinces = await resolveScopeProvinces(caller.scope || []);
      if (!myProvinces.length) return json(200, { ok: true, transferred: 0, note: "No province assigned to your account." });
      url += "&province=in.(" + myProvinces.map((p) => "\"" + p + "\"").join(",") + ")";
    }

    const patchRes = await sb(url, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ staff_id: to_staff_id }),
    });
    const patchBody = await patchRes.text();
    if (!patchRes.ok) return json(200, { ok: false, error: patchBody.slice(0, 300) });
    let rows = [];
    try { rows = JSON.parse(patchBody); } catch (_) {}
    return json(200, {
      ok: true,
      transferred: Array.isArray(rows) ? rows.length : 0,
      from_name: fromAgent.first_name + " " + fromAgent.last_name,
      to_name: toAgent.first_name + " " + toAgent.last_name,
    });
  }

  // ---------- POST: bulk import (create-or-update) ----------
  if (event.httpMethod === "POST" && !qs.id) {
    if (!["admin", "supervisor", "regional_manager"].includes(caller.staff.role)) {
      return json(403, { ok: false, error: "Importing stores is limited to Admin, Supervisor, and Regional Manager." });
    }
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { ok: false, error: "Invalid JSON body." }); }
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) return json(400, { ok: false, error: "No rows to import." });
    if (rows.length > 200) return json(400, { ok: false, error: "Send at most 200 rows per request — split larger files into chunks." });

    const VALID_PROVINCES = ["Gauteng", "Western Cape", "KwaZulu-Natal", "Eastern Cape", "Limpopo", "Mpumalanga", "North West", "Free State", "Northern Cape"];
    const VALID_STATUSES = ["MIDI_ACTIVATED", "COLLECTION", "CAPTURED", "DECLINED"];

    let allowedProvinces = null;
    if (caller.staff.role !== "admin") {
      allowedProvinces = await resolveScopeProvinces(caller.scope || []);
    }

    const regionsRes = await sb("/rest/v1/bi_regions?select=id,name,province");
    const regionRows = await regionsRes.json();
    const regionByKey = {}; // "region name|province" (lowercased) -> region id
    (Array.isArray(regionRows) ? regionRows : []).forEach((r) => {
      regionByKey[(r.name + "|" + r.province).toLowerCase()] = r.id;
    });

    // One snapshot covers both id-match (update) and duplicate detection
    // (create) — far cheaper than a query per row for a few-hundred-row file.
    const existingRes = await sb("/rest/v1/clicka_registrations?merged_into_id=is.null&select=id,trading_name,contact_number,province");
    const existingRows = await existingRes.json();
    const existingById = {};
    const existingByDupeKey = {}; // "province|trading name" (lowercased) -> [{contact_number}]
    (Array.isArray(existingRows) ? existingRows : []).forEach((s) => {
      existingById[s.id] = s;
      const key = s.province + "|" + (s.trading_name || "").trim().toLowerCase();
      (existingByDupeKey[key] = existingByDupeKey[key] || []).push({ contact_number: s.contact_number || null });
    });

    const capturedByName = caller.staff.first_name + " " + caller.staff.last_name;
    const results = [];
    const toCreate = [];
    const toUpdate = [];

    rows.forEach((row) => {
      const rowNum = row.row_number || (results.length + toCreate.length + toUpdate.length + 1);
      const tradingName = String(row.trading_name || "").trim();
      const province = String(row.province || "").trim();

      if (row.id) {
        const existing = existingById[row.id];
        if (!existing) { results.push({ row_number: rowNum, trading_name: tradingName, status: "error", message: "Store id not found — leave ID blank to create a new store." }); return; }
        if (allowedProvinces && !allowedProvinces.includes(existing.province)) { results.push({ row_number: rowNum, trading_name: tradingName, status: "error", message: "Outside your assigned province — can't edit this store." }); return; }

        const patch = {};
        if (tradingName) patch.trading_name = tradingName;
        if (row.owner_full_name != null && String(row.owner_full_name).trim()) patch.owner_full_name = String(row.owner_full_name).trim();
        if (row.owner_nationality != null && String(row.owner_nationality).trim()) patch.owner_nationality = String(row.owner_nationality).trim();
        if (row.contact_number != null && String(row.contact_number).trim()) patch.contact_number = String(row.contact_number).trim();
        if (row.alt_contact_number != null && String(row.alt_contact_number).trim()) patch.alt_contact_number = String(row.alt_contact_number).trim();
        if (row.email != null && String(row.email).trim()) patch.email = String(row.email).trim();
        if (province) {
          if (!VALID_PROVINCES.includes(province)) { results.push({ row_number: rowNum, trading_name: tradingName, status: "error", message: "Unrecognized province: \"" + province + "\"." }); return; }
          if (allowedProvinces && !allowedProvinces.includes(province)) { results.push({ row_number: rowNum, trading_name: tradingName, status: "error", message: "Can't move a store to a province outside your assignment." }); return; }
          patch.province = province;
        }
        if (row.region != null && String(row.region).trim()) {
          const regionId = regionByKey[(String(row.region).trim() + "|" + (province || existing.province)).toLowerCase()];
          if (regionId) patch.region_id = regionId;
        }
        if (row.outlet_address != null && String(row.outlet_address).trim()) patch.outlet_address = String(row.outlet_address).trim();
        if (row.postal_code != null && String(row.postal_code).trim()) patch.postal_code = String(row.postal_code).trim();
        if (row.business_type != null && String(row.business_type).trim()) patch.business_type = String(row.business_type).trim();
        if (row.status != null && String(row.status).trim()) {
          const st = String(row.status).trim().toUpperCase();
          if (!VALID_STATUSES.includes(st)) { results.push({ row_number: rowNum, trading_name: tradingName, status: "error", message: "Unrecognized status: \"" + row.status + "\"." }); return; }
          patch.status = st;
        }
        if (row.gps_lat != null && row.gps_lat !== "") patch.gps_lat = Number(row.gps_lat);
        if (row.gps_lng != null && row.gps_lng !== "") patch.gps_lng = Number(row.gps_lng);

        if (!Object.keys(patch).length) { results.push({ row_number: rowNum, trading_name: tradingName, status: "skipped", message: "Nothing to update." }); return; }
        toUpdate.push({ rowNum, id: row.id, tradingName, patch });
        return;
      }

      // ---- create ----
      if (!tradingName) { results.push({ row_number: rowNum, trading_name: "", status: "error", message: "Trading name is required." }); return; }
      if (!province || !VALID_PROVINCES.includes(province)) { results.push({ row_number: rowNum, trading_name: tradingName, status: "error", message: province ? "Unrecognized province: \"" + province + "\"." : "Province is required." }); return; }
      if (allowedProvinces && !allowedProvinces.includes(province)) { results.push({ row_number: rowNum, trading_name: tradingName, status: "error", message: "Outside your assigned province." }); return; }

      const contactNumber = String(row.contact_number || "").trim();
      const dupeKey = province + "|" + tradingName.toLowerCase();
      const possibleDupes = existingByDupeKey[dupeKey] || [];
      const isDupe = possibleDupes.some((s) => !contactNumber || !s.contact_number || s.contact_number === contactNumber);
      if (isDupe) { results.push({ row_number: rowNum, trading_name: tradingName, status: "skipped", message: "A store with this name already exists in " + province + " — skipped to avoid a duplicate." }); return; }

      let statusVal = "COLLECTION";
      if (row.status != null && String(row.status).trim()) {
        const st = String(row.status).trim().toUpperCase();
        if (!VALID_STATUSES.includes(st)) { results.push({ row_number: rowNum, trading_name: tradingName, status: "error", message: "Unrecognized status: \"" + row.status + "\"." }); return; }
        statusVal = st;
      }

      let regionId = null;
      if (row.region != null && String(row.region).trim()) {
        regionId = regionByKey[(String(row.region).trim() + "|" + province).toLowerCase()] || null;
      }

      const payload = {
        trading_name: tradingName,
        owner_full_name: row.owner_full_name ? String(row.owner_full_name).trim() : null,
        owner_nationality: row.owner_nationality ? String(row.owner_nationality).trim() : null,
        contact_number: contactNumber || null,
        alt_contact_number: row.alt_contact_number ? String(row.alt_contact_number).trim() : null,
        email: row.email ? String(row.email).trim() : null,
        province,
        region_id: regionId,
        outlet_address: row.outlet_address ? String(row.outlet_address).trim() : null,
        postal_code: row.postal_code ? String(row.postal_code).trim() : null,
        business_type: row.business_type ? String(row.business_type).trim() : null,
        status: statusVal,
        gps_lat: (row.gps_lat != null && row.gps_lat !== "") ? Number(row.gps_lat) : null,
        gps_lng: (row.gps_lng != null && row.gps_lng !== "") ? Number(row.gps_lng) : null,
        captured_by: capturedByName,
        wants_midi_ordering: false,
      };
      toCreate.push({ rowNum, tradingName, payload });
      // Reserve this name/contact against later rows in the SAME file so
      // two identical rows in one sheet don't both get created.
      (existingByDupeKey[dupeKey] = existingByDupeKey[dupeKey] || []).push({ contact_number: contactNumber || null });
    });

    if (toCreate.length) {
      const insertRes = await sb("/rest/v1/clicka_registrations", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(toCreate.map((c) => c.payload)),
      });
      const insertBody = await insertRes.text();
      if (insertRes.ok) {
        let inserted = [];
        try { inserted = JSON.parse(insertBody); } catch (_) {}
        toCreate.forEach((c, i) => {
          results.push({ row_number: c.rowNum, trading_name: c.tradingName, status: "created", id: inserted[i] ? inserted[i].id : null });
        });
      } else {
        toCreate.forEach((c) => {
          results.push({ row_number: c.rowNum, trading_name: c.tradingName, status: "error", message: "Couldn't create: " + insertBody.slice(0, 200) });
        });
      }
    }

    for (const u of toUpdate) {
      const patchRes = await sb("/rest/v1/clicka_registrations?id=eq." + u.id, {
        method: "PATCH",
        body: JSON.stringify(u.patch),
      });
      if (patchRes.ok) {
        results.push({ row_number: u.rowNum, trading_name: u.tradingName, status: "updated", id: u.id });
      } else {
        const t = await patchRes.text();
        results.push({ row_number: u.rowNum, trading_name: u.tradingName, status: "error", message: "Couldn't update: " + t.slice(0, 200) });
      }
    }

    results.sort((a, b) => a.row_number - b.row_number);
    const summary = {
      total: results.length,
      created: results.filter((r) => r.status === "created").length,
      updated: results.filter((r) => r.status === "updated").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      errors: results.filter((r) => r.status === "error").length,
    };
    return json(200, { ok: true, summary, results });
  }

  // ---------- PATCH: edit an existing store ----------
  // Handled fully separately from the GET list/detail logic below (which is
  // shaped around scoping a search/list, not authorizing a single write) —
  // self-contained so it isn't accidentally caught by an early-return meant
  // for an empty GET list.
  if (event.httpMethod === "PATCH" && !qs.id) {
    // ---- bulk store-to-agent (re)assignment ----
    // body: { store_ids: [...], staff_id: <agent id> | null }
    // The "assign a cluster of nearby stores to an agent" tool — from the
    // map view in Clicka Admin, or the on-the-go list in Spaza Onboard.
    // Admin unrestricted; Supervisor/Regional Manager limited to stores
    // within their assigned province(s). Setting staff_id sets who "owns"
    // these stores everywhere else in the app (their pool for ordering,
    // routing, and take-up reporting all follow this field).
    if (!["admin", "supervisor", "regional_manager"].includes(caller.staff.role)) {
      return json(403, { ok: false, error: "Assigning stores to an Agent is limited to Admin, Supervisor, and Regional Manager." });
    }
    let bulkBody;
    try { bulkBody = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { ok: false, error: "Invalid JSON body." }); }

    const storeIds = Array.isArray(bulkBody.store_ids) ? bulkBody.store_ids.filter(Boolean) : [];
    if (!storeIds.length) return json(400, { ok: false, error: "store_ids must be a non-empty array." });
    const newStaffId = bulkBody.staff_id || null;

    if (newStaffId) {
      const agentRes = await sb("/rest/v1/clicka_staff?id=eq." + newStaffId + "&role=eq.agent&select=id,status");
      const agentRows = await agentRes.json();
      const agent = Array.isArray(agentRows) ? agentRows[0] : null;
      if (!agent) return json(400, { ok: false, error: "That agent account wasn't found." });
      if (agent.status === "inactive") return json(400, { ok: false, error: "That agent account is deactivated." });
    }

    const targetRes = await sb("/rest/v1/clicka_registrations?id=in.(" + storeIds.join(",") + ")&select=id,province");
    const targetRows = await targetRes.json();
    const targets = Array.isArray(targetRows) ? targetRows : [];
    if (targets.length !== storeIds.length) {
      return json(400, { ok: false, error: "One or more stores weren't found." });
    }
    if (["supervisor", "regional_manager"].includes(caller.staff.role)) {
      const myProvinces = await resolveScopeProvinces(caller.scope || []);
      const outside = targets.filter((s) => !myProvinces.includes(s.province));
      if (outside.length) {
        return json(403, { ok: false, error: outside.length + " of these stores are outside your assigned region." });
      }
    }

    const bulkPatchRes = await sb("/rest/v1/clicka_registrations?id=in.(" + storeIds.join(",") + ")", {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ staff_id: newStaffId }),
    });
    const bulkPatchRows = await bulkPatchRes.json();
    if (!bulkPatchRes.ok) return json(200, { ok: false, error: JSON.stringify(bulkPatchRows).slice(0, 300) });
    return json(200, { ok: true, updated: Array.isArray(bulkPatchRows) ? bulkPatchRows.length : storeIds.length });
  }

  if (event.httpMethod === "PATCH") {
    if (!qs.id) return json(400, { ok: false, error: "id is required." });
    if (!["admin", "supervisor", "regional_manager", "agent"].includes(caller.staff.role)) {
      return json(403, { ok: false, error: "Editing a store is limited to Admin, Supervisor, Regional Manager, and Agent roles." });
    }

    const storeRes = await sb("/rest/v1/clicka_registrations?id=eq." + encodeURIComponent(qs.id) + "&select=*");
    const storeRows = await storeRes.json();
    const store = Array.isArray(storeRows) ? storeRows[0] : null;
    if (!store) return json(404, { ok: false, error: "Store not found." });

    let canEdit = caller.staff.role === "admin";
    if (!canEdit && caller.staff.role === "agent") {
      const myRegionIds = (caller.scope || []).filter((s) => s.scope_type === "region").map((s) => s.region_id);
      canEdit = store.staff_id === caller.staff.id || (store.region_id && myRegionIds.includes(store.region_id));
    }
    if (!canEdit && ["supervisor", "regional_manager"].includes(caller.staff.role)) {
      const myProvinces = await resolveScopeProvinces(caller.scope || []);
      canEdit = myProvinces.includes(store.province);
    }
    if (!canEdit) {
      return json(403, { ok: false, error: "You don't have permission to edit this store." });
    }

    let body;
    try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { ok: false, error: "Invalid JSON body." }); }

    // Core details only — never photos or GPS here, this is for correcting
    // or updating the record, not redoing the on-site capture.
    const EDITABLE_FIELDS = [
      "owner_full_name", "owner_nationality", "contact_number", "alt_contact_number", "email",
      "trading_name", "business_type", "outlet_address", "province", "region_id", "postal_code",
      "has_vas_device", "wallet_type", "wallet_code", "current_pos_system",
      "wants_midi_ordering", "preferred_midi_id",
    ];
    const patch = {};
    for (const f of EDITABLE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(body, f)) patch[f] = body[f];
    }
    if (!Object.keys(patch).length) return json(400, { ok: false, error: "No editable fields supplied." });

    if (Object.prototype.hasOwnProperty.call(patch, "owner_full_name")) {
      if (!patch.owner_full_name || String(patch.owner_full_name).trim().split(/\s+/).length < 2) {
        return json(400, { ok: false, error: "Owner full name must include name AND surname." });
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, "trading_name") && !String(patch.trading_name || "").trim()) {
      return json(400, { ok: false, error: "Business name is required." });
    }

    // Same auto-validation rule as the initial capture: opting into MIDI
    // ordering requires a preferred Midi, and status follows that choice.
    // Only ever flips between CAPTURED and MIDI_ACTIVATED — a Collection
    // Client or Declined record has its own lifecycle and isn't silently
    // reassigned by an edit here.
    if (Object.prototype.hasOwnProperty.call(patch, "wants_midi_ordering") && ["CAPTURED", "MIDI_ACTIVATED"].includes(store.status)) {
      const nextPreferredMidi = Object.prototype.hasOwnProperty.call(patch, "preferred_midi_id") ? patch.preferred_midi_id : store.preferred_midi_id;
      if (patch.wants_midi_ordering === true && !nextPreferredMidi) {
        return json(400, { ok: false, error: "Choose which Midi / Wholesaler this store will buy from." });
      }
      patch.status = patch.wants_midi_ordering === true ? "MIDI_ACTIVATED" : "CAPTURED";
      if (patch.wants_midi_ordering !== true) patch.preferred_midi_id = null;
    }

    const patchRes = await sb("/rest/v1/clicka_registrations?id=eq." + encodeURIComponent(qs.id), {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(patch),
    });
    const patchBody = await patchRes.text();
    if (!patchRes.ok) return json(200, { ok: false, error: patchBody.slice(0, 400) });
    let updated = null;
    try { updated = JSON.parse(patchBody)[0]; } catch (_) {}
    return json(200, { ok: true, store: updated });
  }

  // A Self Order Manager is the shop owner logged in to self-order — they
  // can only ever fetch their own store's detail (their "store" scope row),
  // never the list, never anyone else's.
  if (caller.staff.role === "self_order_manager") {
    const storeScope = (caller.scope || []).find((s) => s.scope_type === "store");
    if (!storeScope || !storeScope.store_id) {
      return json(200, { ok: true, stores: [], total: 0, note: "No store linked to this account yet — ask an Admin to link one." });
    }
    if (!qs.id) qs.id = storeScope.store_id;
    if (qs.id !== storeScope.store_id) {
      return json(403, { ok: false, error: "This account can only access its own store." });
    }
  }

  // Agents see what THEY captured (matched via staff_id, which the
  // onboarding app's login now sets server-side, not a typed name) PLUS any
  // store in a sub-region assigned to them (scope_type "region") — the same
  // sub-regions that already govern their order-placement authorization in
  // admin-orders.js, so "captured by me" and "assigned to me" cover the same
  // ground as "my store" everywhere else in the app. Supervisors and
  // Regional Managers see everything within their assigned province(s).
  // Admins see everything.
  const isAgent = caller.staff.role === "agent";
  const isSelfOrderManager = caller.staff.role === "self_order_manager";
  // PPM Agent isn't scoped to a province/region directly — they're scoped
  // to a Midi, so their visibility follows wherever that Midi delivers.
  const isPpmAgent = caller.staff.role === "ppm_agent";
  const agentRegionIds = isAgent ? (caller.scope || []).filter((s) => s.scope_type === "region").map((s) => s.region_id) : [];

  let allowedProvinces = null; // null = unrestricted (admin, self_order_manager — locked to their own store_id above)
  let allowedRegionIds = null; // null = not applicable (only set for PPM Agent)
  if (isPpmAgent) {
    allowedRegionIds = await myMidiServiceRegionIds(caller);
    if (!allowedRegionIds.length) {
      return json(200, { ok: true, stores: [], total: 0, note: "No Midi / Wholesaler assigned to this account yet — ask an Admin to assign one." });
    }
  } else if (!isAgent && !isSelfOrderManager && caller.staff.role !== "admin") {
    allowedProvinces = await resolveScopeProvinces(caller.scope);
    if (!allowedProvinces.length) {
      return json(200, { ok: true, stores: [], total: 0, note: "No region assigned to this account yet — ask an Admin to assign one." });
    }
  }

  // ---------- Detail view ----------
  if (qs.id) {
    let path = "/rest/v1/clicka_registrations?id=eq." + encodeURIComponent(qs.id) + "&select=*";
    const res = await sb(path);
    const rows = await res.json();
    const store = Array.isArray(rows) ? rows[0] : null;
    if (!store) return json(404, { ok: false, error: "Store not found." });
    if (allowedProvinces && !allowedProvinces.includes(store.province)) {
      return json(403, { ok: false, error: "This store is outside your assigned region." });
    }
    if (allowedRegionIds && (!store.region_id || !allowedRegionIds.includes(store.region_id))) {
      return json(403, { ok: false, error: "This store is outside the area your Midi(s) service." });
    }
    if (isAgent && store.staff_id !== caller.staff.id && !(store.region_id && agentRegionIds.includes(store.region_id))) {
      return json(403, { ok: false, error: "This store wasn't captured by your account, and isn't in a sub-region assigned to you." });
    }

    const photos = {};
    for (const field of PHOTO_FIELDS) {
      if (store[field]) {
        const url = await signPhoto(store[field]);
        if (url) photos[field] = url;
      }
    }
    return json(200, { ok: true, store, photos });
  }

  // ---------- List view ----------
  const params = new URLSearchParams();
  // ?map=1 -> lean payload, every store with a GPS pin, no pagination cap —
  // for the map-based bulk assignment tool, which needs the whole picture
  // at once rather than a page at a time. Same role-based scoping as the
  // normal list, just a different column set/limit.
  const isMapView = qs.map === "1";
  // ?export=1 -> every store matching the current filters, unpaginated,
  // with the broader column set the Excel export/re-import round-trip
  // needs (owner detail, contact info, GPS) — LIST_COLUMNS is deliberately
  // lean for the on-screen table and doesn't carry all of that.
  const isExport = qs.export === "1";
  const EXPORT_COLUMNS = "id,created_at,captured_by,staff_id,trading_name,owner_full_name,owner_nationality,contact_number,alt_contact_number,email,province,region_id,outlet_address,postal_code,business_type,status,gps_lat,gps_lng";
  params.set("select", isMapView ? "id,trading_name,staff_id,region_id,province,status,gps_lat,gps_lng" : (isExport ? EXPORT_COLUMNS : LIST_COLUMNS));
  params.set("order", "created_at.desc");
  params.set("limit", isMapView ? "5000" : (isExport ? "10000" : "200"));
  if (isMapView) params.set("gps_lat", "not.is.null");

  // Every condition below is built in PostgREST's dot-notation (col.op.val)
  // so they can all be nested inside one top-level and=(...) — search's
  // or(...) and the Agent visibility or(...) both need to combine with
  // everything else via AND, and PostgREST only reliably ANDs multiple
  // logical groups when they're explicitly nested like this (two bare
  // top-level or= params is not something to rely on).
  const andParts = [];
  // A merged-away duplicate is retired, not deleted — it never shows up in
  // the list, map, or export, only reachable by anyone who already knows
  // its id (e.g. auditing a merge).
  andParts.push("merged_into_id.is.null");
  if (qs.search) {
    const term = qs.search.replace(/[,()]/g, "");
    andParts.push("or(trading_name.ilike.*" + term + "*,owner_full_name.ilike.*" + term + "*)");
  }
  if (qs.province) andParts.push("province.eq." + encodeURIComponent(qs.province));
  if (qs.region_id) andParts.push("region_id.eq." + encodeURIComponent(qs.region_id));
  if (qs.business_type) andParts.push("business_type.eq." + encodeURIComponent(qs.business_type));
  if (qs.status) andParts.push("status.eq." + encodeURIComponent(qs.status));

  if (allowedProvinces) {
    andParts.push("province.in.(" + allowedProvinces.map((p) => "\"" + p + "\"").join(",") + ")");
  }
  if (allowedRegionIds) {
    andParts.push("region_id.in.(" + allowedRegionIds.join(",") + ")");
  }
  if (isAgent) {
    andParts.push(
      agentRegionIds.length
        ? "or(staff_id.eq." + caller.staff.id + ",region_id.in.(" + agentRegionIds.join(",") + "))"
        : "staff_id.eq." + caller.staff.id
    );
  }

  let url = "/rest/v1/clicka_registrations?" + params.toString();
  if (andParts.length) url += "&and=(" + andParts.join(",") + ")";

  const res = await sb(url, { headers: { Prefer: "count=exact" } });
  const stores = await res.json();
  const contentRange = res.headers.get("content-range");
  const total = contentRange ? Number(contentRange.split("/")[1]) : (stores || []).length;

  const regionIds = [...new Set((stores || []).map((s) => s.region_id).filter(Boolean))];
  let regionsById = {};
  if (regionIds.length) {
    const rres = await sb("/rest/v1/bi_regions?id=in.(" + regionIds.join(",") + ")&select=id,name,province");
    const rrows = await rres.json();
    regionsById = Object.fromEntries((rrows || []).map((r) => [r.id, r]));
  }
  let agentsById = {};
  if (isExport) {
    const staffIds = [...new Set((stores || []).map((s) => s.staff_id).filter(Boolean))];
    if (staffIds.length) {
      const ares = await sb("/rest/v1/clicka_staff?id=in.(" + staffIds.join(",") + ")&select=id,first_name,last_name");
      const arows = await ares.json();
      agentsById = Object.fromEntries((arows || []).map((a) => [a.id, a.first_name + " " + a.last_name]));
    }
  }

  const enrichedStores = (stores || []).map((s) => ({
    ...s,
    region_name: s.region_id && regionsById[s.region_id] ? regionsById[s.region_id].name : null,
    ...(isExport ? { agent_name: s.staff_id ? (agentsById[s.staff_id] || null) : null } : {}),
  }));

  return json(200, { ok: true, stores: enrichedStores, total });
};
