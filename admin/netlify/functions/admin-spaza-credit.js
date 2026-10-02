// admin/netlify/functions/admin-spaza-credit.js
//
// FUNCTION — Clicka Admin: Spaza Credit (manual entry, Phase 1).
//
// Clicka has an exclusive arrangement with a credit partner: they do their
// own due diligence on a spaza's trading history (via the Midi) and extend
// credit directly to that spaza. Clicka never touches the money — we only
// show the spaza (and our own staff) what credit is available, let it be
// used as an optional payment method at checkout, and track what's been
// drawn down. Settlement to the Midi happens exactly as normal; the credit
// partner collects repayment from the spaza off-platform.
//
// This build is manual-entry only — no API integration with the credit
// partner yet (Philip, Oct 2026). Admin/Supervisor/Regional Manager type in
// what the partner has told them: "this shop has R30,000 credit, locked to
// Tiger" or "R20,000, open to any brand."
//
// A store can hold MULTIPLE credit lines at once — e.g. a Tiger-only line
// AND a separate open/all-brands line, simultaneously. Each line's balance
// is the sum of its own ledger (clicka_spaza_credit_transactions); the
// opening grant is itself the first ledger entry, so there's no separate
// "amount used" column that can drift out of sync.
//
// GET  ?store_search=text        -> matching stores (id, trading_name,
//                                    owner_full_name, province, status),
//                                    for the Admin UI's store picker.
// GET  ?store_id=...             -> { store, credit_lines: [...with balance],
//                                    transactions: [...] } for one store.
// GET  ?store_id=...&balances_only=1 -> lean read for the ordering apps
//                                    (Self Order Manager checkout, Agent
//                                    trolley, PPM Agent): just the usable
//                                    balances, no partner names/notes. Open
//                                    to the broader ordering-role set below,
//                                    not just back-office; a Self Order
//                                    Manager can only ever see their OWN
//                                    store this way.
// POST                           -> grant a new credit line.
//   body: { store_id, brand_id (null/omit = "All brands"), credit_company,
//            amount_granted, notes? }
// PATCH ?id=...&action=revoke    -> stop a credit line being usable (balance
//                                    stays visible in history, just can't be
//                                    spent further).
// PATCH ?id=...&action=adjust    -> body: { amount, notes } — a correction,
//                                    positive (top-up) or negative. Logged
//                                    as its own ledger entry, never edits
//                                    the original grant.
//
// Role: Admin, Supervisor, Regional Manager only — this is a back-office
// bookkeeping screen, same tier as Cashless Payments. PPM Agent gets a
// separate, read-only view (see admin-spaza-credit-activity.js, task #216).
//
// Self-test (no auth needed, no data touched):
//   /.netlify/functions/admin-spaza-credit?selftest=1

const { json, sb, getCaller } = require("./_auth");

const ALLOWED_ROLES = ["admin", "supervisor", "regional_manager"];
// Who can read a store's USABLE BALANCES (no partner names, no notes, no
// ledger) — the ordering apps, not just back-office.
const BALANCE_READ_ROLES = ["admin", "supervisor", "regional_manager", "self_order_manager", "agent", "ppm_agent"];

