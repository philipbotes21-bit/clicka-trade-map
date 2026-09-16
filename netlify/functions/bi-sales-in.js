// netlify/functions/bi-sales-in.js
//
// FUNCTION — Clicka BI: Sales In (Midi orders from wholesalers).
// Reads from the bi_sales_in / bi_midis / bi_wholesalers / bi_brands
// tables in the shared Clicka Supabase project via dedicated read-only
// SQL functions (bi_sales_in_*). Server-side only — the service role
// key never reaches the browser. Those tables have RLS enabled with
// no policies, so only this service-role call path can read them.
//
// Query params (all optional):
//   brand      - brand name. Omitted, or "Clicka", means the combined
//                rollup across every real brand — the "Clicka" tab is
//                "all brands combined" in the BI app. A caller locked to
//                one brand (see below) always gets that brand only,
//                whatever this param asks for.
//   region     - province name, filters to that province
//   subregion  - sub-region name (e.g. "Vaal", "Tembisa"), filters to that sub-region
//   month      - "YYYY-MM", filters to that calendar month
//
// Brand-scope enforcement: a caller with one or more clicka_staff_scope
// rows of scope_type "brand" (see resolveBrandLocks in _auth.js) only ever
// sees those brand(s)' data — one brand locks to that brand alone, two or
// more locks to a combined view merged across just those brands. Admin,
// and anyone scoped to "Clicka" itself (Clicka's own staff, not a product
// brand), are unrestricted.
//
// Self-test (open in browser, no data touched):
//   /.netlify/functions/bi-sales-in?selftest=1

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

// ---- Live data (clicka_invoices / clicka_invoice_lines), merged in
// alongside the historical bulk-import bi_sales_in_report RPC result for
// whichever brand(s) are in scope. Unlike Stores/Onboarding this needs no
// agent->brand transitive link: clicka_invoice_lines carries its brand
// straight off the product catalog (clicka_supplier_products.brand_id), so
// a line's brand is exactly whichever supplier product it's a line for.
// An invoice can carry lines from more than one brand (a mixed wholesaler-
// order basket) — "orders" for a given brand counts every invoice that
// touched that brand at least once; "value" only ever counts THAT brand's
// own lines within it, never the whole invoice. Live invoices don't carry
// a fulfilment-status field (yet), so live rows never contribute to the
// "statuses" breakdown — that stays historical-only until one exists.
async function fetchLiveSalesInRaw() {
  const [invRes, lineRes, spRes, midiRes, regionRes, srcRes] = await Promise.all([
    restGet("/rest/v1/clicka_invoices?select=id,midi_id,source_id,invoice_date&limit=5000"),
    restGet("/rest/v1/clicka_invoice_lines?select=id,invoice_id,supplier_product_id,line_total&limit=20000"),
    restGet("/rest/v1/clicka_supplier_products?select=id,brand_id"),
    restGet("/rest/v1/clicka_midis?select=id,name,home_region_id"),
    restGet("/rest/v1/bi_regions?select=id,name,province"),
    restGet("/rest/v1/clicka_invoice_sources?select=id,name"),
  ]);
  const invoices = Array.isArray(invRes) ? invRes : [];
  return {
    lines: Array.isArray(lineRes) ? lineRes : [],
    spBrand: Object.fromEntries((Array.isArray(spRes) ? spRes : []).map((s) => [s.id, s.brand_id])),
    midiById: Object.fromEntries((Array.isArray(midiRes) ? midiRes : []).map((m) => [m.id, m])),
    regionById: Object.fromEntries((Array.isArray(regionRes) ? regionRes : []).map((r) => [r.id, r])),
    sourceById: Object.fromEntries((Array.isArray(srcRes) ? srcRes : []).map((s) => [s.id, s.name])),
    invoiceById: Object.fromEntries(invoices.map((i) => [i.id, i])),
  };
}

function emptySalesInReport() {
  return {
    totals: { orders: 0, total_value: 0, avg_order: 0 },
    monthly: [], regions: [], subregions: [], statuses: [], topWholesalers: [], topMidis: [],
  };
}

