// admin/netlify/functions/admin-rewards.js
//
// FUNCTION — Clicka Admin: Clicka Trader Rewards.
//
// Members (spaza owners who hold a Clicka Trader Rewards card), the wholesaler
// list they buy at, brand/product-funded reward OFFERS, and the reward LEDGER
// (every accrual, payout, reversal and adjustment, so Clicka can always show
// what was earned, what was paid out, and what is still owed).
//
// The member sign-up itself (public QR page + PPM Agent workflow) lives in the
// onboarding site; this function is the back-office view of the same data.
// All reads/writes use the service role; the browser never touches the tables.
//
// ?resource=
//   members      GET  list (q, midi, status, agent, from, to, limit, offset)
//   member       GET  ?id=       detail + signed photo URL + midis + ledger totals
//                PATCH ?id=      edit fields / status (reason) / add_midi / remove_midi
//   wholesalers  GET / POST / PATCH ?id=
//   offers       GET / POST / PATCH ?id=
//   ledger       GET  (member_id, offer_id, type, from, to)   POST manual entry
//   summary      GET  totals: members, earned, paid out, outstanding, by offer / funder
//   feed_import  POST {rows, dry_run, source, file_name}  partner POS feed -> accruals
//   export       GET  ?kind=members|ledger|offers  full unpaged rows for download
//
// Roles
//   read   : admin, supervisor, regional_manager, ppm_agent
//            (ppm_agent only sees members they signed up, or members linked to
//             their assigned Midi(s))
//   edit members : admin, supervisor, regional_manager
//   offers / ledger / wholesalers / feed import : admin only
//
// Self-test (no auth, no data):  /.netlify/functions/admin-rewards?selftest=1

const { json, sb, getCaller, SUPABASE_URL, SERVICE_KEY } = require("./_auth");

const BUILD = "2026-10-20-rewards-1";
const READ_ROLES = ["admin", "supervisor", "regional_manager", "ppm_agent"];
const MEMBER_EDIT_ROLES = ["admin", "supervisor", "regional_manager"];
const ADMIN_ONLY = ["admin"];
const PHOTO_BUCKET = "spaza-member-photos";

const MEMBER_LIST_COLS =
  "id,card_no,shop_name,owner_first,owner_last,cell,email,suburb,city,home_midi_id,home_midi_name,status,created_at," +
  "signup_channel,signed_up_by_staff_id,agent_name,marketing_sms_optin,marketing_whatsapp_optin,photo_path,registration_id,external_member_id";

