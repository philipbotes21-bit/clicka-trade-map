// admin/netlify/functions/admin-switch.js
//
// FUNCTION — "RMB Switch": the Finance view of every money-and-goods journey
// Clicka facilitates (spaza -> Midi, spaza -> wholesaler, Midi -> brand ...),
// the tamper-evident event ledger behind them, exceptions, and RMB / FNB 3PIM
// readiness. Admin only for now. A read-only bank-facing role comes later
// (it would see references and amounts, never personal data).
//
// GET  (no params)            -> overview: totals by flow and stage, the 5 billable
//                                 calls, exceptions count, ledger integrity,
//                                 connection state, readiness checklist
// GET  ?view=transactions     -> &flow= &stage= &search= &test=1
// GET  ?view=exceptions       -> things a human should look at
// GET  ?view=ledger           -> latest ledger events (&limit=)
// GET  ?id=<txn id>           -> one journey with its events
// POST { action: "sync" }     -> pull any new activity from orders, payments,
//                                 cashless payments and wholesaler orders into
//                                 the ledger (idempotent)
// PATCH { item, status, note? } -> update a readiness checklist item
//
// Nothing here talks to FNB yet — no sandbox credentials. When
// FNB_3PIM_CLIENT_ID / FNB_3PIM_CLIENT_SECRET / FNB_3PIM_BASE are set, the
// overview reports the connection as "configured". Secrets are never returned.
//
// Self-test: /.netlify/functions/admin-switch?selftest=1

const { json, sb, getCaller } = require("./_auth");
const BUILD = "switch-2026-11-03a";

const FLOW_LABEL = {
  spaza_to_midi: "Spaza to Midi",
  midi_to_wholesaler: "Midi to Wholesaler",
  midi_to_brand: "Midi to Brand",
  wholesaler_to_brand: "Wholesaler to Brand",
};

async function rpc(name, args) {
  const res = await sb("/rest/v1/rpc/" + name, { method: "POST", body: JSON.stringify(args || {}) });
  return { ok: res.ok, body: await res.json().catch(() => null) };
}

