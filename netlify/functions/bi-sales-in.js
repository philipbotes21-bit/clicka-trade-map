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
//   brand      - brand name, defaults to "Tiger Brands"
//   region     - province name, filters to that province
//   subregion  - sub-region name (e.g. "Vaal", "Tembisa"), filters to that sub-region
//   month      - "YYYY-MM", filters to that calendar month
//
// Self-test (open in browser, no data touched):
//   /.netlify/functions/bi-sales-in?selftest=1

const SUPABASE_URL = "https://liemaxqgngtotzbqiqeq.supabase.co";
const SERVICE_KEY =
  process.env.CLICKA_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;
const { requireStaff } = require("./_auth");

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
  const authErr = await requireStaff(event, json);
  if (authErr) return authErr;

  const p_brand = qs.brand || "Tiger Brands";
  const p_region = qs.region || null;
  const p_subregion = qs.subregion || null;
  const p_month = qs.month || null;

  if (qs.regions === "1") {
    try {
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
    const report = await rpc("bi_sales_in_report", { p_brand, p_region, p_month, p_limit: 1000, p_subregion });

    return json(200, {
      ok: true,
      filters: { brand: p_brand, region: p_region, subregion: p_subregion, month: p_month },
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
