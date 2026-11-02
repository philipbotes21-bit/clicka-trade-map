// admin/netlify/functions/admin-payments.js
//
// FUNCTION — Shop2Shop payments received into Clicka's wallet (fed by the
// always-on listener in the s2s-listener folder), and how each one was matched
// to an order. Admin only: this is company money.
//
// GET  ?status=attention|matched|all (default attention) &search= &from= &to=
//        -> { payments:[...], counts:{...}, totals:{...} }
//      "attention" = payments that need a human: unmatched, ambiguous,
//        amount_mismatch, duplicate_payment.
// GET  ?find_order=CLK-100001 (or part)
//        -> up to 10 orders with amount due and whether already paid
//      (used to assign an unmatched payment by hand)
// PATCH { txn_id, action: "assign", order_id, note? }  -> match by hand
//       { txn_id, action: "dismiss", note }            -> mark as not ours / handled elsewhere
//      Both are recorded with who did it and when.
//
// Nothing here changes an order's status. Payment state is shown beside the
// order; releasing money to a Midi is a separate, later step.
//
// Self-test: /.netlify/functions/admin-payments?selftest=1

const { json, sb, getCaller } = require("./_auth");

const ATTENTION = ["unmatched", "ambiguous", "amount_mismatch", "duplicate_payment"];

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });
  const qs = event.queryStringParameters || {};
  if (qs.selftest === "1") return json(200, { ok: true, world: "CLICKA-ADMIN-PAYMENTS" });

  const caller = await getCaller(event);
  if (!caller || !caller.staff) return json(401, { ok: false, error: "Not signed in." });
  if (caller.staff.status === "inactive") return json(403, { ok: false, error: "Account deactivated." });
  if (caller.staff.role !== "admin") return json(403, { ok: false, error: "Payments are Admin only." });

  // ---------- GET ----------
  if (event.httpMethod === "GET") {
    if (qs.find_order) {
      const q = String(qs.find_order).trim().replace(/[^A-Za-z0-9-]/g, "");
      if (q.length < 3) return json(200, { ok: true, orders: [] });
      const res = await sb("/rest/v1/clicka_orders?order_number=ilike.*" + q + "*&select=id,order_number,total_amount,status,created_at,clicka_registrations(trading_name)&order=created_at.desc&limit=10");
      const rows = await res.json();
      const list = Array.isArray(rows) ? rows : [];
      let paid = new Set();
      if (list.length) {
        const pRes = await sb("/rest/v1/clicka_order_payments?order_id=in.(" + list.map((o) => o.id).join(",") + ")&select=order_id");
        const pRows = await pRes.json();
        paid = new Set((Array.isArray(pRows) ? pRows : []).map((p) => p.order_id));
      }
      return json(200, {
        ok: true,
        orders: list.map((o) => ({
          id: o.id, order_number: o.order_number, total_amount: o.total_amount, status: o.status,
          store_name: o.clicka_registrations ? o.clicka_registrations.trading_name : null,
          already_paid: paid.has(o.id),
        })),
      });
    }

    const params = new URLSearchParams();
    params.set("select", "*,clicka_orders(order_number,total_amount,clicka_registrations(trading_name))");
    params.set("txn_type", "ilike.payment");
    params.set("order", "txn_timestamp.desc.nullslast");
    params.set("limit", "500");
    const view = qs.status || "attention";
    if (view === "attention") params.set("match_status", "in.(" + ATTENTION.join(",") + ")");
    else if (view === "matched") params.set("match_status", "eq.matched");
    if (qs.from) params.append("txn_timestamp", "gte." + qs.from + "T00:00:00");
    if (qs.to) params.append("txn_timestamp", "lte." + qs.to + "T23:59:59");

    const res = await sb("/rest/v1/s2s_payments?" + params.toString());
    let rows = await res.json();
    if (!res.ok) return json(200, { ok: false, error: JSON.stringify(rows).slice(0, 300) });
    rows = Array.isArray(rows) ? rows : [];

    if (qs.search) {
      const s = String(qs.search).toLowerCase();
      rows = rows.filter((p) =>
        String(p.reference || "").toLowerCase().includes(s) ||
        String(p.payer_name || "").toLowerCase().includes(s) ||
        String(p.payer_shop_code || "").toLowerCase().includes(s) ||
        String(p.txn_id).includes(s) ||
        String((p.clicka_orders && p.clicka_orders.order_number) || "").toLowerCase().includes(s)
      );
    }

    // counts across everything (not just this filter) so the chips are honest
    const cRes = await sb("/rest/v1/s2s_payments?txn_type=ilike.payment&select=match_status,status,amount&limit=5000");
    const cRows = await cRes.json();
    const counts = { attention: 0, matched: 0, pending: 0, failed: 0 };
    let matchedTotal = 0, attentionTotal = 0;
    for (const r of Array.isArray(cRows) ? cRows : []) {
      if (r.status === "pending") counts.pending++;
      else if (r.status === "failed") counts.failed++;
      else if (r.match_status === "matched") { counts.matched++; matchedTotal += Number(r.amount) || 0; }
      else if (ATTENTION.includes(r.match_status)) { counts.attention++; attentionTotal += Number(r.amount) || 0; }
    }

    return json(200, {
      ok: true,
      counts,
      totals: { matched: Math.round(matchedTotal * 100) / 100, attention: Math.round(attentionTotal * 100) / 100 },
      payments: rows.map((p) => ({
        txn_id: p.txn_id,
        time: p.txn_timestamp,
        reference: p.reference,
        amount: p.amount,
        status: p.status,
        payer_name: p.payer_name,
        payer_shop_code: p.payer_shop_code,
        match_status: p.match_status,
        match_method: p.match_method,
        amount_diff: p.amount_diff,
        payer_matches_store: p.payer_matches_store,
        order_id: p.order_id,
        order_number: p.clicka_orders ? p.clicka_orders.order_number : null,
        store_name: p.clicka_orders && p.clicka_orders.clicka_registrations ? p.clicka_orders.clicka_registrations.trading_name : null,
        resolve_note: p.resolve_note,
      })),
    });
  }

  // ---------- PATCH: assign / dismiss ----------
  if (event.httpMethod === "PATCH") {
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { ok: false, error: "Invalid JSON body." }); }
    const txnId = Number(body.txn_id);
    if (!txnId) return json(400, { ok: false, error: "txn_id is required." });
    const note = body.note ? String(body.note).slice(0, 300) : null;

    let rpc, payload;
    if (body.action === "assign") {
      if (!body.order_id) return json(400, { ok: false, error: "order_id is required." });
      rpc = "s2s_assign_payment";
      payload = { p_txn: txnId, p_order: body.order_id, p_staff: caller.staff.id, p_note: note };
    } else if (body.action === "dismiss") {
      if (!note) return json(400, { ok: false, error: "Add a note saying why it is being dismissed." });
      rpc = "s2s_dismiss_payment";
      payload = { p_txn: txnId, p_staff: caller.staff.id, p_note: note };
    } else {
      return json(400, { ok: false, error: "action must be assign or dismiss." });
    }
    const res = await sb("/rest/v1/rpc/" + rpc, { method: "POST", body: JSON.stringify(payload) });
    const out = await res.json();
    if (!res.ok) return json(200, { ok: false, error: JSON.stringify(out).slice(0, 300) });
    return json(200, out);
  }

  return json(405, { ok: false, error: "Method not allowed." });
};
