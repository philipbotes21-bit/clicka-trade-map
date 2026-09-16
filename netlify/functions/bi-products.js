// netlify/functions/bi-products.js
//
// FUNCTION — Clicka BI: Products & Categories (Sales Out line items).
// Reads from the bi_sales_out_items / bi_products / bi_categories tables
// in the shared Clicka Supabase project via dedicated read-only SQL
// functions (bi_products_report, bi_categories_list, bi_regions_list,
// bi_subregions_list). Server-side only — the service role key never
// reaches the browser. Those tables have RLS enabled with no policies,
// so only this service-role call path can read them.
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
//   category   - category name (e.g. "Grains"), filters to that category
//
// Brand-scope enforcement: a caller with a clicka_staff_scope row of
// scope_type "brand" (see resolveBrandLock in _auth.js) only ever sees
// that brand's data. Admin, and anyone scoped to "Clicka" itself (Clicka's
// own staff, not a product brand), are unrestricted.
//
// Self-test (open in browser, no data touched):
//   /.netlify/functions/bi-products?selftest=1

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

// ---- Live data (clicka_order_items), merged in alongside the historical
// bulk-import bi_products_report RPC result for whichever brand(s) are in
// scope. Same source rows as bi-sales-out.js's live aggregator (an order
// item already carries brand_id directly) — here they're grouped by
// product/category instead of by order. "items" counts matching order-item
// LINES (not distinct orders) to match the historical report's per-line
// product framing. Category comes from clicka_supplier_products.category_id
// -> clicka_categories.name; region/sub-region from the buying store, same
// as Sales Out.
async function fetchLiveProductsRaw() {
  const [orderRes, itemRes, storeRes, regionRes, spRes, catRes] = await Promise.all([
    restGet("/rest/v1/clicka_orders?select=id,store_id,created_at&limit=5000"),
    restGet("/rest/v1/clicka_order_items?select=id,order_id,supplier_product_id,description,brand_id,qty,line_total&limit=20000"),
    restGet("/rest/v1/clicka_registrations?select=id,province,region_id&limit=5000"),
    restGet("/rest/v1/bi_regions?select=id,name,province"),
    restGet("/rest/v1/clicka_supplier_products?select=id,category_id"),
    restGet("/rest/v1/clicka_categories?select=id,name"),
  ]);
  const orders = Array.isArray(orderRes) ? orderRes : [];
  return {
    items: Array.isArray(itemRes) ? itemRes : [],
    storeById: Object.fromEntries((Array.isArray(storeRes) ? storeRes : []).map((s) => [s.id, s])),
    regionById: Object.fromEntries((Array.isArray(regionRes) ? regionRes : []).map((r) => [r.id, r])),
    spCategoryId: Object.fromEntries((Array.isArray(spRes) ? spRes : []).map((s) => [s.id, s.category_id])),
    categoryNameById: Object.fromEntries((Array.isArray(catRes) ? catRes : []).map((c) => [c.id, c.name])),
    orderById: Object.fromEntries(orders.map((o) => [o.id, o])),
  };
}

function emptyProductsReport() {
  return {
    totals: { items: 0, total_qty: 0, total_value: 0, ordered_value: 0, avg_item_value: 0 },
    monthly: [], categories: [], regions: [], subregions: [], topProducts: [],
  };
}

function liveProductsReportForBrand(raw, brandId, brandName, p_region, p_subregion, p_month, p_category) {
  const { items, storeById, regionById, spCategoryId, categoryNameById, orderById } = raw;

  let totalValue = 0, totalQty = 0, lineCount = 0;
  const monthly = {}, categories = {}, regions = {}, subregions = {}, products = {};

  function bump(map, key, seed, val, qty) {
    if (!map[key]) map[key] = Object.assign({ items: 0, total_qty: 0, total_value: 0 }, seed);
    map[key].items += 1;
    map[key].total_qty += qty;
    map[key].total_value += val;
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
    const categoryId = item.supplier_product_id ? spCategoryId[item.supplier_product_id] : null;
    const categoryName = categoryId ? categoryNameById[categoryId] : null;
    if (p_category && categoryName !== p_category) continue;

    const val = Number(item.line_total) || 0;
    const qty = Number(item.qty) || 0;
    totalValue += val;
    totalQty += qty;
    lineCount += 1;

    if (monthKey) bump(monthly, monthKey, { month: monthKey }, val, qty);
    if (categoryName) bump(categories, categoryName, { category: categoryName }, val, qty);
    if (province) bump(regions, province, { region: province }, val, qty);
    if (subregionName) bump(subregions, subregionName + "|" + (province || ""), { subregion: subregionName, province: province || "" }, val, qty);
    const productName = item.description || "Unnamed product";
    bump(products, productName + "|" + brandName + "|" + (categoryName || ""), { product: productName, brand: brandName, category: categoryName || "" }, val, qty);
  }

  return {
    totals: {
      items: lineCount,
      total_qty: totalQty,
      total_value: Number(totalValue.toFixed(2)),
      ordered_value: Number(totalValue.toFixed(2)),
      avg_item_value: lineCount ? Number((totalValue / lineCount).toFixed(2)) : 0,
    },
    monthly: Object.values(monthly),
    categories: Object.values(categories),
    regions: Object.values(regions),
    subregions: Object.values(subregions),
    topProducts: Object.values(products),
  };
}

