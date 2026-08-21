// admin/netlify/functions/admin-supplier-products.js
//
// FUNCTION — Clicka Admin: Supplier Products (per-supplier product master
// catalog). Deliberately a NEW table (clicka_supplier_products), separate
// from bi_products (which the Products BI tab reads from, derived from
// actual Sales Out order-item history and left untouched here). This one
// is the curated master list Admin loads/maintains directly — SKUs a
// supplier sells, whether or not they've ever been ordered yet.
//
// GET    ?brand_id=1                    -> list products for that supplier
//        &category_id=...&search=...    -> optional filters
// POST                                   -> create ONE product (may include
//                                           photo_base64 + photo_content_type)
// POST   ?bulk=1                         -> import many rows at once
//        body: { brand_id, rows: [{category, sku, barcode, brand, description,
//                pack_size, size, moq, unit_price_inc_vat}, ...] }
//        Unknown category names are created automatically.
// POST   ?bulk_photos=1                  -> batch-attach photos, matched by
//        barcode or SKU (varies per brand)
//        body: { brand_id, match_field: "barcode"|"sku",
//                photos: [{ match_value, base64, content_type }, ...] }
// PATCH  ?id=...                         -> update a product (may include
//                                           photo_base64 + photo_content_type)
//
// Product photos live in the PUBLIC "clicka-product-photos" storage bucket
// (separate from the private clicka-uploads bucket used for store owner /
// compliance photos) — they need to be viewable from Clicka Admin today and
// the onboarding app's ordering screens later, without a signed-URL round
// trip every time.
//
// Admin-only for now (same as Users / Categories).
//
// Self-test (no auth needed, no data touched):
//   /.netlify/functions/admin-supplier-products?selftest=1

const { json, sb, getCaller, SUPABASE_URL, SERVICE_KEY } = require("./_auth");

const PHOTO_BUCKET = "clicka-product-photos";

async function requireAdmin(event) {
  const caller = await getCaller(event);
  if (!caller || !caller.staff) return { error: json(401, { ok: false, error: "Not signed in." }) };
  if (caller.staff.status === "inactive") return { error: json(403, { ok: false, error: "Account deactivated." }) };
  if (caller.staff.role !== "admin") return { error: json(403, { ok: false, error: "Admin access only." }) };
  return { caller };
}

