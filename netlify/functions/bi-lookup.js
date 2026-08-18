// netlify/functions/bi-lookup.js
//
// FUNCTION — Clicka BI: single-store/single-midi sales lookup, used by the
// Trade Map's click panel (openPanel()). The map's own store/midi data
// files (public/data/stores.json, midis.json) don't carry the same
// unique ID as the Supabase order data, so this matches by GPS position
// instead (nearest bi_spazas/bi_midis row, within 500m) — reliable since
// shop locations don't move. Server-side only, service role key never
// reaches the browser.
//
// Query params:
//   kind - "spaza" or "midi" (required)
//   lat  - latitude of the clicked map marker (required)
//   lng  - longitude of the clicked map marker (required)
//
// Self-test (open in browser, no data touched):
//   /.netlify/functions/bi-lookup?selftest=1

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
      "Cache-Control": "public, max-age=300",
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

  const kind = qs.kind;
  const lat = parseFloat(qs.lat);
  const lng = parseFloat(qs.lng);

  if ((kind !== "spaza" && kind !== "midi") || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return json(400, { ok: false, error: "Required params: kind=spaza|midi, lat, lng." });
  }

  try {
    const fn = kind === "spaza" ? "bi_spaza_lookup" : "bi_midi_lookup";
    const result = await rpc(fn, { p_lat: lat, p_lng: lng });
    return json(200, { ok: true, ...result });
  } catch (e) {
    return json(500, { ok: false, error: String(e.message || e) });
  }
};