async function balancesForCreditIds(creditIds) {
  if (!creditIds.length) return {};
  const res = await sb(
    "/rest/v1/clicka_spaza_credit_transactions?credit_id=in.(" + creditIds.join(",") + ")&select=credit_id,amount"
  );
  const rows = await res.json();
  const balances = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    balances[r.credit_id] = (balances[r.credit_id] || 0) + (Number(r.amount) || 0);
  }
  return balances;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

  const qs = event.queryStringParameters || {};
  if (qs.selftest === "1") return json(200, { ok: true, world: "CLICKA-ADMIN" });

  const caller = await getCaller(event);
  if (!caller || !caller.staff) return json(401, { ok: false, error: "Not signed in." });
  if (caller.staff.status === "inactive") return json(403, { ok: false, error: "Account deactivated." });

  // ---- Lean balances read for the ordering apps (Self Order / Agent /
  // PPM) — checked BEFORE the back-office role gate below, since this path
  // is open to a wider set of roles than manual entry is. ----
  if (event.httpMethod === "GET" && qs.store_id && qs.balances_only === "1") {
    if (!BALANCE_READ_ROLES.includes(caller.staff.role)) {
      return json(403, { ok: false, error: "Not available for this account type." });
    }
    if (caller.staff.role === "self_order_manager") {
      const myStoreId = ((caller.scope || []).find((s) => s.scope_type === "store") || {}).store_id;
      if (qs.store_id !== myStoreId) return json(403, { ok: false, error: "This account can only view its own store's credit." });
    }

    const creditRes = await sb(
      "/rest/v1/clicka_spaza_credit?store_id=eq." + qs.store_id + "&status=eq.active&select=id,brand_id"
    );
    const creditRows = await creditRes.json();
    const creditLines = Array.isArray(creditRows) ? creditRows : [];
    const creditIds = creditLines.map((c) => c.id);
    const balances = await balancesForCreditIds(creditIds);

    const brandIds = [...new Set(creditLines.map((c) => c.brand_id).filter((v) => v != null))];
    let brandsById = {};
    if (brandIds.length) {
      const brandRes = await sb("/rest/v1/bi_brands?id=in.(" + brandIds.join(",") + ")&select=id,name");
      const brandRows = await brandRes.json();
      brandsById = Object.fromEntries((Array.isArray(brandRows) ? brandRows : []).map((b) => [b.id, b.name]));
    }

    // Only lines with a positive balance are worth the ordering app's
    // attention — a fully-spent or negative-adjusted line shows as 0, not
    // a confusing negative "available" amount.
    const balancesOut = creditLines
      .map((c) => ({
        brand_id: c.brand_id,
        brand_name: c.brand_id == null ? "All brands" : (brandsById[c.brand_id] || "Unknown brand"),
        balance: Math.max(0, Number((balances[c.id] || 0).toFixed(2))),
        credit_id: c.id,
      }))
      .filter((b) => b.balance > 0);

    return json(200, {
      ok: true,
      balances: balancesOut,
      total_available: Number(balancesOut.reduce((sum, b) => sum + b.balance, 0).toFixed(2)),
    });
  }

  // Full read access (store search + one store's lines/ledger) is open to
  // PPM Agent too, read-only — "make a note of it" (Philip, Oct 2026): they
  // can see everything that's happened on a store's credit, just can't
  // grant/revoke/adjust it (that stays Admin/Supervisor/Regional Manager,
  // checked again below on the write actions specifically).
  const READ_ROLES = ALLOWED_ROLES.concat(["ppm_agent"]);
  if (event.httpMethod === "GET" && !READ_ROLES.includes(caller.staff.role)) {
    return json(403, { ok: false, error: "Spaza Credit isn't available on this account." });
  }
  if (event.httpMethod !== "GET" && !ALLOWED_ROLES.includes(caller.staff.role)) {
    return json(403, { ok: false, error: "Spaza Credit is managed by Admin, Supervisor, and Regional Manager accounts." });
  }

  // ---- Store search (picker in the Admin UI) ----
  if (event.httpMethod === "GET" && qs.store_search !== undefined) {
    const term = (qs.store_search || "").trim();
    if (term.length < 2) return json(200, { ok: true, stores: [] });
    const encoded = encodeURIComponent("%" + term + "%");
    const url =
      "/rest/v1/clicka_registrations?select=id,trading_name,owner_full_name,province,status" +
      "&or=(trading_name.ilike." + encoded + ",owner_full_name.ilike." + encoded + ")" +
      "&limit=20";
    const res = await sb(url);
    const rows = await res.json();
    if (!res.ok) return json(200, { ok: false, error: JSON.stringify(rows).slice(0, 300) });
    return json(200, { ok: true, stores: Array.isArray(rows) ? rows : [] });
  }

  // ---- One store's credit lines + ledger ----
  if (event.httpMethod === "GET" && qs.store_id) {
    const storeRes = await sb("/rest/v1/clicka_registrations?id=eq." + qs.store_id + "&select=id,trading_name,owner_full_name,province,status");
    const storeRows = await storeRes.json();
    const store = Array.isArray(storeRows) ? storeRows[0] : null;
    if (!store) return json(404, { ok: false, error: "Store not found." });

    const creditRes = await sb("/rest/v1/clicka_spaza_credit?store_id=eq." + qs.store_id + "&select=*&order=created_at.desc");
    const creditRows = await creditRes.json();
    const creditLines = Array.isArray(creditRows) ? creditRows : [];

    const brandIds = [...new Set(creditLines.map((c) => c.brand_id).filter((v) => v != null))];
    let brandsById = {};
    if (brandIds.length) {
      const brandRes = await sb("/rest/v1/bi_brands?id=in.(" + brandIds.join(",") + ")&select=id,name");
      const brandRows = await brandRes.json();
      brandsById = Object.fromEntries((Array.isArray(brandRows) ? brandRows : []).map((b) => [b.id, b.name]));
    }

    const creditIds = creditLines.map((c) => c.id);
    const balances = await balancesForCreditIds(creditIds);

    const staffIds = [...new Set(creditLines.map((c) => c.created_by).filter(Boolean))];
    let staffById = {};
    if (staffIds.length) {
      const staffRes = await sb("/rest/v1/clicka_staff?id=in.(" + staffIds.join(",") + ")&select=id,first_name,last_name");
      const staffRows = await staffRes.json();
      staffById = Object.fromEntries((Array.isArray(staffRows) ? staffRows : []).map((s) => [s.id, s.first_name + " " + s.last_name]));
    }

    const enrichedLines = creditLines.map((c) => ({
      id: c.id,
      brand_id: c.brand_id,
      brand_name: c.brand_id == null ? "All brands" : (brandsById[c.brand_id] || "Unknown brand"),
      credit_company: c.credit_company,
      amount_granted: Number(c.amount_granted) || 0,
      balance: Number((balances[c.id] || 0).toFixed(2)),
      status: c.status,
      notes: c.notes,
      created_by: staffById[c.created_by] || "Unknown",
      created_at: c.created_at,
      revoked_at: c.revoked_at,
    }));

    let transactions = [];
    if (creditIds.length) {
      const txnRes = await sb(
        "/rest/v1/clicka_spaza_credit_transactions?credit_id=in.(" + creditIds.join(",") + ")&select=*&order=created_at.desc&limit=200"
      );
      const txnRows = await txnRes.json();
      transactions = (Array.isArray(txnRows) ? txnRows : []).map((t) => ({
        id: t.id,
        credit_id: t.credit_id,
        order_id: t.order_id,
        amount: Number(t.amount) || 0,
        type: t.type,
        notes: t.notes,
        created_by: staffById[t.created_by] || "Unknown",
        created_at: t.created_at,
      }));
    }

    return json(200, { ok: true, store, credit_lines: enrichedLines, transactions });
  }

  // ---- Grant a new credit line ----
  if (event.httpMethod === "POST") {
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { ok: false, error: "Invalid JSON body." }); }
    const { store_id, brand_id, credit_company, amount_granted, notes } = body;
    if (!store_id) return json(400, { ok: false, error: "Pick which store this credit belongs to." });
    if (!credit_company || !String(credit_company).trim()) return json(400, { ok: false, error: "Enter the credit partner's name." });
    const amount = Number(amount_granted);
    if (!amount || isNaN(amount) || amount <= 0) return json(400, { ok: false, error: "Amount must be a positive number." });

    const creditRes = await sb("/rest/v1/clicka_spaza_credit", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify([{
        store_id,
        brand_id: brand_id || null,
        credit_company: String(credit_company).trim(),
        amount_granted: amount,
        notes: notes || null,
        created_by: caller.staff.id,
      }]),
    });
    const creditRows = await creditRes.json();
    if (!creditRes.ok || !Array.isArray(creditRows) || !creditRows.length) {
      return json(200, { ok: false, error: "Couldn't create credit line: " + JSON.stringify(creditRows).slice(0, 300) });
    }
    const creditLine = creditRows[0];

    const txnRes = await sb("/rest/v1/clicka_spaza_credit_transactions", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify([{
        credit_id: creditLine.id,
        amount: amount,
        type: "grant",
        notes: "Opening grant",
        created_by: caller.staff.id,
      }]),
    });
    if (!txnRes.ok) {
      const errBody = await txnRes.text();
      return json(200, { ok: false, error: "Credit line created, but failed to log the opening grant: " + errBody.slice(0, 300) });
    }

    return json(200, { ok: true, credit_id: creditLine.id });
  }

  // ---- Revoke / adjust an existing credit line ----
  if (event.httpMethod === "PATCH" && qs.id) {
    const action = qs.action;

    if (action === "revoke") {
      const res = await sb("/rest/v1/clicka_spaza_credit?id=eq." + qs.id, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ status: "revoked", revoked_at: new Date().toISOString(), revoked_by: caller.staff.id }),
      });
      const rows = await res.json();
      if (!res.ok || !Array.isArray(rows) || !rows.length) {
        return json(200, { ok: false, error: "Couldn't revoke: " + JSON.stringify(rows).slice(0, 300) });
      }
      return json(200, { ok: true });
    }

    if (action === "adjust") {
      let body;
      try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { ok: false, error: "Invalid JSON body." }); }
      const amount = Number(body.amount);
      if (!amount || isNaN(amount) || amount === 0) return json(400, { ok: false, error: "Adjustment amount can't be zero." });

      const txnRes = await sb("/rest/v1/clicka_spaza_credit_transactions", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify([{
          credit_id: qs.id,
          amount,
          type: "manual_adjustment",
          notes: body.notes || null,
          created_by: caller.staff.id,
        }]),
      });
      const rows = await txnRes.json();
      if (!txnRes.ok || !Array.isArray(rows) || !rows.length) {
        return json(200, { ok: false, error: "Couldn't log adjustment: " + JSON.stringify(rows).slice(0, 300) });
      }
      return json(200, { ok: true });
    }

    return json(400, { ok: false, error: "Unknown action." });
  }

  return json(405, { ok: false, error: "Method not allowed." });
};