function liveSalesInReportForBrand(raw, brandId, p_region, p_subregion, p_month) {
  const { lines, spBrand, midiById, regionById, sourceById, invoiceById } = raw;

  let totalValue = 0;
  const orderSet = new Set();
  const monthly = {}, regions = {}, subregions = {}, wholesalers = {}, midis = {};

  function bump(map, key, seed, val, orderId) {
    if (!map[key]) map[key] = Object.assign({ total_value: 0, _orders: new Set() }, seed);
    map[key].total_value += val;
    map[key]._orders.add(orderId);
  }
  function finish(map) {
    return Object.values(map).map(({ _orders, ...rest }) => ({ ...rest, orders: _orders.size }));
  }

  for (const line of lines) {
    if (Number(spBrand[line.supplier_product_id]) !== Number(brandId)) continue;
    const inv = invoiceById[line.invoice_id];
    if (!inv) continue;
    const midi = inv.midi_id ? midiById[inv.midi_id] : null;
    const region = midi && midi.home_region_id ? regionById[midi.home_region_id] : null;
    const province = region ? region.province : null;
    const subregionName = region ? region.name : null;
    if (p_region && province !== p_region) continue;
    if (p_subregion && subregionName !== p_subregion) continue;
    const monthKey = (inv.invoice_date || "").slice(0, 7);
    if (p_month && monthKey !== p_month) continue;

    const val = Number(line.line_total) || 0;
    totalValue += val;
    orderSet.add(inv.id);

    if (monthKey) bump(monthly, monthKey, { month: monthKey }, val, inv.id);
    if (province) bump(regions, province, { region: province }, val, inv.id);
    if (subregionName) bump(subregions, subregionName + "|" + (province || ""), { subregion: subregionName, province: province || "" }, val, inv.id);
    const wholesalerName = inv.source_id ? sourceById[inv.source_id] : null;
    if (wholesalerName) bump(wholesalers, wholesalerName, { wholesaler: wholesalerName }, val, inv.id);
    const midiName = midi ? midi.name : null;
    if (midiName) bump(midis, midiName + "|" + (province || "") + "|" + (subregionName || ""), { midi: midiName, region: province || "", subregion: subregionName || "" }, val, inv.id);
  }

  return {
    totals: {
      orders: orderSet.size,
      total_value: Number(totalValue.toFixed(2)),
      avg_order: orderSet.size ? Number((totalValue / orderSet.size).toFixed(2)) : 0,
    },
    monthly: finish(monthly),
    regions: finish(regions),
    subregions: finish(subregions),
    statuses: [],
    topWholesalers: finish(wholesalers),
    topMidis: finish(midis),
  };
}

