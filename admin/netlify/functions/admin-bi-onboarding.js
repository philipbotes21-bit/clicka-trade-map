// admin/netlify/functions/admin-bi-onboarding.js
//
// FUNCTION — Clicka Admin: Onboarding BI report.
// The first live BI report to live inside Clicka Admin itself, rather than
// the separate Trade Map app — reads clicka_registrations directly (the
// exact table clicka-save.js and admin-stores.js both already read/write),
// so there is no sync step and no second copy of the data to keep straight.
// Modelled on admin-cashless-payments.js's role-gate + brand-scope pattern,
// but uses resolveBrandLocks() from _auth (multi-brand capable) rather than
// cashless's single-brand callerBrandLock — a Client Rep can be assigned to
// more than one Client, same as an Agent can (see clicka-onboard.html's
// multi-client picker).
//
// GET -> one payload: KPIs, a breakdown by client/brand, a breakdown by
//        province, a week-by-week trend, and a short list of the most
//        recently captured stores. Everything is computed from a single
//        filtered fetch of clicka_registrations, aggregated here rather
//        than with several round trips.
//   Filters: &from=&to= (created_at date range), &province=&region_id=
//   &brand_id= (Admin/Supervisor/Regional Manager only — view one specific
//   Client's numbers; omit for the unscoped "Clicka · all brands" rollup).
//
// Visibility:
//   - Admin: everything, unscoped, always. This is the "Clicka sees
//     everything" view — every store regardless of client_brand_id,
//     including ones with none set yet.
//   - Supervisor / Regional Manager: everything within their assigned
//     province(s) (same resolveScopeProvinces() rule as admin-stores.js).
//   - Client Representative: only stores whose client_brand_id matches one
//     of their assigned brands — this is what gets handed to an FMCG
//     client to look at their own onboarding numbers. A store with no
//     client_brand_id set (not yet validated for MIDI ordering, or
//     validated by an agent with no client assigned) never appears in a
//     Client Rep's view — only in the unscoped Admin rollup.
//
// Self-test (no auth needed, no data touched):
//   /.netlify/functions/admin-bi-onboarding?selftest=1

const { json, sb, getCaller, resolveBrandLocks } = require("./_auth");

const ALLOWED_ROLES = ["admin", "supervisor", "regional_manager", "client_rep"];
const VALIDATED_STATUS = "MIDI_ACTIVATED";

async function resolveScopeProvinces(scope) {
  const direct = scope.filter((s) => s.scope_type === "province").map((s) => s.province);
  const regionIds = scope.filter((s) => s.scope_type === "region").map((s) => s.region_id);
  if (!regionIds.length) return [...new Set(direct)];

  const res = await sb("/rest/v1/bi_regions?id=in.(" + regionIds.join(",") + ")&select=id,province");
  const rows = await res.json();
  const fromRegions = Array.isArray(rows) ? rows.map((r) => r.province) : [];
  return [...new Set([...direct, ...fromRegions])].filter(Boolean);
}

