// netlify/functions/bi-cashless.js
//
// FUNCTION — Clicka BI: Cashless payments to Wholesalers.
// Reads clicka_wholesaler_cashless_payments (captured by hand in Clicka
// Admin's "Cashless to Wholesaler" tab — see admin-cashless-payments.js —
// manual for now, Shop2Shop integration to feed it automatically comes
// later). Same Supabase project, same table, read-only here.
//
// Query params (all optional):
//   brand   - brand name (e.g. "Tiger Brands", "Unilever"). Omitted, or
//             "Clicka", means the combined rollup across every brand —
//             the "Clicka" tab is "all brands combined" in the BI app.
//   month   - "YYYY-MM", filters to that calendar month
//   from/to - "YYYY-MM-DD" date range, alternative to month
//
// Brand-scope enforcement: a caller locked to one brand (see
// resolveBrandLock in _auth.js) always gets that brand's data only,
// regardless of what ?brand= asks for. Unrestricted callers (Admin, or
// anyone scoped to "Clicka" itself, or nobody with a brand scope at all)
// get whatever they ask for, defaulting to the combined view.
//
// Self-test (no auth needed, no data touched):
//   /.netlify/functions/bi-cashless?selftest=1

const { SUPABASE_URL, SERVICE_KEY, sb, getCaller, ALLOWED_ROLES, resolveBrandLock } = require("./_auth");

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Cache-Control": "public, max-age=60",
    },
    body: JSON.stringify(obj, null, 2),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

  const qs = event.queryStringParameters || {};

  if (qs.selftest === "1") {
    return json(200, {
      ok: true,
      world: "CLICKA-BI-CASHLESS",
      supabaseUrl: SUPABASE_URL,
      serviceKeySet: !!SERVICE_KEY,
    });
  }

  if (!SERVICE_KEY) return json(500, { ok: false, error: "Service key not configured in Netlify." });
  if (event.httpMethod !== "GET") return json(405, { ok: false, error: "Method not allowed." });

  const caller = await getCaller(event);
  if (!caller) return json(401, { ok: false, error: "Not signed in." });
  if (!caller.staff) return json(403, { ok: false, error: "This login has no Clicka Admin profile linked to it yet." });
  if (caller.staff.status === "inactive") return json(403, { ok: false, error: "This account has been deactivated." });
  if (!ALLOWED_ROLES.includes(caller.staff.role)) {
    return json(403, { ok: false, error: "This account isn't set up to use the Trade Map / BI Reports app." });
  }

  try {
    // Every brand, so names can be resolved and "brand=<name>" requests
    // can be turned into the id the payments table actually stores.
    const brandsRes = await sb("/rest/v1/bi_brands?select=id,name&order=id");
    const brandRows = await brandsRes.json();
    const brands = Array.isArray(brandRows) ? brandRows : [];
    const brandIdByName = Object.fromEntries(brands.map((b) => [String(b.name).toLowerCase(), b.id]));
    const brandNameById = Object.fromEntries(brands.map((b) => [b.id, b.name]));

    const brandLock = resolveBrandLock(caller);

    let mode, effectiveBrandId, effectiveBrandName;
    if (brandLock) {
      mode = "single";
      effectiveBrandId = brandLock;
      effectiveBrandName = brandNameById[brandLock] || null;
    } else {
      const requested = (qs.brand || "").trim();
      if (!requested || requested.toLowerCase() === "clicka") {
        mode = "combined";
        effectiveBrandId = null;
        effectiveBrandName = "Clicka";
      } else {
        const id = brandIdByName[requested.toLowerCase()];
        if (!id) return json(400, { ok: false, error: "Unknown brand: " + requested });
        mode = "single";
        effectiveBrandId = id;
        effectiveBrandName = brandNameById[id];
      }
    }

    let url = "/rest/v1/clicka_wholesaler_cashless_payments?select=*&order=payment_date.desc&limit=5000";
    if (mode === "single") url += "&brand_id=eq." + effectiveBrandId;
    if (qs.month) {
      const [y, m] = qs.month.split("-");
      if (y && m) {
        const from = y + "-" + m + "-01";
        const nextMonth = m === "12" ? (Number(y) + 1) + "-01-01" : y + "-" + String(Number(m) + 1).padStart(2, "0") + "-01";
        url += "&payment_date=gte." + from + "&payment_date=lt." + nextMonth;
      }
    } else {
      if (qs.from) url += "&payment_date=gte." + qs.from;
      if (qs.to) url += "&payment_date=lte." + qs.to;
    }

    const res = await sb(url);
    const rows = await res.json();
    if (!res.ok) return json(500, { ok: false, error: JSON.stringify(rows).slice(0, 300) });
    const payments = Array.isArray(rows) ? rows : [];

    const midiIds = [...new Set(payments.map((p) => p.midi_id).filter(Boolean))];
    let midisById = {};
    if (midiIds.length) {
      const midiRes = await sb("/rest/v1/clicka_midis?id=in.(" + midiIds.join(",") + ")&select=id,name");
      const midiRows = await midiRes.json();
      midisById = Object.fromEntries((Array.isArray(midiRows) ? midiRows : []).map((m) => [m.id, m.name]));
    }

    const totals = { payments: payments.length, total_paid: 0 };
    const monthlyMap = {};
    const byBrandMap = {};
    const byWholesalerMap = {};

    for (const p of payments) {
      const amt = Number(p.amount_paid) || 0;
      totals.total_paid += amt;

      const monthKey = (p.payment_date || "").slice(0, 7);
      if (monthKey) {
        monthlyMap[monthKey] = monthlyMap[monthKey] || { month: monthKey, total_paid: 0, payments: 0 };
        monthlyMap[monthKey].total_paid += amt;
        monthlyMap[monthKey].payments += 1;
      }

      const bId = p.brand_id;
      byBrandMap[bId] = byBrandMap[bId] || { brand_id: bId, brand_name: brandNameById[bId] || "Unknown", total_paid: 0, payments: 0 };
      byBrandMap[bId].total_paid += amt;
      byBrandMap[bId].payments += 1;

      const mId = p.midi_id;
      byWholesalerMap[mId] = byWholesalerMap[mId] || { midi_id: mId, midi_name: midisById[mId] || "Unknown", total_paid: 0, payments: 0 };
      byWholesalerMap[mId].total_paid += amt;
      byWholesalerMap[mId].payments += 1;
    }

    totals.total_paid = Number(totals.total_paid.toFixed(2));

    const monthly = Object.values(monthlyMap).sort((a, b) => a.month.localeCompare(b.month))
      .map((m) => ({ ...m, total_paid: Number(m.total_paid.toFixed(2)) }));
    const byBrand = Object.values(byBrandMap).sort((a, b) => b.total_paid - a.total_paid)
      .map((b) => ({ ...b, total_paid: Number(b.total_paid.toFixed(2)) }));
    const byWholesaler = Object.values(byWholesalerMap).sort((a, b) => b.total_paid - a.total_paid)
      .map((w) => ({ ...w, total_paid: Number(w.total_paid.toFixed(2)) }));

    return json(200, {
      ok: true,
      mode,
      filters: { brand: effectiveBrandName, month: qs.month || null, from: qs.from || null, to: qs.to || null },
      brands: brands.filter((b) => b.id !== 4).map((b) => b.name), // pickable brand list — Clicka itself isn't a pickable data brand
      totals,
      monthly,
      byBrand,
      byWholesaler,
    });
  } catch (e) {
    return json(500, { ok: false, error: String(e.message || e) });
  }
};
