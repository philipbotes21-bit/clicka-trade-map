// admin/netlify/functions/admin-orders.js
//
// FUNCTION — Clicka: Orders. First flow through here is Self-Order (a shop
// owner, logged in as self_order_manager, scans products in Spaza Onboard,
// builds a basket, and checks out against one Midi / Wholesaler). Shape is
// generic enough to carry the wider agent-assisted ordering flow later.
//
// Every order gets a human-readable order_number (CLK-100001, ...) assigned
// by the database on insert — that's what gets traced/quoted, not the uuid.
//
// POST  -> place an order.
//   body: { store_id, midi_id, items: [{ supplier_product_id, qty }, ...] }
//   Self Order Manager: store_id must match their own "store" scope.
//   Admin: can place on behalf of any store (e.g. testing, phone orders).
//   Prices are looked up server-side from clicka_supplier_products at the
//   moment of order — never trusted from the client.
//
// GET  (no params)    -> back-office list, scoped by role:
//                        Admin sees everything. Agent sees orders for stores
//                        THEY captured. PPM Agent sees orders for the Midi(s)
//                        they're assigned to. Supervisor / Regional Manager
//                        see orders for stores within their province(s).
//                        Self Order Manager sees only their own store's orders.
// GET  ?store_id=...  -> orders for one store (Admin only, e.g. from a store
//                        detail view).
// GET  ?id=...         -> one order with its line items.
//
// Self-test (no auth needed, no data touched):
//   /.netlify/functions/admin-orders?selftest=1

const { json, sb, getCaller } = require("./_auth");