// ISO-ish week bucket key, Monday-start, for the trend chart — good enough
// for a "last N weeks" onboarding trend without pulling in a date library.
function weekKey(dateStr) {
  const d = new Date(dateStr);
  const day = (d.getUTCDay() + 6) % 7; // 0 = Monday
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - day);
  return monday.toISOString().slice(0, 10);
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

  const qs = event.queryStringParameters || {};
  if (qs.selftest === "1") return json(200, { ok: true, world: "CLICKA-ADMIN" });

  const caller = await getCaller(event);
  if (!caller || !caller.staff) return json(401, { ok: false, error: "Not signed in." });
  if (caller.staff.status === "inactive") return json(403, { ok: false, error: "Account deactivated." });
  if (!ALLOWED_ROLES.includes(caller.staff.role)) {
    return json(403, { ok: false, error: "The Onboarding report is available to Admin, Supervisor, Regional Manager, and Client Representative accounts." });
  }
  if (event.httpMethod !== "GET") return json(405, { ok: false, error: "Method not allowed." });

  const isClientRep = caller.staff.role === "client_rep";
  const isAdmin = caller.staff.role === "admin";

  // ---- brand scope ----
  let allowedBrandIds = null; // null = unrestricted (Admin's "Clicka · all brands" rollup)
  if (isClientRep) {
    allowedBrandIds = resolveBrandLocks(caller);
    if (!allowedBrandIds || !allowedBrandIds.length) {
      return json(200, {
        ok: true,
        note: "No Client / brand assigned to this account yet — ask an Admin to assign one.",
        kpis: { total: 0, validated: 0, collection: 0, captured_not_activated: 0, declined: 0 },
        by_brand: [], by_province: [], trend: [], recent: [],
      });
    }
  } else if (qs.brand_id) {
    // Admin/Supervisor/Regional Manager can optionally narrow to one
    // Client's numbers using the same filter a Client Rep is locked to —
    // handy for checking exactly what a client will see before sharing
    // login access with them.
    allowedBrandIds = [qs.brand_id];
  }

  // ---- province scope (Supervisor / Regional Manager only) ----
  let allowedProvinces = null;
  if (["supervisor", "regional_manager"].includes(caller.staff.role)) {
    allowedProvinces = await resolveScopeProvinces(caller.scope || []);
    if (!allowedProvinces.length) {
      return json(200, {
        ok: true,
        note: "No region assigned to this account yet — ask an Admin to assign one.",
        kpis: { total: 0, validated: 0, collection: 0, captured_not_activated: 0, declined: 0 },
        by_brand: [], by_province: [], trend: [], recent: [],
      });
    }
  }

  // ---- build the filtered fetch ----
  const andParts = ["merged_into_id.is.null"];
  if (qs.from) andParts.push("created_at.gte." + qs.from);
  if (qs.to) andParts.push("created_at.lte." + qs.to + "T23:59:59");
  if (qs.province) andParts.push("province.eq." + encodeURIComponent(qs.province));
  if (qs.region_id) andParts.push("region_id.eq." + encodeURIComponent(qs.region_id));
  if (allowedProvinces) andParts.push("province.in.(" + allowedProvinces.map((p) => "\"" + p + "\"").join(",") + ")");
  if (allowedBrandIds) andParts.push("client_brand_id.in.(" + allowedBrandIds.join(",") + ")");

  const params = new URLSearchParams();
  params.set("select", "id,created_at,trading_name,province,region_id,status,client_brand_id");
  params.set("order", "created_at.desc");
  params.set("limit", "20000");

  let url = "/rest/v1/clicka_registrations?" + params.toString() + "&and=(" + andParts.join(",") + ")";
  const res = await sb(url);
  const rows = await res.json();
  if (!res.ok) return json(200, { ok: false, error: JSON.stringify(rows).slice(0, 300) });
  const stores = Array.isArray(rows) ? rows : [];

  // ---- resolve names for whatever brand/region ids actually showed up ----
  const regionIds = [...new Set(stores.map((s) => s.region_id).filter(Boolean))];
  let regionsById = {};
  if (regionIds.length) {
    const rres = await sb("/rest/v1/bi_regions?id=in.(" + regionIds.join(",") + ")&select=id,name,province");
    const rrows = await rres.json();
    regionsById = Object.fromEntries((Array.isArray(rrows) ? rrows : []).map((r) => [r.id, r]));
  }
  const brandIds = [...new Set(stores.map((s) => s.client_brand_id).filter(Boolean))];
  let brandsById = {};
  if (brandIds.length) {
    const bres = await sb("/rest/v1/bi_brands?id=in.(" + brandIds.join(",") + ")&select=id,name");
    const brows = await bres.json();
    brandsById = Object.fromEntries((Array.isArray(brows) ? brows : []).map((b) => [b.id, b.name]));
  }

  // ---- KPIs ----
  const kpis = {
    total: stores.length,
    validated: stores.filter((s) => s.status === VALIDATED_STATUS).length,
    collection: stores.filter((s) => s.status === "COLLECTION").length,
    captured_not_activated: stores.filter((s) => s.status === "CAPTURED").length,
    declined: stores.filter((s) => s.status === "DECLINED").length,
  };

  // ---- breakdown by client/brand (only meaningful in the unscoped/Admin
  // rollup — a Client Rep's own view is already filtered to one/few brands,
  // so every row here would just repeat their own kpis; still returned for
  // consistency, it'll just be a short list) ----
  const brandCounts = {};
  stores.forEach((s) => {
    const key = s.client_brand_id || "none";
    if (!brandCounts[key]) brandCounts[key] = { brand_id: s.client_brand_id, brand_name: s.client_brand_id ? (brandsById[s.client_brand_id] || "Unknown") : "No client assigned", total: 0, validated: 0 };
    brandCounts[key].total += 1;
    if (s.status === VALIDATED_STATUS) brandCounts[key].validated += 1;
  });
  const by_brand = Object.values(brandCounts).sort((a, b) => b.total - a.total);

  // ---- breakdown by province ----
  const provinceCounts = {};
  stores.forEach((s) => {
    const key = s.province || "Unknown";
    if (!provinceCounts[key]) provinceCounts[key] = { province: key, total: 0, validated: 0 };
    provinceCounts[key].total += 1;
    if (s.status === VALIDATED_STATUS) provinceCounts[key].validated += 1;
  });
  const by_province = Object.values(provinceCounts).sort((a, b) => b.total - a.total);

  // ---- weekly trend (Monday-bucketed) ----
  const weekCounts = {};
  stores.forEach((s) => {
    const key = weekKey(s.created_at);
    weekCounts[key] = (weekCounts[key] || 0) + 1;
  });
  const trend = Object.keys(weekCounts).sort().map((week) => ({ week, count: weekCounts[week] }));

  // ---- most recent captures (already ordered created_at.desc) ----
  const recent = stores.slice(0, 20).map((s) => ({
    id: s.id,
    trading_name: s.trading_name,
    province: s.province,
    region_name: s.region_id && regionsById[s.region_id] ? regionsById[s.region_id].name : null,
    status: s.status,
    client_brand_name: s.client_brand_id ? (brandsById[s.client_brand_id] || "Unknown") : null,
    created_at: s.created_at,
  }));

  return json(200, { ok: true, kpis, by_brand, by_province, trend, recent });
};
