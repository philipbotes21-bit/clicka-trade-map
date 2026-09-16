// netlify/functions/bi-onboarding.js
//
// FUNCTION — Clicka BI: Onboarding (spaza registrations captured via Spaza
// Onboard / clicka.co.za). Unlike Sales In/Out/Products, there's no
// historical bulk-import dataset behind this one — clicka_registrations IS
// the live platform data, agents capturing stores in the field right now.
// Server-side only — the service role key never reaches the browser.
//
// clicka_registrations has no brand_id column at all (confirmed against the
// live schema), so "per brand" here uses the SAME transitive link Stores
// visibility already uses for the client_rep role (see admin-stores.js): a
// store's brand is whichever brand(s) its CAPTURING AGENT (staff_id) is
// assigned to via clicka_staff_scope (scope_type "brand"). An agent
// assigned to more than one Client has every store they capture counted
// toward each of those brands. Stores merged into another (see the
// Duplicates module) are excluded from every count here, same convention
// used everywhere else in Clicka Admin.
//
// Query params (all optional):
//   brand - brand name. Omitted, or "Clicka", means the combined rollup
//           across every real brand's assigned agents. A caller locked to
//           one or more brands (see resolveBrandLocks) always gets those
//           brand(s) only, whatever this param asks for.
//
// Self-test (open in browser, no data touched):
//   /.netlify/functions/bi-onboarding?selftest=1

const SUPABASE_URL = "https://liemaxqgngtotzbqiqeq.supabase.co";
const SERVICE_KEY =
  process.env.CLICKA_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;
const { getCaller, ALLOWED_ROLES, resolveBrandLocks } = require("./_auth");

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Cache-Control": "public, max-age=120",
    },
    body: JSON.stringify(obj, null, 2),
  };
}

async function restGet(path) {
  const res = await fetch(SUPABASE_URL + path, {
    headers: { Authorization: "Bearer " + SERVICE_KEY, apikey: SERVICE_KEY },
  });
  return res.json();
}