function mergeProductsReports(reports) {
  const totals = mergeTotals(reports.map((r) => r.totals || {}));
  totals.avg_item_value = totals.items ? Number((totals.total_value / totals.items).toFixed(2)) : 0;
  return {
    totals,
    monthly: sortByKeyAsc(mergeGrouped(reports.map((r) => r.monthly), (r) => r.month), "month"),
    categories: sortByValueDesc(mergeGrouped(reports.map((r) => r.categories), (r) => r.category), "total_value"),
    regions: sortByValueDesc(mergeGrouped(reports.map((r) => r.regions), (r) => r.region), "total_value"),
    subregions: sortByValueDesc(mergeGrouped(reports.map((r) => r.subregions), (r) => r.subregion + "|" + r.province), "total_value"),
    topProducts: sortByValueDesc(mergeGrouped(reports.map((r) => r.topProducts), (r) => r.product + "|" + (r.brand || "") + "|" + (r.category || "")), "total_value"),
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
  const p_category = qs.category || null;

  if (qs.regions === "1") {
    try {
      if (combined) {
        const lists = await Promise.all(brandNamesForCombined.map((b) => rpc("bi_sales_out_regions_list", { p_brand: b })));
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
  // bi_regions reference table used by Sales In / Sales Out, so the
  // dropdown always shows the full list regardless of current coverage.
  if (qs.subregions === "1") {
    try {
      const subregionsList = await rpc("bi_subregions_list", {});
      return json(200, { ok: true, subregions: subregionsList });
    } catch (e) {
      return json(500, { ok: false, error: String(e.message || e) });
    }
  }

  if (qs.categories === "1") {
    try {
      const categoriesList = await rpc("bi_categories_list", {});
      return json(200, { ok: true, categories: categoriesList });
    } catch (e) {
      return json(500, { ok: false, error: String(e.message || e) });
    }
  }

  try {
    // Single round trip, same pattern as bi-sales-in.js / bi-sales-out.js —
    // one consolidated SQL function computes every aggregate server-side.
    // Live raw data (clicka_order_items) is fetched once regardless of how
    // many brands are in scope, then sliced per brand in JS and merged onto
    // that brand's historical RPC result — see
    // fetchLiveProductsRaw/liveProductsReportForBrand above.
    let report;
    const liveRaw = await fetchLiveProductsRaw();
    if (combined) {
      const reports = await Promise.all(
        brandNamesForCombined.map(async (b) => {
          const hist = await rpc("bi_products_report", { p_brand: b, p_region, p_month, p_limit: 500, p_subregion, p_category });
          const bId = brandIdByName[b];
          const live = bId != null ? liveProductsReportForBrand(liveRaw, bId, b, p_region, p_subregion, p_month, p_category) : emptyProductsReport();
          return mergeProductsReports([hist, live]);
        })
      );
      report = mergeProductsReports(reports);
    } else {
      const hist = await rpc("bi_products_report", { p_brand, p_region, p_month, p_limit: 500, p_subregion, p_category });
      const bId = brandIdByName[p_brand];
      const live = bId != null ? liveProductsReportForBrand(liveRaw, bId, p_brand, p_region, p_subregion, p_month, p_category) : emptyProductsReport();
      report = mergeProductsReports([hist, live]);
    }

    return json(200, {
      ok: true,
      filters: { brand: combined ? (lockedLabel || "Clicka") : p_brand, region: p_region, subregion: p_subregion, month: p_month, category: p_category },
      totals: report.totals || { items: 0, total_qty: 0, total_value: 0, ordered_value: 0, avg_item_value: 0 },
      monthly: report.monthly || [],
      categories: report.categories || [],
      regions: report.regions || [],
      subregions: report.subregions || [],
      topProducts: report.topProducts || [],
    });
  } catch (e) {
    return json(500, { ok: false, error: String(e.message || e) });
  }
};
