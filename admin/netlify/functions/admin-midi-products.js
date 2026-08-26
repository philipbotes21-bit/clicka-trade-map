// admin/netlify/functions/admin-midi-products.js
//
// FUNCTION — per-Midi product list & pricing. Each Midi / Wholesaler sets
// its own price for every product it carries. A product with no row here,
// or a price of 0, is NOT available at that Midi — that's the rule PPM
// Agents work to (their job is loading real prices for what they stock).
//
// GET  ?midi_id=X                    -> full manage list for that Midi
//                                       (every catalog product, with catalog
//                                       price + this Midi's price, 0 if unset).
//                                       Admin/Supervisor/Regional Manager: any
//                                       Midi. PPM Agent: only Midis in their
//                                       scope.
// GET  ?midi_id=X&check=1&ids=a,b,c  -> lightweight availability/price check
//                                       for a specific set of supplier_product
//                                       ids, used by Spaza Onboard checkout.
//                                       Open to any signed-in staff (incl.
//                                       Self Order Manager) — no full price
//                                       list exposed, just the asked-for ids.
//
// POST ?pull_in=1   { midi_id, supplier_product_ids: [...] }
//   Adds rows for products this Midi doesn't have yet, price starts at 0
//   (not available) — PPM Agent then loads real prices. Existing rows are
//   left untouched.
//
// PATCH             { midi_id, supplier_product_id, price_inc_vat }
//   Single price edit (upsert).
//
// POST ?bulk_price_import=1  { midi_id, match_field: "barcode"|"sku", rows: [{match_value, price}] }
//   Bulk price update from the exported Excel sheet (matched by barcode or
//   sku). A row also pulls the product into this Midi's list if it wasn't
//   there yet — the export sheet includes the whole catalog, so re-importing
//   it is how you both add and re-price in one go.
//
// Self-test (no auth needed, no data touched):
//   /.netlify/functions/admin-midi-products?selftest=1

const { json, sb, getCaller } = require("./_auth");

const MANAGE_ROLES = ["admin", "supervisor", "regional_manager", "ppm_agent"];

