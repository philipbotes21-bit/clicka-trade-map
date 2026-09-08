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
  params.set("select", isMapView ? "id,trading_name,staff_id,region_id,province,status,gps_lat,gps_lng" : LIST_COLUMNS);
  params.set("order", "created_at.desc");
  params.set("limit", isMapView ? "5000" : "200");
  if (isMapView) params.set("gps_lat", "not.is.null");

  // Every condition below is built in PostgREST's dot-notation (col.op.val)
  // so they can all be nested inside one top-level and=(...) — search's
  // or(...) and the Agent visibility or(...) both need to combine with
  // everything else via AND, and PostgREST only reliably ANDs multiple
  // logical groups when they're explicitly nested like this (two bare
  // top-level or= params is not something to rely on).
  const andParts = [];
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
  const enrichedStores = (stores || []).map((s) => ({
    ...s,
    region_name: s.region_id && regionsById[s.region_id] ? regionsById[s.region_id].name : null,
  }));

  return json(200, { ok: true, stores: enrichedStores, total });
};
