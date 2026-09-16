// netlify/functions/bi-sales-out.js
//
// FUNCTION — Clicka BI: Sales Out (Midi orders to Spazas, placed on the app).
// Reads from the bi_sales_out / bi_midis / bi_spazas / bi_brands tables in
// the shared Clicka Supabase project via dedicated read-only SQL functions
// (bi_sales_out_*). Server-side only — the service role key never reaches
// the browser. Those tables have RLS enabled with no policies, so only
// this service-role call path can read them.
//
// Query params (all optional):
//   brand      - brand name. Omitted, or "Clicka", means the combined
//                rollup across every real brand — the "Clicka" tab is
//                "all brands combined" in the BI app. A caller locked to
//                one brand (see below) always gets that brand only,
//                whatever this param asks for.
//   region     - province name (of the buying spaza), filters to that province
//   subregion  - sub-region name (e.g. "Vaal", "Tembisa"), filters to that sub-region
//   month      - "YYYY-MM", filters to that calendar month
//
// Brand-scope enforcement: a caller with a clicka_staff_scope row of
// scope_type "brand" (see resolveBrandLock in _auth.js) only ever sees
// that brand's data. Admin, and anyone scoped to "Clicka" itself (Clicka's
// own staff, not a product brand), are unrestricted.
//
// Self-test (open in browser, no data touched):
//   /.netlify/functions/bi-sales-out?selftest=1

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

async function rpc(name, params) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/rpc/" + name, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + SERVICE_KEY,
      apikey: SERVICE_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(name + " failed: " + res.status + " " + t.slice(0, 300));
  }
  return res.json();
}

async function restGet(path) {
  const res = await fetch(SUPABASE_URL + path, {
    headers: { Authorization: "Bearer " + SERVICE_KEY, apikey: SERVICE_KEY },
  });
  return res.json();
}

// ---- Merge helpers for the "Clicka" combined view — one RPC call per real
// brand, summed together in JS rather than touching the underlying SQL. ----
function sumNumeric(target, src) {
  for (const k of Object.keys(src || {})) {
    if (typeof src[k] === "number") target[k] = (target[k] || 0) + src[k];
  }
  return target;
}
function mergeTotals(list) {
  return list.reduce((acc, t) => sumNumeric(acc, t), {});
}
function mergeGrouped(lists, keyFn) {
  const map = {};
  for (const list of lists) {
    for (const row of list || []) {
      const key = keyFn(row);
      if (key === undefined || key === null) continue;
      if (!map[key]) map[key] = Object.assign({}, row);
      else sumNumeric(map[key], row);
    }
  }
  return Object.values(map);
}
function sortByKeyAsc(arr, key) {
  return arr.slice().sort((a, b) => String(a[key]).localeCompare(String(b[key])));
}
function sortByValueDesc(arr, key) {
  return arr.slice().sort((a, b) => (b[key] || 0) - (a[key] || 0));
}

// ---- Live data (clicka_orders / clicka_order_items), merged in alongside
// the historical bulk-import bi_sales_out_report RPC result for whichever
// brand(s) are in scope. clicka_order_items carries brand_id directly (no
// join needed to attribute a line to a brand). An order can carry lines
// from more than one brand — "orders" for a given brand counts every order
// that touched that brand at least once; "value" only counts THAT brand's
// own lines within it. Region/sub-region come from the buying store
// (clicka_registrations.province / region_id, via clicka_orders.store_id) —
// the same fields Stores visibility already reads.
async function fetchLiveSalesOutRaw() {
  const [orderRes, itemRes, storeRes, midiRes, regionRes] = await Promise.all([
    restGet("/rest/v1/clicka_orders?select=id,store_id,midi_id,status,created_at&limit=5000"),
    restGet("/rest/v1/clicka_order_items?select=id,order_id,brand_id,line_total&limit=20000"),
    restGet("/rest/v1/clicka_registrations?select=id,province,region_id,trading_name,registered_name&limit=5000"),
    restGet("/rest/v1/clicka_midis?select=id,name&limit=5000"),
    restGet("/rest/v1/bi_regions?select=id,name,province"),
  ]);
  const orders = Array.isArray(orderRes) ? orderRes : [];
  return {
    items: Array.isArray(itemRes) ? itemRes : [],
    storeById: Object.fromEntries((Array.isArray(storeRes) ? storeRes : []).map((s) => [s.id, s])),
    midiById: Object.fromEntries((Array.isArray(midiRes) ? midiRes : []).map((m) => [m.id, m])),
    regionById: Object.fromEntries((Array.isArray(regionRes) ? regionRes : []).map((r) => [r.id, r])),
    orderById: Object.fromEntries(orders.map((o) => [o.id, o])),
  };
}

