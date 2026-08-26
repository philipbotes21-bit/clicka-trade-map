// admin/netlify/functions/admin-orders.js
//
// FUNCTION — Clicka: Orders. First flow through here is Self-Order (a shop
// owner, logged in as self_order_manager, scans products in Spaza Onboard,
// builds a basket, and checks out against one Midi / Wholesaler). Shape is
// generic enough to carry the wider agent-assisted ordering flow later.
//
// POST  -> place an order.
//   body: { store_id, midi_id, items: [{ supplier_product_id, qty }, ...] }
//   Self Order Manager: store_id must match their own "store" scope.
//   Admin: can place on behalf of any store (e.g. testing, phone orders).
//   Prices are looked up server-side from clicka_supplier_products at the
//   moment of order — never trusted from the client.
//
// GET  ?store_id=...  -> list orders for a store (Self Order Manager sees
//                        only their own store; Admin can pass any store_id).
// GET  ?id=...         -> one order with its line items.
//
// Self-test (no auth needed, no data touched):
//   /.netlify/functions/admin-orders?selftest=1

const { json, sb, getCaller } = require("./_auth");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

  const qs = event.queryStringParameters || {};
  if (qs.selftest === "1") return json(200, { ok: true, world: "CLICKA-ADMIN" });

  const caller = await getCaller(event);
  if (!caller || !caller.staff) return json(401, { ok: false, error: "Not signed in." });
  if (caller.staff.status === "inactive") return json(403, { ok: false, error: "Account deactivated." });

  const role = caller.staff.role;
  if (!["admin", "self_order_manager"].includes(role)) {
    return json(403, { ok: false, error: "Orders access is limited to Admin and Self Order Manager roles for now." });
  }

  const myStoreId = role === "self_order_manager"
    ? ((caller.scope || []).find((s) => s.scope_type === "store") || {}).store_id
    : null;

  // ---------- POST: place an order ----------
  if (event.httpMethod === "POST") {
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { ok: false, error: "Invalid JSON body." }); }

    const { store_id, midi_id, items } = body;
    if (!store_id || !midi_id) return json(400, { ok: false, error: "store_id and midi_id are required." });
    if (!Array.isArray(items) || !items.length) return json(400, { ok: false, error: "At least one item is required." });

    if (role === "self_order_manager") {
      if (!myStoreId) return json(403, { ok: false, error: "No store linked to this account yet — ask an Admin to link one." });
      if (store_id !== myStoreId) return json(403, { ok: false, error: "This account can only order for its own store." });
    }

    // Confirm the chosen Midi actually services this store's sub-region —
    // defense in depth, not just relying on the app only showing valid ones.
    const storeRes = await sb("/rest/v1/clicka_registrations?id=eq." + store_id + "&select=id,region_id");
    const storeRows = await storeRes.json();
    const store = Array.isArray(storeRows) ? storeRows[0] : null;
    if (!store) return json(404, { ok: false, error: "Store not found." });

    if (store.region_id) {
      const svcRes = await sb("/rest/v1/clicka_midi_service_regions?midi_id=eq." + midi_id + "&region_id=eq." + store.region_id + "&select=id");
      const svcRows = await svcRes.json();
      if (!Array.isArray(svcRows) || !svcRows.length) {
        return json(400, { ok: false, error: "That Midi / Wholesaler doesn't service this store's sub-region." });
      }
    }

    // Price every item server-side from the live catalogue — never trust a
    // client-sent price.
    const productIds = [...new Set(items.map((i) => i.supplier_product_id).filter(Boolean))];
    if (!productIds.length) return json(400, { ok: false, error: "No valid items supplied." });

    const prodRes = await sb("/rest/v1/clicka_supplier_products?id=in.(" + productIds.join(",") + ")&select=id,description,sku,barcode,brand_id,unit_price_inc_vat");
    const products = await prodRes.json();
    const productsById = Object.fromEntries((products || []).map((p) => [p.id, p]));

    const orderItems = [];
    let total = 0;
    for (const it of items) {
      const p = productsById[it.supplier_product_id];
      if (!p) continue;
      const qty = Math.max(1, Math.round(Number(it.qty) || 1));
      const unitPrice = p.unit_price_inc_vat != null ? Number(p.unit_price_inc_vat) : null;
      const lineTotal = unitPrice != null ? Math.round(unitPrice * qty * 100) / 100 : null;
      if (lineTotal != null) total += lineTotal;
      orderItems.push({
        supplier_product_id: p.id,
        description: p.description,
        sku: p.sku,
        barcode: p.barcode,
        brand_id: p.brand_id,
        unit_price_inc_vat: unitPrice,
        qty,
        line_total: lineTotal,
      });
    }
    if (!orderItems.length) return json(400, { ok: false, error: "None of the scanned items matched the catalogue." });

    const orderRes = await sb("/rest/v1/clicka_orders", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify([{
        store_id,
        midi_id,
        placed_by_staff_id: caller.staff.id,
        total_amount: Math.round(total * 100) / 100,
      }]),
    });
    const orderRows = await orderRes.json();
    if (!orderRes.ok) return json(200, { ok: false, error: JSON.stringify(orderRows).slice(0, 300) });
    const order = orderRows[0];

    const itemsRes = await sb("/rest/v1/clicka_order_items", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(orderItems.map((i) => ({ ...i, order_id: order.id }))),
    });
    const itemRows = await itemsRes.json();
    if (!itemsRes.ok) return json(200, { ok: false, error: JSON.stringify(itemRows).slice(0, 300) });

    return json(200, { ok: true, order: { ...order, items: itemRows } });
  }

  // ---------- GET: list / detail ----------
  if (event.httpMethod === "GET") {
    if (qs.id) {
      const res = await sb("/rest/v1/clicka_orders?id=eq." + qs.id + "&select=*");
      const rows = await res.json();
      const order = Array.isArray(rows) ? rows[0] : null;
      if (!order) return json(404, { ok: false, error: "Order not found." });
      if (role === "self_order_manager" && order.store_id !== myStoreId) {
        return json(403, { ok: false, error: "This account can only view its own store's orders." });
      }
      const itemsRes = await sb("/rest/v1/clicka_order_items?order_id=eq." + qs.id + "&select=*");
      const items = await itemsRes.json();
      return json(200, { ok: true, order: { ...order, items: items || [] } });
    }

    let storeId = qs.store_id;
    if (role === "self_order_manager") {
      if (!myStoreId) return json(200, { ok: true, orders: [] });
      storeId = myStoreId;
    }
    if (!storeId) return json(400, { ok: false, error: "store_id is required." });

    const res = await sb("/rest/v1/clicka_orders?store_id=eq." + storeId + "&select=*&order=created_at.desc&limit=100");
    const orders = await res.json();
    return json(200, { ok: true, orders: orders || [] });
  }

  return json(405, { ok: false, error: "Method not allowed." });
};
