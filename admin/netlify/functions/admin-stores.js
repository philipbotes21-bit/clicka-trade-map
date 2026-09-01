// admin/netlify/functions/admin-stores.js
//
// FUNCTION — Clicka Admin: Stores lookup.
// Reads clicka_registrations — the exact table clicka-save.js (the spaza
// onboarding app) writes to. Anything an agent captures in the field shows
// up here immediately, no separate sync step.
//
// GET  (no id)  -> paged/filterable list of stores (core columns only).
// GET  ?id=...  -> full detail for one store, including short-lived signed
//                  URLs for every photo on file (the storage bucket is
//                  private, so raw paths alone aren't viewable).
//
// Visible to Admin, Supervisor, and Regional Manager (see everything, scoped
// to their province(s)), Agent (their own captured stores), Self Order
// Manager (their own store only), and PPM Agent (scoped to whichever
// sub-region(s) their assigned Midi(s) actually service — the area they can
// realistically order into; the actual authorization check still happens in
// admin-orders.js at order time, this is just what the app shows them).

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

  // Agents only ever see what THEY captured — matched via staff_id, which
  // the onboarding app's login now sets server-side (not a typed name).
  // Supervisors and Regional Managers see everything within their assigned
  // province(s). Admins see everything.
  const isAgent = caller.staff.role === "agent";
  const isSelfOrderManager = caller.staff.role === "self_order_manager";
  // PPM Agent isn't scoped to a province/region directly — they're scoped
  // to a Midi, so their visibility follows wherever that Midi delivers.
  const isPpmAgent = caller.staff.role === "ppm_agent";

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
    if (isAgent && store.staff_id !== caller.staff.id) {
      return json(403, { ok: false, error: "This store wasn't captured by your account." });
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
  params.set("select", LIST_COLUMNS);
  params.set("order", "created_at.desc");
  params.set("limit", "200");

  const filters = [];
  if (qs.search) {
    const term = qs.search.replace(/[,()]/g, "");
    filters.push("or=(trading_name.ilike.*" + term + "*,owner_full_name.ilike.*" + term + "*)");
  }
  if (qs.province) filters.push("province=eq." + encodeURIComponent(qs.province));
  if (qs.region_id) filters.push("region_id=eq." + encodeURIComponent(qs.region_id));
  if (qs.business_type) filters.push("business_type=eq." + encodeURIComponent(qs.business_type));
  if (qs.status) filters.push("status=eq." + encodeURIComponent(qs.status));

  if (allowedProvinces) {
    filters.push("province=in.(" + allowedProvinces.map((p) => "\"" + p + "\"").join(",") + ")");
  }
  if (allowedRegionIds) {
    filters.push("region_id=in.(" + allowedRegionIds.join(",") + ")");
  }
  if (isAgent) {
    filters.push("staff_id=eq." + caller.staff.id);
  }

  let url = "/rest/v1/clicka_registrations?" + params.toString();
  if (filters.length) url += "&" + filters.join("&");

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