function toNum(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function toInt(v) {
  const n = toNum(v);
  return n === null ? null : Math.round(n);
}

function extFromContentType(ct) {
  if (!ct) return "jpg";
  if (ct.includes("png")) return "png";
  if (ct.includes("webp")) return "webp";
  if (ct.includes("gif")) return "gif";
  return "jpg";
}

// Slugify a barcode/SKU into a safe storage path segment.
function slugForPath(v) {
  return String(v).trim().replace(/[^a-zA-Z0-9_.-]/g, "_");
}

async function uploadProductPhoto(path, base64, contentType) {
  const bytes = Buffer.from(base64, "base64");
  const res = await fetch(SUPABASE_URL + "/storage/v1/object/" + PHOTO_BUCKET + "/" + path, {
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
    throw new Error("Photo upload failed for " + path + ": " + res.status + " " + t.slice(0, 200));
  }
  return SUPABASE_URL + "/storage/v1/object/public/" + PHOTO_BUCKET + "/" + path;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

  const qs = event.queryStringParameters || {};
  if (qs.selftest === "1") return json(200, { ok: true, world: "CLICKA-ADMIN" });

  const gate = await requireAdmin(event);
  if (gate.error) return gate.error;

  // ---------- GET: list ----------
  if (event.httpMethod === "GET") {
    if (!qs.brand_id) return json(400, { ok: false, error: "brand_id is required." });

    const params = new URLSearchParams();
    params.set("select", "*,clicka_categories(name)");
    params.set("order", "description");
    params.set("limit", "500");
    params.set("brand_id", "eq." + qs.brand_id);
    if (qs.category_id) params.set("category_id", "eq." + qs.category_id);
    if (qs.search) {
      const term = qs.search.replace(/[,()]/g, "");
      params.set("or", "(description.ilike.*" + term + "*,sku.ilike.*" + term + "*,barcode.ilike.*" + term + "*)");
    }

    const res = await sb("/rest/v1/clicka_supplier_products?" + params.toString(), { headers: { Prefer: "count=exact" } });
    const rows = await res.json();
    const contentRange = res.headers.get("content-range");
    const total = contentRange ? Number(contentRange.split("/")[1]) : (rows || []).length;
    const products = (rows || []).map((r) => ({ ...r, category_name: r.clicka_categories ? r.clicka_categories.name : null }));
    return json(200, { ok: true, products, total });
  }

  // ---------- POST: create one, or bulk import ----------
  if (event.httpMethod === "POST") {
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { ok: false, error: "Invalid JSON body." }); }

    if (qs.bulk === "1") {
      const { brand_id, rows } = body;
      if (!brand_id || !Array.isArray(rows) || !rows.length) {
        return json(400, { ok: false, error: "brand_id and a non-empty rows array are required." });
      }

      // 1. Make sure every category name in this batch exists for this supplier.
      const catNames = [...new Set(rows.map((r) => (r.category || "").trim()).filter(Boolean))];
      const existingCatRes = await sb("/rest/v1/clicka_categories?brand_id=eq." + brand_id + "&select=id,name");
      const existingCats = await existingCatRes.json();
      const catByName = Object.fromEntries((existingCats || []).map((c) => [c.name.toLowerCase(), c.id]));

      const missing = catNames.filter((n) => !catByName[n.toLowerCase()]);
      if (missing.length) {
        const createRes = await sb("/rest/v1/clicka_categories?on_conflict=brand_id,name", {
          method: "POST",
          headers: { Prefer: "return=representation,resolution=merge-duplicates" },
          body: JSON.stringify(missing.map((name) => ({ brand_id, name }))),
        });
        const created = await createRes.json();
        for (const c of created || []) catByName[c.name.toLowerCase()] = c.id;
      }

      // 2. Upsert every row, matched on (brand_id, barcode).
      const payload = rows
        .filter((r) => r.description && r.barcode)
        .map((r) => ({
          brand_id,
          category_id: r.category ? catByName[String(r.category).trim().toLowerCase()] || null : null,
          sku: r.sku ? String(r.sku).trim() : null,
          barcode: String(r.barcode).trim(),
          brand_name: r.brand ? String(r.brand).trim() : null,
          description: String(r.description).trim(),
          pack_size: r.pack_size != null ? String(r.pack_size).trim() : null,
          size: r.size != null ? String(r.size).trim() : null,
          moq: toInt(r.moq),
          unit_price_inc_vat: toNum(r.unit_price_inc_vat),
          updated_at: new Date().toISOString(),
        }));

      if (!payload.length) return json(400, { ok: false, error: "No valid rows (each needs at least a description and barcode)." });

      const CHUNK = 500;
      let imported = 0;
      for (let i = 0; i < payload.length; i += CHUNK) {
        const chunk = payload.slice(i, i + CHUNK);
        const upsertRes = await sb("/rest/v1/clicka_supplier_products?on_conflict=brand_id,barcode", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates" },
          body: JSON.stringify(chunk),
        });
        if (!upsertRes.ok) {
          const t = await upsertRes.text();
          return json(200, { ok: false, stage: "upsert", imported, error: t.slice(0, 400) });
        }
        imported += chunk.length;
      }

      return json(200, { ok: true, imported, skipped: rows.length - payload.length, categoriesCreated: missing.length });
    }

    // ---------- bulk photo import: batch of images matched by barcode or SKU ----------
    if (qs.bulk_photos === "1") {
      const { brand_id, match_field, photos } = body;
      if (!brand_id) return json(400, { ok: false, error: "brand_id is required." });
      if (!["barcode", "sku"].includes(match_field)) return json(400, { ok: false, error: "match_field must be \"barcode\" or \"sku\"." });
      if (!Array.isArray(photos) || !photos.length) return json(400, { ok: false, error: "No photos supplied." });

      let updated = 0;
      const notFound = [];
      const failed = [];

      for (const p of photos) {
        if (!p || !p.match_value || !p.base64) { failed.push((p && p.match_value) || "(unnamed)"); continue; }
        const matchValue = String(p.match_value).trim();
        try {
          const ext = extFromContentType(p.content_type);
          const path = brand_id + "/" + slugForPath(matchValue) + "." + ext;
          const photoUrl = await uploadProductPhoto(path, p.base64, p.content_type);

          const patchRes = await sb(
            "/rest/v1/clicka_supplier_products?brand_id=eq." + brand_id + "&" + match_field + "=eq." + encodeURIComponent(matchValue),
            {
              method: "PATCH",
              headers: { Prefer: "return=representation" },
              body: JSON.stringify({ photo_url: photoUrl, updated_at: new Date().toISOString() }),
            }
          );
          const patched = await patchRes.json();
          if (!patchRes.ok) { failed.push(matchValue); continue; }
          if (!Array.isArray(patched) || !patched.length) { notFound.push(matchValue); continue; }
          updated += patched.length;
        } catch (e) {
          failed.push(matchValue);
        }
      }

      return json(200, { ok: true, updated, notFound, failed });
    }

    // Single create
    if (!body.brand_id || !body.description || !body.barcode) {
      return json(400, { ok: false, error: "brand_id, description, and barcode are required." });
    }

    let photoUrl = null;
    if (body.photo_base64) {
      const ext = extFromContentType(body.photo_content_type);
      const path = body.brand_id + "/" + slugForPath(body.barcode) + "." + ext;
      photoUrl = await uploadProductPhoto(path, body.photo_base64, body.photo_content_type);
    }

    const res = await sb("/rest/v1/clicka_supplier_products?on_conflict=brand_id,barcode", {
      method: "POST",
      headers: { Prefer: "return=representation,resolution=merge-duplicates" },
      body: JSON.stringify([{
        brand_id: body.brand_id,
        category_id: body.category_id || null,
        sku: body.sku || null,
        barcode: body.barcode,
        brand_name: body.brand_name || null,
        description: body.description,
        pack_size: body.pack_size || null,
        size: body.size || null,
        moq: toInt(body.moq),
        unit_price_inc_vat: toNum(body.unit_price_inc_vat),
        ...(photoUrl ? { photo_url: photoUrl } : {}),
      }]),
    });
    const rows = await res.json();
    if (!res.ok) return json(200, { ok: false, error: JSON.stringify(rows).slice(0, 300) });
    return json(200, { ok: true, product: rows[0] });
  }

  // ---------- PATCH: update ----------
  if (event.httpMethod === "PATCH") {
    if (!qs.id) return json(400, { ok: false, error: "Missing id." });
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { ok: false, error: "Invalid JSON body." }); }

    const patch = { updated_at: new Date().toISOString() };
    for (const f of ["category_id", "sku", "barcode", "brand_name", "description", "pack_size", "size"]) {
      if (body[f] !== undefined) patch[f] = body[f];
    }
    if (body.moq !== undefined) patch.moq = toInt(body.moq);
    if (body.unit_price_inc_vat !== undefined) patch.unit_price_inc_vat = toNum(body.unit_price_inc_vat);

    if (body.photo_base64) {
      // Need brand_id + barcode for the storage path — fetch the current row.
      const curRes = await sb("/rest/v1/clicka_supplier_products?id=eq." + qs.id + "&select=brand_id,barcode");
      const curRows = await curRes.json();
      const cur = Array.isArray(curRows) ? curRows[0] : null;
      if (!cur) return json(404, { ok: false, error: "Product not found." });
      const brandIdForPath = patch.brand_id || cur.brand_id;
      const barcodeForPath = patch.barcode || cur.barcode;
      const ext = extFromContentType(body.photo_content_type);
      const path = brandIdForPath + "/" + slugForPath(barcodeForPath) + "." + ext;
      patch.photo_url = await uploadProductPhoto(path, body.photo_base64, body.photo_content_type);
    }

    const res = await sb("/rest/v1/clicka_supplier_products?id=eq." + qs.id, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(patch),
    });
    const rows = await res.json();
    if (!res.ok) return json(200, { ok: false, error: JSON.stringify(rows).slice(0, 300) });
    return json(200, { ok: true, product: rows[0] });
  }

  return json(405, { ok: false, error: "Method not allowed." });
};
