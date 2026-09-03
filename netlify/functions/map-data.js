// netlify/functions/map-data.js
//
// FUNCTION — serves the Trade Map's store/midi pin data (name, GPS,
// validation status, region) to signed-in staff only. This used to be two
// plain static files (public/data/stores.json, midis.json) that anyone
// with the URL could download, logged-in or not. They now live outside
// the publish directory (netlify/functions/data/) so Netlify's CDN never
// serves them directly, and this function is the only way to reach them —
// gated by the same requireStaff() check as the BI reports, so every
// fetch (or attempted fetch) shows up in this function's Netlify logs.
//
// stores.json is ~9.5MB uncompressed, over the 6MB Lambda response limit,
// so this gzips it server-side (down to ~1.4MB) and sets Content-Encoding
// so the browser decompresses it transparently — no change needed on the
// fetch() side beyond going through cbFetch() for the auth header.
//
// Query params:
//   file - "stores" or "midis" (required)
//
// Self-test (no auth needed, no data touched):
//   /.netlify/functions/map-data?selftest=1

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { requireStaff, SERVICE_KEY } = require("./_auth");

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    },
    body: JSON.stringify(obj, null, 2),
  };
}

// Netlify's bundler can place included_files at slightly different
// relative locations depending on the build (esbuild vs the legacy
// bundler), so try the likely spots rather than hard-code one and risk a
// silent 500 in production that's hard to diagnose from here.
function findDataFile(name) {
  const candidates = [
    path.join(__dirname, "data", name),
    path.join(__dirname, "..", "data", name),
    path.join(__dirname, "..", "..", "netlify", "functions", "data", name),
    path.join(process.cwd(), "netlify", "functions", "data", name),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

  const qs = event.queryStringParameters || {};

  if (qs.selftest === "1") {
    return json(200, {
      ok: true,
      world: "CLICKA-MAP-DATA",
      serviceKeySet: !!SERVICE_KEY,
      storesFileFound: !!findDataFile("stores.json"),
      midisFileFound: !!findDataFile("midis.json"),
    });
  }

  const authErr = await requireStaff(event, json);
  if (authErr) return authErr;

  const file = qs.file === "midis" ? "midis.json" : qs.file === "stores" ? "stores.json" : null;
  if (!file) return json(400, { ok: false, error: "Required param: file=stores|midis." });

  const filePath = findDataFile(file);
  if (!filePath) return json(500, { ok: false, error: "Data file not found on this deploy (" + file + ")." });

  try {
    const raw = fs.readFileSync(filePath);
    const gz = zlib.gzipSync(raw);
    return {
      statusCode: 200,
      isBase64Encoded: true,
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Cache-Control": "private, no-store",
      },
      body: gz.toString("base64"),
    };
  } catch (e) {
    return json(500, { ok: false, error: String(e.message || e) });
  }
};