async function resolveScopeProvinces(scope) {
  const direct = scope.filter((s) => s.scope_type === "province").map((s) => s.province);
  const regionIds = scope.filter((s) => s.scope_type === "region").map((s) => s.region_id);
  if (!regionIds.length) return [...new Set(direct)];
  const res = await sb("/rest/v1/bi_regions?id=in.(" + regionIds.join(",") + ")&select=id,province");
  const rows = await res.json();
  const fromRegions = Array.isArray(rows) ? rows.map((r) => r.province) : [];
  return [...new Set([...direct, ...fromRegions])].filter(Boolean);
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

  const qs = event.queryStringParameters || {};
  if (qs.selftest === "1") return json(200, { ok: true, world: "CLICKA-ADMIN" });

  const caller = await getCaller(event);
  if (!caller || !caller.staff) return json(401, { ok: false, error: "Not signed in." });
  if (caller.staff.status === "inactive") return json(403, { ok: false, error: "Account deactivated." });

  const role = caller.staff.role;
  if (!["admin", "self_order_manager", "agent", "ppm_agent", "supervisor", "regional_manager"].includes(role)) {
    return json(403, { ok: false, error: "This account isn't set up to view Orders." });
  }

  const myStoreId = role === "self_order_manager"
    ? ((caller.scope || []).find((s) => s.scope_type === "store") || {}).store_id
    : null;

  // ---------- POST: place an order ----------
  if (event.httpMethod === "POST") {
    if (!["admin", "self_order_manager"].includes(role)) {
      return json(403, { ok: false, error: "Placing orders is limited to Admin and Self Order Manager for now." });
    }
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

    // Price every item server-side from THIS MIDI'S price list — never trust
    // a client-sent price, and never fall back to the generic catalogue
    // price. Every Midi sets its own price; 0 or missing means that Midi
    // doesn't carry it, and the order is rejected rather than silently
    // dropping or mispricing the item.
    const productIds = [...new Set(items.map((i) => i.supplier_product_id).filter(Boolean))];
    if (!productIds.length) return json(400, { ok: false, error: "No valid items supplied." });

    const prodRes = await sb("/rest/v1/clicka_supplier_products?id=in.(" + productIds.join(",") + ")&select=id,description,sku,barcode,brand_id");
    const products = await prodRes.json();
    const productsById = Object.fromEntries((products || []).map((p) => [p.id, p]));

    const midiPriceRes = await sb("/rest/v1/clicka_midi_products?midi_id=eq." + midi_id + "&supplier_product_id=in.(" + productIds.join(",") + ")&select=supplier_product_id,price_inc_vat");
    const midiPriceRows = await midiPriceRes.json();
    const priceByProductId = Object.fromEntries((Array.isArray(midiPriceRows) ? midiPriceRows : []).map((r) => [r.supplier_product_id, Number(r.price_inc_vat) || 0]));

    const orderItems = [];
    const unavailable = [];
    let total = 0;
    for (const it of items) {
      const p = productsById[it.supplier_product_id];
      if (!p) continue;
      const unitPrice = priceByProductId[it.supplier_product_id] || 0;
      if (unitPrice <= 0) { unavailable.push(p.description || p.sku || p.barcode || it.supplier_product_id); continue; }
      const qty = Math.max(1, Math.round(Number(it.qty) || 1));
      const lineTotal = Math.round(unitPrice * qty * 100) / 100;
      total += lineTotal;
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
    if (unavailable.length) {
      return json(400, { ok: false, error: "Not available at this Midi / Wholesaler: " + unavailable.join(", ") + ". Remove these items or choose a different Midi." });
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
    // ---- one order, with line items ----
    if (qs.id) {
      const res = await sb("/rest/v1/clicka_orders?id=eq." + qs.id + "&select=*,clicka_registrations(trading_name,province,region_id,staff_id),clicka_midis(name)");
      const rows = await res.json();
      const order = Array.isArray(rows) ? rows[0] : null;
      if (!order) return json(404, { ok: false, error: "Order not found." });

      if (role === "self_order_manager" && order.store_id !== myStoreId) {
        return json(403, { ok: false, error: "This account can only view its own store's orders." });
      }
      if (role === "agent" && (!order.clicka_registrations || order.clicka_registrations.staff_id !== caller.staff.id)) {
        return json(403, { ok: false, error: "This order wasn't placed by your store." });
      }
      if (role === "ppm_agent") {
        const myMidiIds = (caller.scope || []).filter((s) => s.scope_type === "midi").map((s) => s.midi_id);
        if (!myMidiIds.includes(order.midi_id)) {
          return json(403, { ok: false, error: "This order isn't for a Midi assigned to you." });
        }
      }
      if (["supervisor", "regional_manager"].includes(role)) {
        const allowedProvinces = await resolveScopeProvinces(caller.scope || []);
        const storeProvince = order.clicka_registrations ? order.clicka_registrations.province : null;
        if (!allowedProvinces.includes(storeProvince)) {
          return json(403, { ok: false, error: "This order is outside your assigned region." });
        }
      }

      const itemsRes = await sb("/rest/v1/clicka_order_items?order_id=eq." + qs.id + "&select=*");
      const items = await itemsRes.json();
      return json(200, {
        ok: true,
        order: {
          ...order,
          store_name: order.clicka_registrations ? order.clicka_registrations.trading_name : null,
          midi_name: order.clicka_midis ? order.clicka_midis.name : null,
          items: items || [],
        },
      });
    }

    // ---- Admin, single-store lookup (e.g. from a Store detail view) ----
    if (qs.store_id && role === "admin") {
      const res = await sb("/rest/v1/clicka_orders?store_id=eq." + qs.store_id + "&select=*&order=created_at.desc&limit=100");
      const orders = await res.json();
      return json(200, { ok: true, orders: orders || [] });
    }

    // ---- Self Order Manager: only their own store ----
    if (role === "self_order_manager") {
      if (!myStoreId) return json(200, { ok: true, orders: [] });
      const res = await sb("/rest/v1/clicka_orders?store_id=eq." + myStoreId + "&select=*&order=created_at.desc&limit=100");
      const orders = await res.json();
      return json(200, { ok: true, orders: orders || [] });
    }

    // ---- Back-office scoped list: Admin / Agent / PPM Agent / Supervisor / Regional Manager ----
    const params = new URLSearchParams();
    params.set("select", "*,clicka_registrations(trading_name,province,region_id,staff_id),clicka_midis(name)");
    params.set("order", "created_at.desc");
    params.set("limit", "300");
    if (qs.status) params.set("status", "eq." + qs.status);

    const res = await sb("/rest/v1/clicka_orders?" + params.toString());
    let orders = await res.json();
    if (!res.ok) return json(200, { ok: false, error: JSON.stringify(orders).slice(0, 300) });
    orders = Array.isArray(orders) ? orders : [];

    if (role === "agent") {
      orders = orders.filter((o) => o.clicka_registrations && o.clicka_registrations.staff_id === caller.staff.id);
    } else if (role === "ppm_agent") {
      const myMidiIds = (caller.scope || []).filter((s) => s.scope_type === "midi").map((s) => s.midi_id);
      orders = orders.filter((o) => myMidiIds.includes(o.midi_id));
    } else if (["supervisor", "regional_manager"].includes(role)) {
      const allowedProvinces = await resolveScopeProvinces(caller.scope || []);
      orders = orders.filter((o) => o.clicka_registrations && allowedProvinces.includes(o.clicka_registrations.province));
    }
    // admin: unfiltered

    const enriched = orders.map((o) => ({
      ...o,
      store_name: o.clicka_registrations ? o.clicka_registrations.trading_name : null,
      midi_name: o.clicka_midis ? o.clicka_midis.name : null,
    }));

    return json(200, { ok: true, orders: enriched });
  }

  return json(405, { ok: false, error: "Method not allowed." });
};
