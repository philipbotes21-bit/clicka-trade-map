// admin/netlify/functions/admin-suppliers.js
//
// FUNCTION — Clicka Admin: Suppliers list (bi_brands — same table the BI
// reports already use for Tiger Brands / Unilever). Categories and
// Supplier Products are both scoped by supplier, so this is the picker
// list for both, plus the "add a new supplier" action.
//
// Suppliers ARE the Clients — the same bi_brands row a Unilever product
// belongs to is what staff get assigned to for in-app branding (see
// admin-users.js scope_type "brand" and admin-whoami's clientBrand).
//
// GET    -> list every supplier
// POST   -> add a new supplier {name}
// PATCH ?logo=1  -> set/replace a supplier's logo {id, photo_base64, photo_content_type}
//
// Admin-only.
//
// Self-test (no auth needed, no data touched):
//   /.netlify/functions/admin-suppliers?selftest=1

const { SUPABASE_URL, SERVICE_KEY, json, sb, getCaller } = require("./_auth");

const LOGO_BUCKET = "clicka-brand-logos";

function extFromContentType(ct) {
  if (!ct) return "jpg";
  if (ct.includes("png")) return "png";
  if (ct.includes("webp")) return "webp";
  if (ct.includes("svg")) return "svg";
  return "jpg";
}

async function uploadBrandLogo(brandId, base64, contentType) {
  const path = "brand-" + brandId + "." + extFromContentType(contentType);
  const bytes = Buffer.from(base64, "base64");
  const res = await fetch(SUPABASE_URL + "/storage/v1/object/" + LOGO_BUCKET + "/" + path, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + SERVICE_KEY,
      apikey: SERVICE_KEY,
      "Content-Type": contentType || "image/jpeg",
      "x-upsert": "true",
    },
    body: bytes,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error("Logo upload failed: " + res.status + " " + t.slice(0, 200));
  }
  // Cache-bust so a replaced logo shows immediately instead of the old
  // cached image (same path every time by design, for a stable URL).
  return SUPABASE_URL + "/storage/v1/object/public/" + LOGO_BUCKET + "/" + path + "?t=" + Date.now();
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

  const qs = event.queryStringParameters || {};
  if (qs.selftest === "1") return json(200, { ok: true, world: "CLICKA-ADMIN" });

  const caller = await getCaller(event);
  if (!caller || !caller.staff) return json(401, { ok: false, error: "Not signed in." });
  if (caller.staff.status === "inactive") return json(403, { ok: false, error: "Account deactivated." });

  // GET (the supplier picker list) is open to Admin, Supervisor, and Regional
  // Manager — Midi/Wholesaler brand-scope selection needs it too, same trio
  // as Stores and Midis. Creating a new supplier stays Admin-only below.
  if (!["admin", "supervisor", "regional_manager"].includes(caller.staff.role)) {
    return json(403, { ok: false, error: "Admin access only." });
  }

  if (event.httpMethod === "GET") {
    const res = await sb("/rest/v1/bi_brands?select=*&order=name");
    const suppliers = await res.json();
    return json(200, { ok: true, suppliers: suppliers || [] });
  }

  if (event.httpMethod === "POST") {
    if (caller.staff.role !== "admin") return json(403, { ok: false, error: "Admin access only." });
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { ok: false, error: "Invalid JSON body." }); }
    if (!body.name || !String(body.name).trim()) return json(400, { ok: false, error: "Supplier name is required." });

    const res = await sb("/rest/v1/bi_brands", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify([{ name: String(body.name).trim() }]),
    });
    const rows = await res.json();
    if (!res.ok) return json(200, { ok: false, error: JSON.stringify(rows).slice(0, 300) });
    return json(200, { ok: true, supplier: rows[0] });
  }

  if (event.httpMethod === "PATCH" && qs.logo === "1") {
    if (caller.staff.role !== "admin") return json(403, { ok: false, error: "Admin access only." });
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { ok: false, error: "Invalid JSON body." }); }
    if (!body.id) return json(400, { ok: false, error: "id is required." });
    if (!body.photo_base64) return json(400, { ok: false, error: "photo_base64 is required." });

    let logoUrl;
    try {
      logoUrl = await uploadBrandLogo(body.id, body.photo_base64, body.photo_content_type);
    } catch (e) {
      return json(200, { ok: false, error: String(e.message || e).slice(0, 300) });
    }

    const res = await sb("/rest/v1/bi_brands?id=eq." + body.id, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ logo_url: logoUrl }),
    });
    const rows = await res.json();
    if (!res.ok) return json(200, { ok: false, error: JSON.stringify(rows).slice(0, 300) });
    return json(200, { ok: true, supplier: rows[0] });
  }

  return json(405, { ok: false, error: "Method not allowed." });
};