function emptyReport(label) {
  return {
    ok: true,
    filters: { brand: label },
    note: "No agents are assigned to this Client / brand yet, so there's no onboarding data to show.",
    totals: { stores: 0, validated: 0, vas_adoption_pct: 0, wallet_adoption_pct: 0, agents: 0 },
    monthly: [],
    statuses: [],
    businessTypes: [],
    regions: [],
    subregions: [],
    agents: [],
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

  const qs = event.queryStringParameters || {};

  if (qs.selftest === "1") {
    return json(200, {
      ok: true,
      world: "CLICKA-BI",
      supabaseUrl: SUPABASE_URL,
      serviceKeySet: !!SERVICE_KEY,
      note: SERVICE_KEY
        ? "Config looks good."
        : "SERVICE KEY MISSING — set CLICKA_SERVICE_ROLE_KEY in this Netlify site's environment variables.",
    });
  }

  if (!SERVICE_KEY) return json(500, { ok: false, error: "Service key not configured in Netlify." });

  const caller = await getCaller(event);
  if (!caller) return json(401, { ok: false, error: "Not signed in." });
  if (!caller.staff) return json(403, { ok: false, error: "This login has no Clicka Admin profile linked to it yet." });
  if (caller.staff.status === "inactive") return json(403, { ok: false, error: "This account has been deactivated." });
  if (!ALLOWED_ROLES.includes(caller.staff.role)) {
    return json(403, { ok: false, error: "This account isn't set up to use the Trade Map / BI Reports app." });
  }

  const brandRows = await restGet("/rest/v1/bi_brands?select=id,name&order=id");
  const brands = Array.isArray(brandRows) ? brandRows : [];
  const brandNameById = Object.fromEntries(brands.map((b) => [b.id, b.name]));
  const brandIdByName = Object.fromEntries(brands.map((b) => [b.name, b.id]));
  const realBrandIds = brands.filter((b) => b.id !== 4).map((b) => b.id);

  const brandLocks = resolveBrandLocks(caller);

  let targetBrandIds, label;
  if (brandLocks) {
    targetBrandIds = brandLocks;
    label = brandLocks.map((id) => brandNameById[id]).filter(Boolean).join(" + ") || "Clicka";
  } else {
    const requested = (qs.brand || "Tiger Brands").trim();
    if (requested.toLowerCase() === "clicka") {
      targetBrandIds = realBrandIds;
      label = "Clicka";
    } else {
      const id = brandIdByName[requested];
      targetBrandIds = id != null ? [id] : [];
      label = requested;
    }
  }

  if (!targetBrandIds.length) return json(200, emptyReport(label));

  try {
    // Every staff member assigned to any of the target brand(s) — this is
    // the transitive link: brand -> assigned agents -> the stores those
    // agents captured. Same lookup as clientRepAgentStaffIds() in
    // admin-stores.js, kept local here since this function has its own
    // read-only path and doesn't share code with the Admin app bundle.
    const scopeRes = await restGet(
      "/rest/v1/clicka_staff_scope?scope_type=eq.brand&brand_id=in.(" + targetBrandIds.join(",") + ")&select=staff_id"
    );
    const staffIds = [...new Set((Array.isArray(scopeRes) ? scopeRes : []).map((r) => r.staff_id).filter(Boolean))];

    if (!staffIds.length) return json(200, emptyReport(label));

    const staffRes = await restGet("/rest/v1/clicka_staff?id=in.(" + staffIds.join(",") + ")&select=id,first_name,last_name");
    const staffNameById = Object.fromEntries(
      (Array.isArray(staffRes) ? staffRes : []).map((s) => [s.id, ((s.first_name || "") + " " + (s.last_name || "")).trim() || "Unnamed agent"])
    );

    const regRes = await restGet(
      "/rest/v1/clicka_registrations?staff_id=in.(" +
        staffIds.join(",") +
        ")&select=id,created_at,status,business_type,has_vas_device,wallet_type,province,region_id,staff_id,merged_into_id&limit=20000"
    );
    const allRegs = Array.isArray(regRes) ? regRes : [];

    const regionRefRes = await restGet("/rest/v1/bi_regions?select=id,name,province");
    const regionById = Object.fromEntries((Array.isArray(regionRefRes) ? regionRefRes : []).map((r) => [r.id, r]));

    // Merged/duplicate stores are excluded from every active count, same
    // convention as the Duplicates module and Stores visibility elsewhere.
    const active = allRegs.filter((r) => !r.merged_into_id);

    let vasCount = 0, walletCount = 0, validatedCount = 0;
    const monthly = {}, statuses = {}, businessTypes = {}, regionMap = {}, subregionMap = {}, agents = {};

    function bump(map, key, seed) {
      if (!map[key]) map[key] = Object.assign({ stores: 0 }, seed);
      map[key].stores += 1;
    }

    for (const r of active) {
      const monthKey = (r.created_at || "").slice(0, 7);
      if (monthKey) bump(monthly, monthKey, { month: monthKey });
      if (r.status) bump(statuses, r.status, { status: r.status });
      if (r.business_type) bump(businessTypes, r.business_type, { business_type: r.business_type });
      if (r.province) bump(regionMap, r.province, { region: r.province });
      const regionRef = r.region_id ? regionById[r.region_id] : null;
      const subregionName = regionRef ? regionRef.name : null;
      if (subregionName) bump(subregionMap, subregionName + "|" + (r.province || ""), { subregion: subregionName, province: r.province || "" });

      if (r.has_vas_device) vasCount++;
      if (r.wallet_type) walletCount++;
      if (r.status === "validated") validatedCount++;

      const agentName = staffNameById[r.staff_id] || "Unassigned";
      if (!agents[r.staff_id || "unassigned"]) {
        agents[r.staff_id || "unassigned"] = { agent: agentName, stores: 0, validated: 0, last_capture: null };
      }
      const bucket = agents[r.staff_id || "unassigned"];
      bucket.stores += 1;
      if (r.status === "validated") bucket.validated += 1;
      if (!bucket.last_capture || (r.created_at || "") > bucket.last_capture) bucket.last_capture = r.created_at || null;
    }

    return json(200, {
      ok: true,
      filters: { brand: label },
      totals: {
        stores: active.length,
        validated: validatedCount,
        vas_adoption_pct: active.length ? Number(((vasCount / active.length) * 100).toFixed(1)) : 0,
        wallet_adoption_pct: active.length ? Number(((walletCount / active.length) * 100).toFixed(1)) : 0,
        agents: staffIds.length,
      },
      monthly: Object.values(monthly).sort((a, b) => String(a.month).localeCompare(String(b.month))),
      statuses: Object.values(statuses).sort((a, b) => b.stores - a.stores),
      businessTypes: Object.values(businessTypes).sort((a, b) => b.stores - a.stores),
      regions: Object.values(regionMap).sort((a, b) => b.stores - a.stores),
      subregions: Object.values(subregionMap).sort((a, b) => b.stores - a.stores),
      agents: Object.values(agents).sort((a, b) => b.stores - a.stores),
    });
  } catch (e) {
    return json(500, { ok: false, error: String(e.message || e) });
  }
};