function emptySalesOutReport() {
  return {
    totals: { orders: 0, total_value: 0, ordered_value: 0, avg_order: 0 },
    monthly: [], regions: [], subregions: [], statuses: [], topMidis: [], topSpazas: [],
  };
}

function liveSalesOutReportForBrand(raw, brandId, p_region, p_subregion, p_month) {
  const { items, storeById, midiById, regionById, orderById } = raw;

  let totalValue = 0;
  const orderSet = new Set();
  const monthly = {}, regions = {}, subregions = {}, statuses = {}, midis = {}, spazas = {};

  function bump(map, key, seed, val, orderId) {
    if (!map[key]) map[key] = Object.assign({ total_value: 0, _orders: new Set() }, seed);
    map[key].total_value += val;
    map[key]._orders.add(orderId);
  }
  function finish(map) {
    return Object.values(map).map(({ _orders, ...rest }) => ({ ...rest, orders: _orders.size }));
  }

  for (const item of items) {
    if (Number(item.brand_id) !== Number(brandId)) continue;
    const order = orderById[item.order_id];
    if (!order) continue;
    const store = order.store_id ? storeById[order.store_id] : null;
    const province = store ? store.province : null;
    const region = store && store.region_id ? regionById[store.region_id] : null;
    const subregionName = region ? region.name : null;
    if (p_region && province !== p_region) continue;
    if (p_subregion && subregionName !== p_subregion) continue;
    const monthKey = (order.created_at || "").slice(0, 7);
    if (p_month && monthKey !== p_month) continue;

    const val = Number(item.line_total) || 0;
    totalValue += val;
    orderSet.add(order.id);

    if (monthKey) bump(monthly, monthKey, { month: monthKey }, val, order.id);
    if (province) bump(regions, province, { region: province }, val, order.id);
    if (subregionName) bump(subregions, subregionName + "|" + (province || ""), { subregion: subregionName, province: province || "" }, val, order.id);
    if (order.status) bump(statuses, order.status, { status: order.status }, val, order.id);
    const midi = order.midi_id ? midiById[order.midi_id] : null;
    if (midi) bump(midis, midi.name, { midi: midi.name }, val, order.id);
    const spazaName = store ? store.trading_name || store.registered_name : null;
    if (spazaName) bump(spazas, spazaName + "|" + (province || "") + "|" + (subregionName || ""), { spaza: spazaName, region: province || "", subregion: subregionName || "" }, val, order.id);
  }

  return {
    totals: {
      orders: orderSet.size,
      total_value: Number(totalValue.toFixed(2)),
      ordered_value: Number(totalValue.toFixed(2)),
      avg_order: orderSet.size ? Number((totalValue / orderSet.size).toFixed(2)) : 0,
    },
    monthly: finish(monthly),
    regions: finish(regions),
    subregions: finish(subregions),
    statuses: finish(statuses),
    topMidis: finish(midis),
    topSpazas: finish(spazas),
  };
}

