// admin/netlify/functions/admin-product-lookup.js
//
// FUNCTION — Clicka: barcode → product lookup.
// Called from Spaza Onboard right after a barcode is scanned and decoded to
// a GTIN/EAN-13 string. Searches clicka_supplier_products by barcode across
// EVERY supplier (a scan doesn't know the brand up front), joined with
// category name and brand name.
//
// GET ?barcode=6009...  -> { ok, product } or { ok:true, product:null } if
//                          nothing on file for that barcode yet.
//
// Any signed-in, active staff can call this — including self_order_manager
// (shop owners self-ordering) — it's a read-only catalog lookup.
//
// Self-test (no auth needed, no data touched):
//   /.netlify/functions/admin-product-lookup?selftest=1

const { json, sb, getCaller } = require("./_auth");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

  const qs = event.queryStringParameters || {};
  if (qs.selftest === "1") return json(200, { ok: true, world: "CLICKA-ADMIN" });

  const caller = await getCaller(event);
  if (!caller || !caller.staff) return json(401, { ok: false, error: "Not signed in." });
  if (caller.staff.status === "inactive") return json(403, { ok: false, error: "Account deactivated." });

  if (event.httpMethod !== "GET") return json(405, { ok: false, error: "Method not allowed." });

  const barcode = (qs.barcode || "").trim();
  if (!barcode) return json(400, { ok: false, error: "barcode is required." });

  const params = new URLSearchParams();
  params.set("select", "*,clicka_categories(name)");
  params.set("barcode", "eq." + barcode);
  params.set("limit", "5");

  const res = await sb("/rest/v1/clicka_supplier_products?" + params.toString());
  const rows = await res.json();
  if (!res.ok) return json(200, { ok: false, error: JSON.stringify(rows).slice(0, 300) });

  if (!Array.isArray(rows) || !rows.length) {
    return json(200, { ok: true, product: null, message: "No product on file for this barcode yet." });
  }

  const p = rows[0];
  const brandsRes = await sb("/rest/v1/bi_brands?id=eq." + p.brand_id + "&select=id,name");
  const brands = await brandsRes.json();
  const brandName = Array.isArray(brands) && brands[0] ? brands[0].name : p.brand_name;

  const product = {
    id: p.id,
    brand_id: p.brand_id,
    brand_name: brandName,
    category_name: p.clicka_categories ? p.clicka_categories.name : null,
    sku: p.sku,
    barcode: p.barcode,
    description: p.description,
    pack_size: p.pack_size,
    size: p.size,
    moq: p.moq,
    unit_price_inc_vat: p.unit_price_inc_vat,
    photo_url: p.photo_url,
  };

  return json(200, { ok: true, product });
};
