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
//   brand      - brand name, defaults to "Tiger Brands"
//   region     - province name (of the buying spaza), filters to that province
//   subregion  - sub-region name (e.g. "Vaal", "Tembisa"), filters to that sub-region
//   month      - "YYYY-MM", filters to that calendar month
//   category   - category name (e.g. "Grains"), filters to that category
//
// Self-test (open in browser, no data touched):
//   /.netlify/functions/bi-products?selftest=1

const SUPABASE_URL = "https://liemaxqgngtotzbqiqeq.supabase.co";
const SERVICE_KEY =
  process.env.CLICKA_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;

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

  const p_brand = qs.brand || "Tiger Brands";
  const p_region = qs.region || null;
  const p_subregion = qs.subregion || null;
  const p_month = qs.month || null;
  const p_category = qs.category || null;

  if (qs.regions === "1") {
    try {
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
    const report = await rpc("bi_products_report", {
      p_brand,
      p_region,
      p_month,
      p_limit: 500,
      p_subregion,
      p_category,
    });

    return json(200, {
      ok: true,
      filters: { brand: p_brand, region: p_region, subregion: p_subregion, month: p_month, category: p_category },
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