function mergeSalesOutReports(reports) {
  const totals = mergeTotals(reports.map((r) => r.totals || {}));
  totals.avg_order = totals.orders ? Number((totals.total_value / totals.orders).toFixed(2)) : 0;
  return {
    totals,
    monthly: sortByKeyAsc(mergeGrouped(reports.map((r) => r.monthly), (r) => r.month), "month"),
    regions: sortByValueDesc(mergeGrouped(reports.map((r) => r.regions), (r) => r.region), "total_value"),
    subregions: sortByValueDesc(mergeGrouped(reports.map((r) => r.subregions), (r) => r.subregion + "|" + r.province), "total_value"),
    statuses: sortByValueDesc(mergeGrouped(reports.map((r) => r.statuses), (r) => r.status), "total_value"),
    topMidis: sortByValueDesc(mergeGrouped(reports.map((r) => r.topMidis), (r) => r.midi), "total_value"),
    topSpazas: sortByValueDesc(mergeGrouped(reports.map((r) => r.topSpazas), (r) => (r.spaza || "") + "|" + (r.region || "") + "|" + (r.subregion || "")), "total_value"),
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
  const realBrandNames = brands.filter((b) => b.id !== 4).map((b) => b.name);

  const brandLocks = resolveBrandLocks(caller);

  let p_brand, combined, brandNamesForCombined, lockedLabel;
  if (brandLocks) {
    const lockedNames = brandLocks.map((id) => brandNameById[id]).filter(Boolean);
    if (lockedNames.length <= 1) {
      combined = false;
      p_brand = lockedNames[0] || "Tiger Brands";
    } else {
      combined = true;
      p_brand = null;
      brandNamesForCombined = lockedNames;
      lockedLabel = lockedNames.join(" + ");
    }
  } else {
    const requested = (qs.brand || "Tiger Brands").trim();
    combined = requested.toLowerCase() === "clicka";
    p_brand = combined ? null : requested;
    brandNamesForCombined = realBrandNames;
  }

  const p_region = qs.region || null;
  const p_subregion = qs.subregion || null;
  const p_month = qs.month || null;

  if (qs.regions === "1") {
    try {
      if (combined) {
        const lists = await Promise.all(brandNamesForCombined.map((b) => rpc("bi_sales_out_regions_list", { p_brand: b })));
        // bi_sales_out_regions_list returns a plain jsonb array of province
        // name strings (no wrapper object), unlike bi_regions_list.
        const union = [...new Set(lists.flat())].sort();
        return json(200, { ok: true, regions: union });
      }
      const regionsList = await rpc("bi_sales_out_regions_list", { p_brand });
      return json(200, { ok: true, regions: regionsList });
    } catch (e) {
      return json(500, { ok: false, error: String(e.message || e) });
    }
  }

  // Canonical sub-region list (name + parent province) — same shared
  // bi_regions reference table used by Sales In, so the dropdown always
  // shows the full 35-entry list regardless of current order coverage.
  if (qs.subregions === "1") {
    try {
      const subregionsList = await rpc("bi_subregions_list", {});
      return json(200, { ok: true, subregions: subregionsList });
    } catch (e) {
      return json(500, { ok: false, error: String(e.message || e) });
    }
  }

  try {
    // Single round trip, same pattern as bi-sales-in.js — one consolidated
    // SQL function computes every aggregate server-side. p_limit is shared
    // by topMidis/topSpazas; set high enough to return everything (136
    // midis, ~24k spazas) since the frontend scrolls these panels instead
    // of truncating.
    // Live raw data (clicka_orders/clicka_order_items) is fetched once
    // regardless of how many brands are in scope, then sliced per brand in
    // JS and merged onto that brand's historical RPC result — see
    // fetchLiveSalesOutRaw/liveSalesOutReportForBrand above.
    let report;
    const liveRaw = await fetchLiveSalesOutRaw();
    if (combined) {
      const reports = await Promise.all(
        brandNamesForCombined.map(async (b) => {
          const hist = await rpc("bi_sales_out_report", { p_brand: b, p_region, p_month, p_limit: 2000, p_subregion });
          const bId = brandIdByName[b];
          const live = bId != null ? liveSalesOutReportForBrand(liveRaw, bId, p_region, p_subregion, p_month) : emptySalesOutReport();
          return mergeSalesOutReports([hist, live]);
        })
      );
      report = mergeSalesOutReports(reports);
    } else {
      const hist = await rpc("bi_sales_out_report", { p_brand, p_region, p_month, p_limit: 2000, p_subregion });
      const bId = brandIdByName[p_brand];
      const live = bId != null ? liveSalesOutReportForBrand(liveRaw, bId, p_region, p_subregion, p_month) : emptySalesOutReport();
      report = mergeSalesOutReports([hist, live]);
    }

    return json(200, {
      ok: true,
      filters: { brand: combined ? (lockedLabel || "Clicka") : p_brand, region: p_region, subregion: p_subregion, month: p_month },
      totals: report.totals || { orders: 0, total_value: 0, ordered_value: 0, avg_order: 0 },
      monthly: report.monthly || [],
      regions: report.regions || [],
      subregions: report.subregions || [],
      statuses: report.statuses || [],
      topMidis: report.topMidis || [],
      topSpazas: report.topSpazas || [],
    });
  } catch (e) {
    return json(500, { ok: false, error: String(e.message || e) });
  }
};