// Journeys a human should look at.
async function computeExceptions() {
  const out = [];

  // 1. Payments that couldn't be matched cleanly
  const pRes = await sb("/rest/v1/s2s_payments?txn_type=ilike.payment&status=eq.success&match_status=in.(unmatched,ambiguous,amount_mismatch,duplicate_payment)&select=txn_id,reference,amount,match_status,payer_name,txn_timestamp&order=txn_timestamp.desc&limit=100");
  const pRows = await pRes.json();
  for (const p of Array.isArray(pRows) ? pRows : []) {
    out.push({ kind: "payment_" + p.match_status, ref: String(p.txn_id), detail: (p.payer_name || "Unknown payer") + " · ref " + (p.reference || "none"), amount: p.amount, at: p.txn_timestamp });
  }

  // 2. Wallet orders that moved on without funds verified
  const tRes = await sb("/rest/v1/switch_transactions?rail=eq.s2s_wallet&source_type=eq.order&is_test=eq.false&stage=in.(initiated,validated,pod_confirmed,settled)&select=id,txn_ref,stage,amount,payer_name,created_at&order=created_at.desc&limit=500");
  const tRows = await tRes.json();
  const wallet = Array.isArray(tRows) ? tRows : [];
  if (wallet.length) {
    const ids = wallet.map((t) => t.id);
    const funded = new Set();
    for (let i = 0; i < ids.length; i += 80) {
      const eRes = await sb("/rest/v1/switch_events?txn_id=in.(" + ids.slice(i, i + 80).join(",") + ")&event_type=in.(funds_verified,credit_applied)&select=txn_id");
      const eRows = await eRes.json();
      (Array.isArray(eRows) ? eRows : []).forEach((e) => funded.add(e.txn_id));
    }
    const now = Date.now();
    for (const t of wallet) {
      if (funded.has(t.id)) continue;
      if (t.stage === "pod_confirmed" || t.stage === "settled") {
        out.push({ kind: "delivered_unpaid", ref: t.txn_ref, detail: (t.payer_name || "Store") + " · delivered but no matched payment", amount: t.amount, at: t.created_at });
      } else if (t.stage === "validated") {
        out.push({ kind: "picked_unpaid", ref: t.txn_ref, detail: (t.payer_name || "Store") + " · picked before funds were verified", amount: t.amount, at: t.created_at });
      } else if (now - new Date(t.created_at).getTime() > 24 * 3600 * 1000) {
        out.push({ kind: "payment_overdue", ref: t.txn_ref, detail: (t.payer_name || "Store") + " · wallet order unpaid for over 24 hours", amount: t.amount, at: t.created_at });
      }
    }
  }
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });
  const qs = event.queryStringParameters || {};
  if (qs.selftest === "1") return json(200, { ok: true, world: "CLICKA-ADMIN-SWITCH", build: BUILD });

  const caller = await getCaller(event);
  if (!caller || !caller.staff) return json(401, { ok: false, error: "Not signed in." });
  if (caller.staff.status === "inactive") return json(403, { ok: false, error: "Account deactivated." });
  if (caller.staff.role !== "admin") return json(403, { ok: false, error: "RMB Switch is Admin only." });

  // ---------- POST: sync ----------
  if (event.httpMethod === "POST") {
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { ok: false, error: "Invalid JSON body." }); }
    if (body.action !== "sync") return json(400, { ok: false, error: "Unknown action." });
    const r = await rpc("switch_sync");
    if (!r.ok) return json(200, { ok: false, error: JSON.stringify(r.body).slice(0, 300) });
    return json(200, r.body);
  }

  // ---------- PATCH: readiness item ----------
  if (event.httpMethod === "PATCH") {
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { ok: false, error: "Invalid JSON body." }); }
    if (!body.item || !["todo", "in_progress", "done"].includes(body.status)) return json(400, { ok: false, error: "item and a valid status are required." });
    const patch = { status: body.status, updated_at: new Date().toISOString() };
    if (body.note !== undefined) patch.note = body.note ? String(body.note).slice(0, 300) : null;
    const res = await sb("/rest/v1/switch_readiness?item=eq." + encodeURIComponent(body.item), { method: "PATCH", body: JSON.stringify(patch) });
    if (!res.ok) return json(200, { ok: false, error: (await res.text()).slice(0, 300) });
    return json(200, { ok: true });
  }

  if (event.httpMethod !== "GET") return json(405, { ok: false, error: "Method not allowed." });

  // ---------- GET one journey ----------
  if (qs.id) {
    const tRes = await sb("/rest/v1/switch_transactions?id=eq." + encodeURIComponent(qs.id) + "&select=*");
    const tRows = await tRes.json();
    const txn = Array.isArray(tRows) ? tRows[0] : null;
    if (!txn) return json(404, { ok: false, error: "Transaction not found." });
    const eRes = await sb("/rest/v1/switch_events?txn_id=eq." + txn.id + "&select=id,event_code,event_type,call_no,direction,status,occurred_at,payload,hash&order=occurred_at.asc,id.asc");
    const events = await eRes.json();
    return json(200, { ok: true, flow_label: FLOW_LABEL[txn.flow_type], transaction: txn, events: Array.isArray(events) ? events : [] });
  }

  // ---------- GET transactions ----------
  if (qs.view === "transactions") {
    const params = new URLSearchParams();
    params.set("select", "id,txn_ref,flow_type,source_type,payer_name,payee_name,brand_name,amount,rail,stage,is_test,created_at");
    params.set("order", "created_at.desc");
    params.set("limit", "300");
    if (qs.flow) params.set("flow_type", "eq." + qs.flow);
    if (qs.stage) params.set("stage", "eq." + qs.stage);
    if (qs.test !== "1") params.set("is_test", "eq.false");
    const res = await sb("/rest/v1/switch_transactions?" + params.toString());
    let rows = await res.json();
    if (!res.ok) return json(200, { ok: false, error: JSON.stringify(rows).slice(0, 300) });
    rows = Array.isArray(rows) ? rows : [];
    if (qs.search) {
      const s = String(qs.search).toLowerCase();
      rows = rows.filter((t) => [t.txn_ref, t.payer_name, t.payee_name, t.brand_name].some((v) => String(v || "").toLowerCase().includes(s)));
    }
    // which calls each journey has completed
    const callsByTxn = {};
    if (rows.length) {
      const ids = rows.map((t) => t.id);
      for (let i = 0; i < ids.length; i += 80) {
        const eRes = await sb("/rest/v1/switch_events?txn_id=in.(" + ids.slice(i, i + 80).join(",") + ")&call_no=not.is.null&select=txn_id,call_no");
        const eRows = await eRes.json();
        (Array.isArray(eRows) ? eRows : []).forEach((e) => { (callsByTxn[e.txn_id] = callsByTxn[e.txn_id] || new Set()).add(e.call_no); });
      }
    }
    return json(200, {
      ok: true,
      flow_labels: FLOW_LABEL,
      transactions: rows.map((t) => ({ ...t, flow_label: FLOW_LABEL[t.flow_type], calls_done: Array.from(callsByTxn[t.id] || []).sort() })),
    });
  }

  // ---------- GET exceptions ----------
  if (qs.view === "exceptions") {
    return json(200, { ok: true, exceptions: await computeExceptions() });
  }

  // ---------- GET ledger ----------
  if (qs.view === "ledger") {
    const limit = Math.min(Number(qs.limit) || 100, 500);
    const res = await sb("/rest/v1/switch_events?select=id,txn_id,event_code,event_type,call_no,direction,status,occurred_at,hash,switch_transactions(txn_ref)&order=id.desc&limit=" + limit);
    const rows = await res.json();
    return json(200, {
      ok: true,
      events: (Array.isArray(rows) ? rows : []).map((e) => ({ ...e, txn_ref: e.switch_transactions ? e.switch_transactions.txn_ref : null, switch_transactions: undefined })),
    });
  }

  // ---------- GET overview ----------
  const tRes = await sb("/rest/v1/switch_transactions?is_test=eq.false&select=id,flow_type,stage,amount&limit=10000");
  const tRows = await tRes.json();
  const txns = Array.isArray(tRows) ? tRows : [];
  const byFlow = {};
  const byStage = {};
  let totalValue = 0;
  for (const t of txns) {
    const f = (byFlow[t.flow_type] = byFlow[t.flow_type] || { count: 0, value: 0 });
    f.count++; f.value += Number(t.amount) || 0;
    byStage[t.stage] = (byStage[t.stage] || 0) + 1;
    totalValue += Number(t.amount) || 0;
  }
  for (const k of Object.keys(byFlow)) byFlow[k].value = Math.round(byFlow[k].value * 100) / 100;

  const cRes = await sb("/rest/v1/switch_events?call_no=not.is.null&select=txn_id,call_no&limit=20000");
  const cRows = await cRes.json();
  const callSets = { 1: new Set(), 2: new Set(), 3: new Set(), 4: new Set(), 5: new Set() };
  (Array.isArray(cRows) ? cRows : []).forEach((e) => { if (callSets[e.call_no]) callSets[e.call_no].add(e.txn_id); });
  const calls = {};
  for (const k of Object.keys(callSets)) calls[k] = callSets[k].size;

  const chain = await rpc("switch_verify_chain");
  const exceptions = await computeExceptions();
  const rRes = await sb("/rest/v1/switch_readiness?select=item,sort_order,label,owner,status,note&order=sort_order.asc");
  const readiness = await rRes.json();

  const configured = !!(process.env.FNB_3PIM_CLIENT_ID && process.env.FNB_3PIM_CLIENT_SECRET && process.env.FNB_3PIM_BASE);

  return json(200, {
    ok: true,
    build: BUILD,
    flow_labels: FLOW_LABEL,
    totals: { transactions: txns.length, value: Math.round(totalValue * 100) / 100 },
    by_flow: byFlow,
    by_stage: byStage,
    calls_completed: calls,
    exceptions: exceptions.length,
    ledger: chain.ok ? chain.body : { ok: false },
    connection: {
      state: configured ? "configured" : "not_configured",
      note: configured ? "Credentials present. No live calls are made yet." : "Waiting for FNB sandbox credentials. No calls are being made to FNB.",
    },
    readiness: Array.isArray(readiness) ? readiness : [],
  });
};