function mergeSalesInReports(reports) {
  const totals = mergeTotals(reports.map((r) => r.totals || {}));
  totals.avg_order = totals.orders ? Number((totals.total_value / totals.orders).toFixed(2)) : 0;
  return {
    totals,
    monthly: sortByKeyAsc(mergeGrouped(reports.map((r) => r.monthly), (r) => r.month), "month"),
    regions: sortByValueDesc(mergeGrouped(reports.map((r) => r.regions), (r) => r.region), "total_value"),
    subregions: sortByValueDesc(mergeGrouped(reports.map((r) => r.subregions), (r) => r.subregion + "|" + r.province), "total_value"),
    statuses: sortByValueDesc(mergeGrouped(reports.map((r) => r.statuses), (r) => r.status), "total_value"),
    topWholesalers: sortByValueDesc(mergeGrouped(reports.map((r) => r.topWholesalers), (r) => r.wholesaler), "total_value"),
    topMidis: sortByValueDesc(mergeGrouped(reports.map((r) => r.topMidis), (r) => r.midi + "|" + (r.region || "") + "|" + (r.subregion || "")), "total_value"),
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

  // Every brand, so a caller's numeric brand-lock can be turned into the
  // name the bi_* RPCs expect, and the combined view knows which real
  // brands to loop over (everything except "Clicka" itself, id 4, which
  // has no rows in any bi_* sales table — it's an access-scope marker).
  const brandRows = await restGet("/rest/v1/bi_brands?select=id,name&order=id");
  const brands = Array.isArray(brandRows) ? brandRows : [];
  const brandNameById = Object.fromEntries(brands.map((b) => [b.id, b.name]));
  const brandIdByName = Object.fromEntries(brands.map((b) => [b.name, b.id]));
  const realBrandNames = brands.filter((b) => b.id !== 4).map((b) => b.name);

  const brandLocks = resolveBrandLocks(caller);

  // brandNamesForCombined is only meaningful when combined === true — the
  // set of brand names to loop over and merge. Unrestricted callers get
  // every real brand; a caller locked to 2+ brands (a Client Rep assigned
  // to several clients) only gets their own set merged, never the rest.
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
        const lists = await Promise.all(brandNamesForCombined.map((b) => rpc("bi_regions_list", { p_brand: b })));
        const union = [...new Set(lists.flat().map((r) => r.region))].sort();
        return json(200, { ok: true, regions: union });
      }
      const regionsList = await rpc("bi_regions_list", { p_brand });
      return json(200, { ok: true, regions: regionsList.map((r) => r.region) });
    } catch (e) {
      return json(500, { ok: false, error: String(e.message || e) });
    }
  }

  // Canonical sub-region list (name + parent province) from the bi_regions
  // reference table — independent of whether any order data exists yet for
  // a given sub-region, so the filter dropdown always shows the full list.
  if (qs.subregions === "1") {
    try {
      const subregionsList = await rpc("bi_subregions_list", {});
      return json(200, { ok: true, subregions: subregionsList });
    } catch (e) {
      return json(500, { ok: false, error: String(e.message || e) });
    }
  }

  try {
    // Single round trip — bi_sales_in_report() computes every aggregate
    // server-side in one query and hands back one JSON object. The old
    // version fired 6 separate RPC calls in parallel, which was slow
    // enough on the unfiltered "all months" view to occasionally hit
    // Netlify's function timeout.
    // p_limit is shared by the top-wholesalers and top-midis lists. Set high
    // enough to return every wholesaler/midi (currently ~528 / ~281) — the
    // "Top N" framing is now just default sort order, not a hard cutoff.
    // The frontend scrolls these panels (.bi-scroll) instead of truncating.
    // Live raw data (clicka_invoices/clicka_invoice_lines etc.) is fetched
    // once regardless of how many brands are in scope, then sliced per
    // brand in JS and merged onto that brand's historical RPC result —
    // see fetchLiveSalesInRaw/liveSalesInReportForBrand above.
    let report;
    const liveRaw = await fetchLiveSalesInRaw();
    if (combined) {
      const reports = await Promise.all(
        brandNamesForCombined.map(async (b) => {
          const hist = await rpc("bi_sales_in_report", { p_brand: b, p_region, p_month, p_limit: 1000, p_subregion });
          const bId = brandIdByName[b];
          const live = bId != null ? liveSalesInReportForBrand(liveRaw, bId, p_region, p_subregion, p_month) : emptySalesInReport();
          return mergeSalesInReports([hist, live]);
        })
      );
      report = mergeSalesInReports(reports);
    } else {
      const hist = await rpc("bi_sales_in_report", { p_brand, p_region, p_month, p_limit: 1000, p_subregion });
      const bId = brandIdByName[p_brand];
      const live = bId != null ? liveSalesInReportForBrand(liveRaw, bId, p_region, p_subregion, p_month) : emptySalesInReport();
      report = mergeSalesInReports([hist, live]);
    }

    return json(200, {
      ok: true,
      filters: { brand: combined ? (lockedLabel || "Clicka") : p_brand, region: p_region, subregion: p_subregion, month: p_month },
      totals: report.totals || { orders: 0, total_value: 0, avg_order: 0 },
      monthly: report.monthly || [],
      regions: report.regions || [],
      subregions: report.subregions || [],
      statuses: report.statuses || [],
      topWholesalers: report.topWholesalers || [],
      topMidis: report.topMidis || [],
    });
  } catch (e) {
    return json(500, { ok: false, error: String(e.message || e) });
  }
};