// ---------- helpers ----------
const enc = encodeURIComponent;
const inList = (arr) => "in.(" + arr.map((v) => '"' + String(v).replace(/["\\]/g, "") + '"').join(",") + ")";
const cleanSearch = (s) => String(s || "").replace(/[,()*%"\\]/g, " ").trim();
const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ""));
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// PostgREST caps a response at 1000 rows by default, so page with Range.
async function fetchAll(path, max) {
  const out = [];
  const cap = max || 50000;
  for (let from = 0; from < cap; from += 1000) {
    const res = await sb(path, { headers: { Range: from + "-" + (from + 999), "Range-Unit": "items" } });
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error(JSON.stringify(rows).slice(0, 200));
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

function myMidiIds(caller) {
  return (caller.scope || []).filter((s) => s.scope_type === "midi" && s.midi_id).map((s) => s.midi_id);
}

// Returns an and-clause string limiting members to what this caller may see,
// or null when unrestricted. Never trust a midi id from the browser.
async function visibilityClause(caller) {
  if (caller.staff.role !== "ppm_agent") return null;
  const midis = myMidiIds(caller);
  const parts = ["signed_up_by_staff_id.eq." + caller.staff.id];
  if (midis.length) {
    parts.push("home_midi_id." + inList(midis));
    const links = await fetchAll(
      "/rest/v1/clicka_member_midis?wholesaler_id=" + enc(inList(midis)) + "&select=member_id",
      5000
    );
    const ids = Array.from(new Set(links.map((l) => l.member_id)));
    if (ids.length) parts.push("id." + inList(ids));
  }
  return "or(" + parts.join(",") + ")";
}

async function staffNames() {
  const rows = await fetchAll("/rest/v1/clicka_staff?select=id,first_name,last_name", 5000);
  return Object.fromEntries(rows.map((r) => [r.id, (r.first_name + " " + r.last_name).trim()]));
}

async function signedPhotoUrl(path) {
  if (!path) return null;
  try {
    const res = await fetch(SUPABASE_URL + "/storage/v1/object/sign/" + PHOTO_BUCKET + "/" + path, {
      method: "POST",
      headers: { Authorization: "Bearer " + SERVICE_KEY, apikey: SERVICE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: 300 }),
    });
    const j = await res.json();
    if (!j || !j.signedURL) return null;
    return SUPABASE_URL + "/storage/v1" + j.signedURL;
  } catch (e) {
    return null;
  }
}

function parseBody(event) {
  try { return JSON.parse(event.body || "{}"); } catch (e) { return null; }
}

// ---------- members ----------
async function listMembers(caller, qs, forExport) {
  const clauses = [];
  const vis = await visibilityClause(caller);
  if (vis) clauses.push(vis);
  if (qs.q) {
    const t = cleanSearch(qs.q);
    if (t) {
      clauses.push(
        "or(shop_name.ilike.*" + t + "*,owner_first.ilike.*" + t + "*,owner_last.ilike.*" + t +
        "*,cell.ilike.*" + t + "*,card_no.ilike.*" + t + "*)"
      );
    }
  }
  let extra = "";
  if (qs.midi) extra += "&home_midi_id=eq." + enc(qs.midi);
  if (qs.status) extra += "&status=eq." + enc(qs.status);
  if (qs.agent) extra += "&signed_up_by_staff_id=eq." + enc(qs.agent);
  if (qs.from) extra += "&created_at=gte." + enc(qs.from);
  if (qs.to) extra += "&created_at=lte." + enc(qs.to + "T23:59:59");
  if (qs.has_photo === "1") extra += "&photo_path=not.is.null";
  if (qs.has_photo === "0") extra += "&photo_path=is.null";
  const and = clauses.length ? "&and=" + enc("(" + clauses.join(",") + ")") : "";
  const base = "/rest/v1/clicka_spaza_members?select=" + MEMBER_LIST_COLS + extra + and + "&order=created_at.desc";

  if (forExport) return { rows: await fetchAll(base, 50000), total: null };

  const limit = Math.min(Math.max(parseInt(qs.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(qs.offset, 10) || 0, 0);
  const res = await sb(base + "&limit=" + limit + "&offset=" + offset, { headers: { Prefer: "count=exact" } });
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error(JSON.stringify(rows).slice(0, 200));
  const cr = res.headers.get("content-range") || "";
  const total = parseInt(cr.split("/")[1], 10);
  return { rows, total: Number.isFinite(total) ? total : rows.length };
}

async function getVisibleMember(caller, id) {
  if (!isUuid(id)) return null;
  const vis = await visibilityClause(caller);
  const and = vis ? "&and=" + enc("(" + vis + ")") : "";
  const res = await sb("/rest/v1/clicka_spaza_members?id=eq." + id + "&select=*" + and);
  const rows = await res.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function ledgerTotals(filter) {
  const rows = await fetchAll("/rest/v1/clicka_reward_ledger?select=entry_type,amount&" + filter, 50000);
  let earned = 0, paid = 0;
  for (const r of rows) {
    if (r.entry_type === "PAYOUT") paid += -Number(r.amount);
    else earned += Number(r.amount);
  }
  return { earned: round2(earned), paid_out: round2(paid), outstanding: round2(earned - paid), entries: rows.length };
}

// ---------- offers ----------
function cleanOffer(body, isCreate) {
  const o = {};
  const err = (m) => { throw Object.assign(new Error(m), { user: true }); };
  if (isCreate || body.name !== undefined) {
    if (!body.name || !String(body.name).trim()) err("Offer name is required.");
    o.name = String(body.name).trim();
  }
  if (body.description !== undefined) o.description = body.description ? String(body.description).trim() : null;
  if (body.brand_id !== undefined) o.brand_id = body.brand_id === "" || body.brand_id === null ? null : Number(body.brand_id);
  if (body.product_barcodes !== undefined) {
    let list = body.product_barcodes;
    if (typeof list === "string") list = list.split(/[\s,;]+/);
    list = (list || []).map((s) => String(s).trim()).filter(Boolean);
    o.product_barcodes = list.length ? list : null;
  }
  if (isCreate || body.reward_type !== undefined) {
    if (!["CASHBACK_PCT", "DISCOUNT_PCT", "FIXED_PER_UNIT"].includes(body.reward_type)) err("Pick a reward type.");
    o.reward_type = body.reward_type;
  }
  if (isCreate || body.rate !== undefined) {
    const r = Number(body.rate);
    if (!Number.isFinite(r) || r < 0) err("Rate must be a number of zero or more.");
    const rt = o.reward_type || body.reward_type;
    if ((rt === "CASHBACK_PCT" || rt === "DISCOUNT_PCT") && r > 100) err("A percentage can't be over 100.");
    o.rate = r;
  }
  if (body.funded_by !== undefined) {
    if (!["BRAND", "MIDI", "CLICKA"].includes(body.funded_by)) err("Funded by must be Brand, Midi or Clicka.");
    o.funded_by = body.funded_by;
  }
  if (body.wholesaler_ids !== undefined) {
    const w = Array.isArray(body.wholesaler_ids) ? body.wholesaler_ids.filter(Boolean) : [];
    o.wholesaler_ids = w.length ? w : null;
  }
  if (body.budget_cap !== undefined) o.budget_cap = body.budget_cap === "" || body.budget_cap === null ? null : Number(body.budget_cap);
  if (body.starts_at !== undefined) o.starts_at = body.starts_at || null;
  if (body.ends_at !== undefined) o.ends_at = body.ends_at || null;
  if (o.starts_at && o.ends_at && new Date(o.ends_at) < new Date(o.starts_at)) err("End date is before the start date.");
  if (body.status !== undefined) {
    if (!["DRAFT", "ACTIVE", "PAUSED", "ENDED"].includes(body.status)) err("Bad status.");
    o.status = body.status;
  }
  return o;
}

// ---------- feed import ----------
async function feedImport(caller, body) {
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) return { ok: false, error: "No rows supplied." };
  if (rows.length > 5000) return { ok: false, error: "Send at most 5,000 rows per import." };
  const dryRun = body.dry_run !== false; // default is a dry run

  const offers = (await fetchAll("/rest/v1/clicka_reward_offers?status=eq.ACTIVE&select=*", 2000));
  if (!offers.length) return { ok: false, error: "There are no ACTIVE offers, so nothing would be earned. Activate an offer first." };

  const cards = Array.from(new Set(rows.map((r) => String(r.card_no || "").trim()).filter(Boolean)));
  const memberByCard = {};
  for (let i = 0; i < cards.length; i += 200) {
    const part = await fetchAll("/rest/v1/clicka_spaza_members?card_no=" + enc(inList(cards.slice(i, i + 200))) + "&select=id,card_no,status", 5000);
    part.forEach((m) => (memberByCard[m.card_no] = m));
  }

  const barcodes = Array.from(new Set(rows.map((r) => String(r.barcode || "").trim()).filter(Boolean)));
  const brandByBarcode = {};
  for (let i = 0; i < barcodes.length; i += 200) {
    const part = await fetchAll("/rest/v1/clicka_supplier_products?barcode=" + enc(inList(barcodes.slice(i, i + 200))) + "&select=barcode,brand_id", 5000);
    part.forEach((p) => (brandByBarcode[p.barcode] = p.brand_id));
  }

  // Already-posted lines (idempotent: re-running a file never doubles a reward).
  const refs = Array.from(new Set(rows.map((r) => String(r.invoice_no || "").trim()).filter(Boolean)));
  const seen = new Set();
  for (let i = 0; i < refs.length; i += 200) {
    const part = await fetchAll("/rest/v1/clicka_reward_ledger?source_ref=" + enc(inList(refs.slice(i, i + 200))) + "&entry_type=eq.ACCRUAL&select=source_ref,line_ref,offer_id", 20000);
    part.forEach((p) => seen.add(p.source_ref + "|" + p.line_ref + "|" + p.offer_id));
  }

  // Budget used so far per capped offer.
  const spent = {};
  for (const o of offers.filter((x) => x.budget_cap != null)) {
    spent[o.id] = (await ledgerTotals("offer_id=eq." + o.id)).earned;
  }

  const unknown = new Set();
  const skippedInactive = new Set();
  const toInsert = [];
  const perOffer = {};
  let noInvoice = 0, duplicates = 0, noOffer = 0, overBudget = 0, matchedLines = 0;

  rows.forEach((r, idx) => {
    const card = String(r.card_no || "").trim();
    const invoice = String(r.invoice_no || "").trim();
    const lineRef = String(r.line_ref != null && r.line_ref !== "" ? r.line_ref : idx + 1);
    if (!invoice) { noInvoice++; return; }
    const m = memberByCard[card];
    if (!m) { unknown.add(card || "(blank)"); return; }
    if (m.status !== "ACTIVE") { skippedInactive.add(card); return; }
    const barcode = String(r.barcode || "").trim();
    const brand = barcode ? brandByBarcode[barcode] : null;
    const when = r.occurred_at ? new Date(r.occurred_at) : new Date();
    const qty = num(r.qty), total = num(r.line_total);
    let hit = false;
    for (const o of offers) {
      if (o.brand_id != null && o.brand_id !== brand) continue;
      if (o.product_barcodes && !o.product_barcodes.includes(barcode)) continue;
      if (o.wholesaler_ids && !o.wholesaler_ids.includes(String(r.wholesaler_id || ""))) continue;
      if (o.starts_at && when < new Date(o.starts_at)) continue;
      if (o.ends_at && when > new Date(o.ends_at)) continue;
      let amt = 0;
      if (o.reward_type === "FIXED_PER_UNIT") amt = (qty || 0) * Number(o.rate);
      else amt = ((total || 0) * Number(o.rate)) / 100;
      amt = round2(amt);
      if (!(amt > 0)) continue;
      hit = true;
      const key = invoice + "|" + lineRef + "|" + o.id;
      if (seen.has(key)) { duplicates++; continue; }
      if (o.budget_cap != null && (spent[o.id] || 0) + amt > Number(o.budget_cap)) { overBudget++; continue; }
      seen.add(key);
      spent[o.id] = (spent[o.id] || 0) + amt;
      perOffer[o.id] = perOffer[o.id] || { name: o.name, funded_by: o.funded_by, lines: 0, amount: 0 };
      perOffer[o.id].lines++;
      perOffer[o.id].amount = round2(perOffer[o.id].amount + amt);
      toInsert.push({
        entry_type: "ACCRUAL", member_id: m.id, card_no: card, offer_id: o.id,
        wholesaler_id: r.wholesaler_id ? String(r.wholesaler_id) : null, brand_id: brand || null,
        source_ref: invoice, line_ref: lineRef, barcode: barcode || null, qty, line_total: total,
        amount: amt, funded_by: o.funded_by, status: "CONFIRMED", occurred_at: when.toISOString(),
        note: o.reward_type === "DISCOUNT_PCT" ? "Till discount (recharge to funder)" : null,
        created_by: caller.staff.id,
      });
    }
    if (hit) matchedLines++; else noOffer++;
  });

  const report = {
    rows: rows.length,
    lines_earning: matchedLines,
    entries_to_post: toInsert.length,
    total_reward: round2(toInsert.reduce((s, e) => s + e.amount, 0)),
    already_posted_skipped: duplicates,
    no_matching_offer: noOffer,
    over_budget_skipped: overBudget,
    missing_invoice_no: noInvoice,
    unknown_cards: Array.from(unknown).slice(0, 50),
    unknown_card_count: unknown.size,
    inactive_member_cards: Array.from(skippedInactive).slice(0, 50),
    by_offer: Object.values(perOffer),
  };
  if (dryRun) return { ok: true, dry_run: true, report };

  const batchRes = await sb("/rest/v1/clicka_reward_batches", {
    method: "POST", headers: { Prefer: "return=representation" },
    body: JSON.stringify([{ source: String(body.source || "MANUAL"), file_name: body.file_name || null, row_count: rows.length, note: body.note || null, created_by: caller.staff.id }]),
  });
  const batchRows = await batchRes.json();
  if (!batchRes.ok) return { ok: false, error: "Could not create the import batch: " + JSON.stringify(batchRows).slice(0, 200) };
  const batchId = batchRows[0].id;
  toInsert.forEach((e) => (e.batch_id = batchId));
  for (let i = 0; i < toInsert.length; i += 500) {
    const ins = await sb("/rest/v1/clicka_reward_ledger", { method: "POST", body: JSON.stringify(toInsert.slice(i, i + 500)) });
    if (!ins.ok) {
      const t = await ins.text();
      return { ok: false, error: "Import stopped part-way (batch " + batchId + "): " + t.slice(0, 200) };
    }
  }
  // Remember which wholesalers each member buys at.
  const links = new Map();
  toInsert.forEach((e) => { if (e.wholesaler_id) links.set(e.member_id + "|" + e.wholesaler_id, { member_id: e.member_id, wholesaler_id: e.wholesaler_id, source: "FEED" }); });
  if (links.size) {
    await sb("/rest/v1/clicka_member_midis?on_conflict=member_id,wholesaler_id", {
      method: "POST", headers: { Prefer: "resolution=ignore-duplicates" }, body: JSON.stringify(Array.from(links.values())),
    });
  }
  return { ok: true, dry_run: false, batch_id: batchId, report };
}

// ---------- handler ----------
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });
  const qs = event.queryStringParameters || {};
  if (qs.selftest === "1") return json(200, { ok: true, world: "CLICKA-ADMIN", fn: "admin-rewards", build: BUILD });

  const caller = await getCaller(event);
  if (!caller || !caller.staff) return json(401, { ok: false, error: "Not signed in." });
  if (caller.staff.status === "inactive") return json(403, { ok: false, error: "Account deactivated." });
  const role = caller.staff.role;
  if (!READ_ROLES.includes(role)) return json(403, { ok: false, error: "Rewards access is limited to Admin, Supervisor, Regional Manager and PPM Agent roles." });

  const resource = qs.resource || "members";
  const method = event.httpMethod;
  const isWrite = method !== "GET";
  const body = isWrite ? parseBody(event) : null;
  if (isWrite && body === null) return json(400, { ok: false, error: "Invalid JSON body." });

  try {
    // ----- members -----
    if (resource === "members" && method === "GET") {
      const { rows, total } = await listMembers(caller, qs, false);
      const names = await staffNames();
      rows.forEach((r) => (r.signed_up_by = names[r.signed_up_by_staff_id] || r.agent_name || null));
      return json(200, { ok: true, members: rows, total });
    }

    if (resource === "member") {
      const id = qs.id;
      const member = await getVisibleMember(caller, id);
      if (!member) return json(404, { ok: false, error: "Member not found." });

      if (method === "GET") {
        const [photoUrl, midiRows, totals, ledgerRes, names] = await Promise.all([
          signedPhotoUrl(member.photo_path),
          fetchAll("/rest/v1/clicka_member_midis?member_id=eq." + id + "&select=wholesaler_id,source,first_seen_at", 500),
          ledgerTotals("member_id=eq." + id),
          sb("/rest/v1/clicka_reward_ledger?member_id=eq." + id + "&select=*&order=occurred_at.desc&limit=100"),
          staffNames(),
        ]);
        const ledger = await ledgerRes.json();
        const wIds = Array.from(new Set([member.home_midi_id, ...midiRows.map((m) => m.wholesaler_id)].filter(Boolean)));
        let wmap = {};
        if (wIds.length) {
          const w = await fetchAll("/rest/v1/clicka_member_wholesalers?id=" + enc(inList(wIds)) + "&select=id,name", 500);
          wmap = Object.fromEntries(w.map((x) => [x.id, x.name]));
        }
        return json(200, {
          ok: true,
          member: { ...member, signed_up_by: names[member.signed_up_by_staff_id] || member.agent_name || null },
          photo_url: photoUrl,
          midis: midiRows.map((m) => ({ ...m, name: wmap[m.wholesaler_id] || m.wholesaler_id })),
          totals,
          ledger: Array.isArray(ledger) ? ledger : [],
        });
      }

      if (method === "PATCH") {
        if (!MEMBER_EDIT_ROLES.includes(role)) return json(403, { ok: false, error: "Editing members is limited to Admin, Supervisor and Regional Manager." });

        if (body.action === "add_midi") {
          if (!body.wholesaler_id) return json(400, { ok: false, error: "wholesaler_id is required." });
          const w = await (await sb("/rest/v1/clicka_member_wholesalers?id=eq." + enc(body.wholesaler_id) + "&select=id")).json();
          if (!Array.isArray(w) || !w.length) return json(400, { ok: false, error: "Unknown wholesaler." });
          await sb("/rest/v1/clicka_member_midis?on_conflict=member_id,wholesaler_id", {
            method: "POST", headers: { Prefer: "resolution=ignore-duplicates" },
            body: JSON.stringify([{ member_id: id, wholesaler_id: body.wholesaler_id, source: "ADMIN" }]),
          });
          return json(200, { ok: true });
        }
        if (body.action === "remove_midi") {
          await sb("/rest/v1/clicka_member_midis?member_id=eq." + id + "&wholesaler_id=eq." + enc(body.wholesaler_id || ""), { method: "DELETE" });
          return json(200, { ok: true });
        }

        const patch = { updated_at: new Date().toISOString() };
        for (const f of ["shop_name", "owner_first", "owner_last", "email", "suburb", "city", "registration_id", "external_member_id"]) {
          if (body[f] !== undefined) patch[f] = body[f] === "" ? null : String(body[f]).trim();
        }
        for (const f of ["shop_name", "owner_first", "owner_last"]) {
          if (patch[f] === null) return json(400, { ok: false, error: "Shop name, first name and surname can't be empty." });
        }
        if (body.home_midi_id !== undefined) {
          const w = await (await sb("/rest/v1/clicka_member_wholesalers?id=eq." + enc(body.home_midi_id) + "&select=id,name")).json();
          if (!Array.isArray(w) || !w.length) return json(400, { ok: false, error: "Unknown wholesaler." });
          patch.home_midi_id = w[0].id;
          patch.home_midi_name = w[0].name;
        }
        if (body.status !== undefined) {
          if (!["ACTIVE", "SUSPENDED", "CLOSED"].includes(body.status)) return json(400, { ok: false, error: "Bad status." });
          if (body.status !== "ACTIVE" && !(body.status_reason && String(body.status_reason).trim())) {
            return json(400, { ok: false, error: "Give a reason when suspending or closing a member." });
          }
          if (body.status !== member.status) {
            patch.status = body.status;
            patch.status_reason = body.status_reason ? String(body.status_reason).trim() : null;
            patch.status_changed_by = caller.staff.id;
            patch.status_changed_at = new Date().toISOString();
          }
        }
        // Marketing consent can be withdrawn here (opt-out); opt-in only comes from the member.
        if (body.marketing_opt_out === true) {
          patch.marketing_sms_optin = false;
          patch.marketing_whatsapp_optin = false;
          patch.marketing_opt_out_at = new Date().toISOString();
        }
        const r = await sb("/rest/v1/clicka_spaza_members?id=eq." + id, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch) });
        const rows = await r.json();
        if (!r.ok) return json(200, { ok: false, error: JSON.stringify(rows).slice(0, 300) });
        return json(200, { ok: true, member: Array.isArray(rows) ? rows[0] : rows });
      }
    }

    // ----- wholesalers -----
    if (resource === "wholesalers") {
      if (method === "GET") {
        let path = "/rest/v1/clicka_member_wholesalers?select=*&order=province.asc.nullslast,name.asc";
        if (role === "ppm_agent") {
          const mine = myMidiIds(caller);
          if (!mine.length) return json(200, { ok: true, wholesalers: [] });
          path += "&id=" + enc(inList(mine));
        }
        const ws = await fetchAll(path, 5000);
        const counts = {};
        (await fetchAll("/rest/v1/clicka_spaza_members?select=home_midi_id", 100000)).forEach((m) => {
          counts[m.home_midi_id] = (counts[m.home_midi_id] || 0) + 1;
        });
        ws.forEach((w) => (w.members = counts[w.id] || 0));
        return json(200, { ok: true, wholesalers: ws });
      }
      if (!ADMIN_ONLY.includes(role)) return json(403, { ok: false, error: "Editing wholesalers is limited to Admin." });
      if (method === "POST") {
        if (!body.name || !String(body.name).trim()) return json(400, { ok: false, error: "Name is required." });
        const id = body.id ? String(body.id).trim() : "WN-" + Date.now().toString(36).toUpperCase();
        const r = await sb("/rest/v1/clicka_member_wholesalers", {
          method: "POST", headers: { Prefer: "return=representation" },
          body: JSON.stringify([{ id, name: String(body.name).trim(), province: body.province || null, area: body.area || null, town: body.town || null, midi_id: isUuid(body.midi_id) ? body.midi_id : null }]),
        });
        const rows = await r.json();
        if (!r.ok) return json(200, { ok: false, error: JSON.stringify(rows).slice(0, 300) });
        return json(200, { ok: true, wholesaler: rows[0] });
      }
      if (method === "PATCH") {
        if (!qs.id) return json(400, { ok: false, error: "id is required." });
        const patch = { updated_at: new Date().toISOString() };
        for (const f of ["name", "province", "area", "town", "feed_source"]) if (body[f] !== undefined) patch[f] = body[f] === "" ? null : String(body[f]).trim();
        if (patch.name === null) return json(400, { ok: false, error: "Name can't be empty." });
        if (body.erp_loaded !== undefined) patch.erp_loaded = body.erp_loaded === true;
        if (body.active !== undefined) patch.active = body.active === true;
        if (body.midi_id !== undefined) patch.midi_id = isUuid(body.midi_id) ? body.midi_id : null;
        const r = await sb("/rest/v1/clicka_member_wholesalers?id=eq." + enc(qs.id), { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch) });
        const rows = await r.json();
        if (!r.ok) return json(200, { ok: false, error: JSON.stringify(rows).slice(0, 300) });
        // Keep the denormalised name on members in step with a rename.
        if (patch.name) await sb("/rest/v1/clicka_spaza_members?home_midi_id=eq." + enc(qs.id), { method: "PATCH", body: JSON.stringify({ home_midi_name: patch.name }) });
        return json(200, { ok: true, wholesaler: Array.isArray(rows) ? rows[0] : rows });
      }
    }

    // ----- offers -----
    if (resource === "offers") {
      if (method === "GET") {
        const offers = await fetchAll("/rest/v1/clicka_reward_offers?select=*&order=created_at.desc", 2000);
        const ledger = await fetchAll("/rest/v1/clicka_reward_ledger?select=offer_id,entry_type,amount", 100000);
        const agg = {};
        ledger.forEach((l) => {
          if (!l.offer_id) return;
          const a = (agg[l.offer_id] = agg[l.offer_id] || { earned: 0, paid: 0 });
          if (l.entry_type === "PAYOUT") a.paid += -Number(l.amount); else a.earned += Number(l.amount);
        });
        const brands = await fetchAll("/rest/v1/bi_brands?select=id,name", 500);
        const bmap = Object.fromEntries(brands.map((b) => [b.id, b.name]));
        offers.forEach((o) => {
          const a = agg[o.id] || { earned: 0, paid: 0 };
          o.earned = round2(a.earned); o.paid_out = round2(a.paid); o.outstanding = round2(a.earned - a.paid);
          o.brand_name = o.brand_id != null ? bmap[o.brand_id] || String(o.brand_id) : "All Clicka products";
        });
        return json(200, { ok: true, offers, brands });
      }
      if (!ADMIN_ONLY.includes(role)) return json(403, { ok: false, error: "Creating or editing offers is limited to Admin." });
      let clean;
      try { clean = cleanOffer(body, method === "POST"); } catch (e) { if (e.user) return json(400, { ok: false, error: e.message }); throw e; }
      if (method === "POST") {
        clean.created_by = caller.staff.id;
        const r = await sb("/rest/v1/clicka_reward_offers", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify([clean]) });
        const rows = await r.json();
        if (!r.ok) return json(200, { ok: false, error: JSON.stringify(rows).slice(0, 300) });
        return json(200, { ok: true, offer: rows[0] });
      }
      if (method === "PATCH") {
        if (!isUuid(qs.id)) return json(400, { ok: false, error: "id is required." });
        clean.updated_at = new Date().toISOString();
        const r = await sb("/rest/v1/clicka_reward_offers?id=eq." + qs.id, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(clean) });
        const rows = await r.json();
        if (!r.ok) return json(200, { ok: false, error: JSON.stringify(rows).slice(0, 300) });
        return json(200, { ok: true, offer: Array.isArray(rows) ? rows[0] : rows });
      }
    }

    // ----- ledger -----
    if (resource === "ledger") {
      if (method === "GET") {
        if (role === "ppm_agent") return json(403, { ok: false, error: "The reward ledger is limited to Admin, Supervisor and Regional Manager." });
        let f = "select=*&order=occurred_at.desc";
        if (qs.member_id) f += "&member_id=eq." + enc(qs.member_id);
        if (qs.offer_id) f += "&offer_id=eq." + enc(qs.offer_id);
        if (qs.type) f += "&entry_type=eq." + enc(qs.type);
        if (qs.from) f += "&occurred_at=gte." + enc(qs.from);
        if (qs.to) f += "&occurred_at=lte." + enc(qs.to + "T23:59:59");
        const limit = Math.min(Math.max(parseInt(qs.limit, 10) || 100, 1), 500);
        const offset = Math.max(parseInt(qs.offset, 10) || 0, 0);
        const res = await sb("/rest/v1/clicka_reward_ledger?" + f + "&limit=" + limit + "&offset=" + offset, { headers: { Prefer: "count=exact" } });
        const rows = await res.json();
        const total = parseInt((res.headers.get("content-range") || "").split("/")[1], 10);
        return json(200, { ok: true, entries: Array.isArray(rows) ? rows : [], total: Number.isFinite(total) ? total : null });
      }
      if (method === "POST") {
        if (!ADMIN_ONLY.includes(role)) return json(403, { ok: false, error: "Posting to the ledger is limited to Admin." });
        const type = body.entry_type;
        if (!["ACCRUAL", "PAYOUT", "REVERSAL", "ADJUSTMENT"].includes(type)) return json(400, { ok: false, error: "Pick an entry type." });
        let amt = Number(body.amount);
        if (!Number.isFinite(amt) || amt === 0) return json(400, { ok: false, error: "Enter an amount." });
        if (["PAYOUT", "REVERSAL"].includes(type)) amt = -Math.abs(amt);
        if (type === "ACCRUAL") amt = Math.abs(amt);
        if (["PAYOUT", "ADJUSTMENT", "REVERSAL"].includes(type) && !(body.note && String(body.note).trim())) {
          return json(400, { ok: false, error: "A note is required (payment reference or reason)." });
        }
        let member = null;
        if (body.member_id && isUuid(body.member_id)) {
          member = (await (await sb("/rest/v1/clicka_spaza_members?id=eq." + body.member_id + "&select=id,card_no")).json())[0];
        } else if (body.card_no) {
          member = (await (await sb("/rest/v1/clicka_spaza_members?card_no=eq." + enc(String(body.card_no).trim()) + "&select=id,card_no")).json())[0];
        }
        if (!member) return json(400, { ok: false, error: "Member not found. Use the member's id or card number." });
        let offer = null;
        if (body.offer_id) {
          offer = (await (await sb("/rest/v1/clicka_reward_offers?id=eq." + enc(body.offer_id) + "&select=id,funded_by,brand_id")).json())[0];
          if (!offer) return json(400, { ok: false, error: "Offer not found." });
        }
        const entry = {
          entry_type: type, member_id: member.id, card_no: member.card_no, offer_id: offer ? offer.id : null,
          brand_id: offer ? offer.brand_id : null, funded_by: offer ? offer.funded_by : null,
          amount: round2(amt), status: type === "PAYOUT" ? "PAID" : "CONFIRMED",
          occurred_at: body.occurred_at || new Date().toISOString(), note: body.note ? String(body.note).trim() : null,
          created_by: caller.staff.id,
        };
        const r = await sb("/rest/v1/clicka_reward_ledger", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify([entry]) });
        const rows = await r.json();
        if (!r.ok) return json(200, { ok: false, error: JSON.stringify(rows).slice(0, 300) });
        return json(200, { ok: true, entry: rows[0] });
      }
    }

    // ----- summary -----
    if (resource === "summary" && method === "GET") {
      const out = { ok: true };
      const vis = await visibilityClause(caller);
      const and = vis ? "&and=" + enc("(" + vis + ")") : "";
      const mem = await fetchAll("/rest/v1/clicka_spaza_members?select=status,created_at,home_midi_id,marketing_sms_optin,marketing_whatsapp_optin,photo_path" + and, 100000);
      const cut = Date.now() - 30 * 86400000;
      out.members = {
        total: mem.length,
        active: mem.filter((m) => m.status === "ACTIVE").length,
        last_30_days: mem.filter((m) => new Date(m.created_at).getTime() >= cut).length,
        with_photo: mem.filter((m) => m.photo_path).length,
        sms_opt_in: mem.filter((m) => m.marketing_sms_optin).length,
        whatsapp_opt_in: mem.filter((m) => m.marketing_whatsapp_optin).length,
      };
      if (role !== "ppm_agent") {
        const led = await fetchAll("/rest/v1/clicka_reward_ledger?select=entry_type,amount,funded_by,offer_id", 200000);
        let earned = 0, paid = 0;
        const byFunder = {};
        led.forEach((l) => {
          const a = Number(l.amount);
          const k = l.funded_by || "UNASSIGNED";
          byFunder[k] = byFunder[k] || { earned: 0, paid: 0 };
          if (l.entry_type === "PAYOUT") { paid += -a; byFunder[k].paid += -a; } else { earned += a; byFunder[k].earned += a; }
        });
        Object.values(byFunder).forEach((v) => { v.earned = round2(v.earned); v.paid = round2(v.paid); v.outstanding = round2(v.earned - v.paid); });
        out.rewards = { earned: round2(earned), paid_out: round2(paid), outstanding: round2(earned - paid), entries: led.length, by_funder: byFunder };
      }
      return json(200, out);
    }

    // ----- feed import -----
    if (resource === "feed_import" && method === "POST") {
      if (!ADMIN_ONLY.includes(role)) return json(403, { ok: false, error: "Importing the partner feed is limited to Admin." });
      return json(200, await feedImport(caller, body));
    }

    // ----- export (full, unpaged) -----
    if (resource === "export" && method === "GET") {
      const kind = qs.kind || "members";
      if (kind === "members") {
        const { rows } = await listMembers(caller, qs, true);
        const names = await staffNames();
        rows.forEach((r) => (r.signed_up_by = names[r.signed_up_by_staff_id] || r.agent_name || ""));
        return json(200, { ok: true, kind, rows });
      }
      if (role === "ppm_agent") return json(403, { ok: false, error: "Exports of offers and the ledger are limited to Admin, Supervisor and Regional Manager." });
      if (kind === "offers") {
        return json(200, { ok: true, kind, rows: await fetchAll("/rest/v1/clicka_reward_offers?select=*&order=created_at.desc", 5000) });
      }
      if (kind === "ledger") {
        let f = "select=*&order=occurred_at.asc";
        if (qs.offer_id) f += "&offer_id=eq." + enc(qs.offer_id);
        if (qs.type) f += "&entry_type=eq." + enc(qs.type);
        if (qs.from) f += "&occurred_at=gte." + enc(qs.from);
        if (qs.to) f += "&occurred_at=lte." + enc(qs.to + "T23:59:59");
        return json(200, { ok: true, kind, rows: await fetchAll("/rest/v1/clicka_reward_ledger?" + f, 200000) });
      }
    }

    return json(405, { ok: false, error: "Unknown resource or method." });
  } catch (e) {
    return json(500, { ok: false, error: "Rewards error: " + String(e.message || e).slice(0, 300) });
  }
};