async function myMidiIds(caller) {
  return (caller.scope || []).filter((s) => s.scope_type === "midi").map((s) => s.midi_id);
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

  const qs = event.queryStringParameters || {};
  if (qs.selftest === "1") return json(200, { ok: true, world: "CLICKA-ADMIN" });

  const caller = await getCaller(event);
  if (!caller || !caller.staff) return json(401, { ok: false, error: "Not signed in." });
  if (caller.staff.status === "inactive") return json(403, { ok: false, error: "Account deactivated." });

  const role = caller.staff.role;

  // ---------- GET: availability/price check for a specific set of ids ----------
  // Open to any signed-in staff — this is what Self Order Manager checkout uses.
  if (event.httpMethod === "GET" && qs.check === "1") {
    if (!qs.midi_id) return json(400, { ok: false, error: "midi_id is required." });
    const ids = (qs.ids || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!ids.length) return json(200, { ok: true, items: [] });

    const res = await sb(
      "/rest/v1/clicka_midi_products?midi_id=eq." + qs.midi_id +
      "&supplier_product_id=in.(" + ids.join(",") + ")&select=supplier_product_id,price_inc_vat"
    );
    const rows = await res.json();
    const byId = {};
    for (const r of Array.isArray(rows) ? rows : []) byId[r.supplier_product_id] = Number(r.price_inc_vat) || 0;

    const items = ids.map((id) => ({
      supplier_product_id: id,
      price_inc_vat: byId[id] || 0,
      available: !!byId[id] && byId[id] > 0,
    }));
    return json(200, { ok: true, items });
  }

  // Everything else (full manage list, pull-in, price edits, bulk import) is
  // limited to the roles that actually manage a Midi's pricing.
  if (!MANAGE_ROLES.includes(role)) {
    return json(403, { ok: false, error: "Midi product & pricing management is limited to Admin, Supervisor, Regional Manager, and PPM Agent." });
  }

  async function assertCanManage(midiId) {
    if (role === "ppm_agent") {
      const mine = await myMidiIds(caller);
      if (!mine.includes(midiId)) return "This Midi isn't assigned to you.";
    }
    return null;
  }

  // ---------- GET: full manage list for one Midi ----------
  if (event.httpMethod === "GET") {
    if (!qs.midi_id) return json(400, { ok: false, error: "midi_id is required." });
    const denyReason = await assertCanManage(qs.midi_id);
    if (denyReason) return json(403, { ok: false, error: denyReason });

    const params = new URLSearchParams();
    params.set("select", "id,sku,barcode,description,pack_size,size,unit_price_inc_vat,brand_id,category_id");
    params.set("order", "description");
    if (qs.search) {
      const s = qs.search.trim();
      params.set("or", "(description.ilike.*" + s + "*,sku.ilike.*" + s + "*,barcode.ilike.*" + s + "*)");
    }
    const prodRes = await sb("/rest/v1/clicka_supplier_products?" + params.toString());
    const products = await prodRes.json();

    const midiRes = await sb("/rest/v1/clicka_midi_products?midi_id=eq." + qs.midi_id + "&select=supplier_product_id,price_inc_vat,updated_at");
    const midiRows = await midiRes.json();
    const midiById = {};
    for (const r of Array.isArray(midiRows) ? midiRows : []) midiById[r.supplier_product_id] = r;

    const brandsRes = await sb("/rest/v1/bi_brands?select=id,name");
    const brands = await brandsRes.json();
    const brandsById = Object.fromEntries((brands || []).map((b) => [b.id, b.name]));

    const items = (Array.isArray(products) ? products : []).map((p) => {
      const midiRow = midiById[p.id];
      return {
        supplier_product_id: p.id,
        sku: p.sku,
        barcode: p.barcode,
        description: p.description,
        pack_size: p.pack_size,
        size: p.size,
        brand_name: brandsById[p.brand_id] || null,
        catalog_price: p.unit_price_inc_vat,
        in_midi_list: !!midiRow,
        price_inc_vat: midiRow ? Number(midiRow.price_inc_vat) || 0 : 0,
        available: !!midiRow && Number(midiRow.price_inc_vat) > 0,
      };
    });

    return json(200, { ok: true, items });
  }

  // ---------- POST: pull products into this Midi's list ----------
  if (event.httpMethod === "POST" && qs.pull_in === "1") {
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { ok: false, error: "Invalid JSON body." }); }
    const { midi_id, supplier_product_ids } = body;
    if (!midi_id) return json(400, { ok: false, error: "midi_id is required." });
    if (!Array.isArray(supplier_product_ids) || !supplier_product_ids.length) {
      return json(400, { ok: false, error: "At least one product is required." });
    }
    const denyReason = await assertCanManage(midi_id);
    if (denyReason) return json(403, { ok: false, error: denyReason });

    const existingRes = await sb("/rest/v1/clicka_midi_products?midi_id=eq." + midi_id + "&select=supplier_product_id");
    const existingRows = await existingRes.json();
    const existingIds = new Set((Array.isArray(existingRows) ? existingRows : []).map((r) => r.supplier_product_id));

    const toInsert = [...new Set(supplier_product_ids)]
      .filter((id) => !existingIds.has(id))
      .map((id) => ({ midi_id, supplier_product_id: id, price_inc_vat: 0, updated_by_staff_id: caller.staff.id }));

    if (!toInsert.length) return json(200, { ok: true, added: 0, skipped: supplier_product_ids.length });

    const insRes = await sb("/rest/v1/clicka_midi_products", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(toInsert),
    });
    const insRows = await insRes.json();
    if (!insRes.ok) return json(200, { ok: false, error: JSON.stringify(insRows).slice(0, 300) });

    return json(200, { ok: true, added: toInsert.length, skipped: supplier_product_ids.length - toInsert.length });
  }

  // ---------- PATCH: single price edit ----------
  if (event.httpMethod === "PATCH") {
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { ok: false, error: "Invalid JSON body." }); }
    const { midi_id, supplier_product_id, price_inc_vat } = body;
    if (!midi_id || !supplier_product_id) return json(400, { ok: false, error: "midi_id and supplier_product_id are required." });
    const denyReason = await assertCanManage(midi_id);
    if (denyReason) return json(403, { ok: false, error: denyReason });

    const price = price_inc_vat == null || price_inc_vat === "" ? 0 : Math.max(0, Number(price_inc_vat) || 0);

    const upsertRes = await sb("/rest/v1/clicka_midi_products?on_conflict=midi_id,supplier_product_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify([{ midi_id, supplier_product_id, price_inc_vat: price, updated_by_staff_id: caller.staff.id, updated_at: new Date().toISOString() }]),
    });
    const rows = await upsertRes.json();
    if (!upsertRes.ok) return json(200, { ok: false, error: JSON.stringify(rows).slice(0, 300) });

    return json(200, { ok: true, item: rows[0] });
  }

  // ---------- POST: bulk price import ----------
  if (event.httpMethod === "POST" && qs.bulk_price_import === "1") {
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { ok: false, error: "Invalid JSON body." }); }
    const { midi_id, match_field, rows } = body;
    if (!midi_id) return json(400, { ok: false, error: "midi_id is required." });
    if (!["barcode", "sku"].includes(match_field)) return json(400, { ok: false, error: "match_field must be barcode or sku." });
    if (!Array.isArray(rows) || !rows.length) return json(400, { ok: false, error: "No rows to import." });
    const denyReason = await assertCanManage(midi_id);
    if (denyReason) return json(403, { ok: false, error: denyReason });

    // Resolve match_value -> supplier_product_id via the catalog.
    const values = [...new Set(rows.map((r) => String(r.match_value || "").trim()).filter(Boolean))];
    if (!values.length) return json(400, { ok: false, error: "No valid rows to import." });

    const inList = values.map((v) => '"' + v.replace(/"/g, '\\"') + '"').join(",");
    const prodRes = await sb("/rest/v1/clicka_supplier_products?" + match_field + "=in.(" + inList + ")&select=id," + match_field);
    const products = await prodRes.json();
    const idByValue = {};
    for (const p of Array.isArray(products) ? products : []) idByValue[p[match_field]] = p.id;

    const updated = [];
    const notFound = [];
    const toUpsert = [];

    for (const r of rows) {
      const val = String(r.match_value || "").trim();
      const productId = idByValue[val];
      if (!productId) { notFound.push(val); continue; }
      const price = Math.max(0, Number(r.price) || 0);
      toUpsert.push({ midi_id, supplier_product_id: productId, price_inc_vat: price, updated_by_staff_id: caller.staff.id, updated_at: new Date().toISOString() });
      updated.push(val);
    }

    if (toUpsert.length) {
      const upRes = await sb("/rest/v1/clicka_midi_products?on_conflict=midi_id,supplier_product_id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify(toUpsert),
      });
      const upRows = await upRes.json();
      if (!upRes.ok) return json(200, { ok: false, error: JSON.stringify(upRows).slice(0, 300) });
    }

    return json(200, { ok: true, updated: updated.length, notFound });
  }

  return json(405, { ok: false, error: "Method not allowed." });
};
