// admin/netlify/functions/admin-invoices.js
//
// FUNCTION — Clicka: Midi restock invoice capture + reporting.
// A PPM Agent (or Supervisor/Regional Manager/Admin) photographs the actual
// paper invoice a Midi/Wholesaler receives when they restock from an
// upstream source (Makro, a distributor, another Midi, whoever), and
// captures its line items into the system — so Admin gets visibility into
// what's actually flowing INTO a Midi, not just what flows out to spazas.
//
// No OCR/auto-scan yet (deliberately) — every line is matched against the
// existing Supplier Products catalog by search, or added to the catalog on
// the spot if it's genuinely new.
//
// At least one invoice photo is REQUIRED, not optional — this is the audit
// trail proving what was captured matches what the physical invoice says.
// A multi-page invoice can have several photos (clicka_invoice_photos, one
// row per page, in capture order) — there is no cap.
//
// Per-brand / per-client visibility: a supplier product always belongs to
// one brand (clicka_supplier_products.brand_id). A caller with a
// clicka_staff_scope row of scope_type "brand" (the SAME scope used to
// white-label Spaza Onboard for a client's staff, see admin-users.js /
// admin-whoami.js) only ever sees/exports invoice LINES for that brand —
// enforced here, not just hidden in the UI. A single invoice can therefore
// show fewer lines (or vanish entirely) for a brand-scoped viewer than it
// has in full. Admin is never brand-restricted, matching "admins are
// otherwise unscoped by design" elsewhere in this codebase. Supervisor/
// Regional Manager/PPM Agent without a brand scope assigned see everything
// their role/Midi access already allows — brand scope is an ADDITIONAL
// narrowing, not a requirement to see anything at all.
//
// Midi access: PPM Agent is limited to Midi(s) in their own
// clicka_staff_scope (scope_type "midi") — identical to admin-midi-
// products.js. Admin/Supervisor/Regional Manager can capture/view for any
// Midi (same trio + breadth as Midis / Stores management everywhere else).
//
// GET  ?action=sources                        -> every known invoice source
//                                                 {id, name}, for the
//                                                 capture screen's
//                                                 datalist/combobox.
// GET  ?action=search_products&search=...      -> cross-brand product search
//                                                 (barcode/SKU/description)
//                                                 for matching an invoice
//                                                 line against the catalog.
// POST ?action=quick_add_product                -> add a brand-new catalog
//                                                 product mid-capture, when
//                                                 search comes up empty.
//   body: { brand_id, description, barcode?, sku?, category_id?,
//           pack_size?, size? }
//   (No price/photo here — that's the full Supplier Products screen's job;
//   this is the minimum needed to put a line on an invoice.)
// POST ?action=create_invoice                    -> capture one invoice.
//   body: { midi_id, invoice_number, invoice_date, source_id?, source_name?,
//           notes?,
//           photos: [{ base64, content_type? }, ...]   (at least one, required)
//           lines: [{ supplier_product_id, line_description?, quantity,
//                     line_amount }] }
//   Exactly one of source_id / source_name — source_name creates (or
//   reuses, by exact name) a clicka_invoice_sources row.
//   line_amount is the TOTAL printed on the invoice for that line — NOT a
//   per-unit price. Wholesalers apply discounts/specials that don't divide
//   evenly, so asking the field team to do that math by hand was producing
//   numbers that didn't match the paper. unit_cost (used for the BI
//   breakdown) is derived here as line_amount / quantity — the one place
//   that division happens, so it's never guessed twice.
//   Line items are OPTIONAL — this is the important bit for the field team:
//   pay is tied to invoices captured, and an agent who can't match a
//   product in the catalog must never be blocked from saving the invoice
//   itself. The four things that ARE always required are midi_id,
//   invoice_number, invoice_date, and source (id or name) — plus the
//   photo(s), which are the audit proof. Products can be added later by
//   editing/re-opening the flow, or just left off entirely.
//
// GET  (no action, or ?id=...)                   -> Admin app's Invoices
//   tab. List (with line items + a running total) or one invoice's detail.
//   Filters on the list: &midi_id=&brand_id=&from=&to=&search= (invoice
//   number, source name, or Midi name). Admin/Supervisor/Regional Manager
//   only — PPM Agent captures via Spaza Onboard but doesn't get the
//   cross-Midi reporting view.
//
// Self-test (no auth needed, no data touched):
//   /.netlify/functions/admin-invoices?selftest=1

const { SUPABASE_URL, json, sb, getCaller } = require("./_auth");

const BUCKET = "clicka-invoice-photos";
const CAPTURE_ROLES = ["admin", "supervisor", "regional_manager", "ppm_agent"];
const REPORT_ROLES = ["admin", "supervisor", "regional_manager"];

async function myMidiIds(caller) {
  return (caller.scope || []).filter((s) => s.scope_type === "midi").map((s) => s.midi_id);
}

// The one brand a caller is locked to, if any — null means "not brand-
// restricted" (Admin always; anyone else who simply has no brand assigned).
function callerBrandLock(caller) {
  if (caller.staff.role === "admin") return null;
  const row = (caller.scope || []).find((s) => s.scope_type === "brand");
  return row ? row.brand_id : null;
}

async function signPhoto(path) {
  if (!path) return null;
  const res = await sb("/storage/v1/object/sign/" + BUCKET + "/" + path, {
    method: "POST",
    body: JSON.stringify({ expiresIn: 3600 }),
  });
  if (!res.ok) return null;
  const body = await res.json();
  if (!body.signedURL) return null;
  return SUPABASE_URL + "/storage/v1" + body.signedURL;
}

async function uploadPhoto(path, base64, contentType) {
  const bytes = Buffer.from(base64, "base64");
  const res = await sb("/storage/v1/object/" + BUCKET + "/" + path, {
    method: "POST",
    headers: { "Content-Type": contentType || "image/jpeg", "x-upsert": "true" },
    body: bytes,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error("Storage upload failed: " + res.status + " " + t.slice(0, 200));
  }
  return path;
}

async function assertCanUseMidi(caller, midiId) {
  if (caller.staff.role === "ppm_agent") {
    const mine = await myMidiIds(caller);
    if (!mine.includes(midiId)) return "This Midi isn't assigned to you.";
  }
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

  const qs = event.queryStringParameters || {};
  if (qs.selftest === "1") return json(200, { ok: true, world: "CLICKA-ADMIN" });

  const caller = await getCaller(event);
  if (!caller || !caller.staff) return json(401, { ok: false, error: "Not signed in." });
  if (caller.staff.status === "inactive") return json(403, { ok: false, error: "Account deactivated." });
  const role = caller.staff.role;

  // ---------- GET ?action=sources ----------
  if (event.httpMethod === "GET" && qs.action === "sources") {
    if (!CAPTURE_ROLES.includes(role)) return json(403, { ok: false, error: "Invoice capture isn't available on this account." });
    const res = await sb("/rest/v1/clicka_invoice_sources?select=id,name&order=name");
    const rows = await res.json();
    return json(200, { ok: true, sources: Array.isArray(rows) ? rows : [] });
  }

  // ---------- GET ?action=categories ----------
  // Cross-brand category list for the capture screen's "narrow it down by
  // category first" browse step — a Wholesaler invoice can carry any brand's
  // stock, so this deliberately isn't scoped to one supplier the way
  // admin-categories.js is.
  if (event.httpMethod === "GET" && qs.action === "categories") {
    if (!CAPTURE_ROLES.includes(role)) return json(403, { ok: false, error: "Invoice capture isn't available on this account." });
    const res = await sb("/rest/v1/clicka_categories?select=id,name,brand_id&order=name");
    const rows = await res.json();
    const cats = Array.isArray(rows) ? rows : [];
    const brandIds = [...new Set(cats.map((c) => c.brand_id).filter(Boolean))];
    let brandsById = {};
    if (brandIds.length) {
      const brandRes = await sb("/rest/v1/bi_brands?id=in.(" + brandIds.join(",") + ")&select=id,name");
      const brandRows = await brandRes.json();
      brandsById = Object.fromEntries((Array.isArray(brandRows) ? brandRows : []).map((b) => [b.id, b.name]));
    }
    const categories = cats.map((c) => ({ ...c, brand_name: brandsById[c.brand_id] || null }));
    return json(200, { ok: true, categories });
  }

  // ---------- GET ?action=search_products ----------
  // Either a text search (barcode/SKU/description, min 2 chars) or a browse
  // by category_id (or both together, to search within a chosen category) —
  // picking a Category first is how the field team narrows down a big
  // Wholesaler catalog before typing anything.
  if (event.httpMethod === "GET" && qs.action === "search_products") {
    if (!CAPTURE_ROLES.includes(role)) return json(403, { ok: false, error: "Invoice capture isn't available on this account." });
    const term = (qs.search || "").trim();
    const categoryId = qs.category_id || null;
    if (!categoryId && term.length < 2) return json(200, { ok: true, items: [] });
    const s = term.replace(/[,()]/g, "");
    let url = "/rest/v1/clicka_supplier_products?select=id,description,sku,barcode,pack_size,size,brand_id,category_id,unit_price_inc_vat&order=description&limit=40";
    if (categoryId) url += "&category_id=eq." + encodeURIComponent(categoryId);
    if (term.length >= 2) url += "&or=(description.ilike.*" + s + "*,sku.ilike.*" + s + "*,barcode.ilike.*" + s + "*)";
    const res = await sb(url);
    const rows = await res.json();
    const products = Array.isArray(rows) ? rows : [];
    const brandIds = [...new Set(products.map((p) => p.brand_id).filter(Boolean))];
    let brandsById = {};
    if (brandIds.length) {
      const brandRes = await sb("/rest/v1/bi_brands?id=in.(" + brandIds.join(",") + ")&select=id,name");
      const brandRows = await brandRes.json();
      brandsById = Object.fromEntries((Array.isArray(brandRows) ? brandRows : []).map((b) => [b.id, b.name]));
    }
    const items = products.map((p) => ({ ...p, brand_name: brandsById[p.brand_id] || null }));
    return json(200, { ok: true, items });
  }

  // ---------- POST ?action=quick_add_product ----------
  if (event.httpMethod === "POST" && qs.action === "quick_add_product") {
    if (!CAPTURE_ROLES.includes(role)) return json(403, { ok: false, error: "Invoice capture isn't available on this account." });
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { ok: false, error: "Invalid JSON body." }); }
    if (!body.brand_id) return json(400, { ok: false, error: "Pick which supplier/brand this product belongs to." });
    if (!body.description || !String(body.description).trim()) return json(400, { ok: false, error: "A description is required." });

    const barcode = body.barcode ? String(body.barcode).trim() : ("PENDING-" + Date.now());
    const res = await sb("/rest/v1/clicka_supplier_products?on_conflict=brand_id,barcode", {
      method: "POST",
      headers: { Prefer: "return=representation,resolution=merge-duplicates" },
      body: JSON.stringify([{
        brand_id: body.brand_id,
        category_id: body.category_id || null,
        sku: body.sku ? String(body.sku).trim() : null,
        barcode,
        description: String(body.description).trim(),
        pack_size: body.pack_size ? String(body.pack_size).trim() : null,
        size: body.size ? String(body.size).trim() : null,
      }]),
    });
    const rows = await res.json();
    if (!res.ok || !Array.isArray(rows) || !rows.length) return json(200, { ok: false, error: JSON.stringify(rows).slice(0, 300) });

    const brandRes = await sb("/rest/v1/bi_brands?id=eq." + body.brand_id + "&select=name");
    const brandRows = await brandRes.json();
    const product = rows[0];
    return json(200, { ok: true, product: { ...product, brand_name: (Array.isArray(brandRows) && brandRows[0]) ? brandRows[0].name : null } });
  }

  // ---------- POST ?action=create_invoice ----------
  if (event.httpMethod === "POST" && qs.action === "create_invoice") {
    if (!CAPTURE_ROLES.includes(role)) return json(403, { ok: false, error: "Invoice capture isn't available on this account." });
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { ok: false, error: "Invalid JSON body." }); }

    const { midi_id, invoice_number, invoice_date } = body;
    if (!midi_id) return json(400, { ok: false, error: "Pick which Midi this invoice is for." });
    if (!invoice_number || !String(invoice_number).trim()) return json(400, { ok: false, error: "Invoice number is required." });
    if (!invoice_date || !String(invoice_date).trim()) return json(400, { ok: false, error: "Invoice date is required." });
    const lines = Array.isArray(body.lines) ? body.lines.filter((l) => l && l.supplier_product_id) : [];
    const photos = Array.isArray(body.photos) ? body.photos.filter((p) => p && p.base64) : [];
    if (!photos.length) return json(400, { ok: false, error: "At least one photo of the invoice is required — this is the audit proof of what was captured." });

    const denyReason = await assertCanUseMidi(caller, midi_id);
    if (denyReason) return json(403, { ok: false, error: denyReason });

    let sourceId = body.source_id || null;
    if (!sourceId && body.source_name && String(body.source_name).trim()) {
      const srcRes = await sb("/rest/v1/clicka_invoice_sources?on_conflict=name", {
        method: "POST",
        headers: { Prefer: "return=representation,resolution=merge-duplicates" },
        body: JSON.stringify([{ name: String(body.source_name).trim() }]),
      });
      const srcRows = await srcRes.json();
      if (srcRes.ok && Array.isArray(srcRows) && srcRows.length) sourceId = srcRows[0].id;
    }
    if (!sourceId) return json(400, { ok: false, error: "Where the invoice came from (bought from) is required." });

    const invRes = await sb("/rest/v1/clicka_invoices", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify([{
        midi_id,
        invoice_number: String(invoice_number).trim(),
        invoice_date: String(invoice_date).trim(),
        source_id: sourceId,
        captured_by_staff_id: caller.staff.id,
        notes: body.notes ? String(body.notes).trim() : null,
      }]),
    });
    const invRows = await invRes.json();
    if (!invRes.ok || !Array.isArray(invRows) || !invRows.length) {
      return json(200, { ok: false, error: "Couldn't save the invoice: " + JSON.stringify(invRows).slice(0, 300) });
    }
    const invoice = invRows[0];

    // Upload every page, in order, THEN write the header rows — if any
    // upload fails partway through, the invoice header still exists (never
    // silently lost) but is reported back as incomplete so the agent knows
    // to add the missing page(s) rather than assume it's fully on record.
    const photoRows = [];
    for (let i = 0; i < photos.length; i++) {
      const p = photos[i];
      try {
        const ext = (p.content_type && p.content_type.includes("png")) ? "png" : "jpg";
        const path = "invoices/" + midi_id + "/" + invoice.id + "/" + (i + 1) + "-" + Date.now() + "." + ext;
        await uploadPhoto(path, p.base64, p.content_type);
        photoRows.push({ invoice_id: invoice.id, photo_url: path, sort_order: i });
      } catch (e) {
        return json(200, {
          ok: false,
          error: "Invoice saved but photo " + (i + 1) + " of " + photos.length + " failed to upload: " + String(e.message || e),
          invoice_id: invoice.id,
        });
      }
    }
    if (photoRows.length) {
      await sb("/rest/v1/clicka_invoice_photos", { method: "POST", body: JSON.stringify(photoRows) });
    }

    // Lines are optional (see comment above the doc block for this action) —
    // an agent who couldn't match anything in the catalog still gets a
    // fully saved, audit-proof invoice with zero products on it, rather
    // than being blocked from capturing it at all.
    let linesSaved = 0;
    if (lines.length) {
      const linePayload = lines.map((l) => {
        const quantity = Math.max(0, Number(l.quantity) || 0) || 1;
        // line_amount is the TOTAL for this line as printed on the invoice
        // (post-discount) — the field team enters that directly rather than
        // computing a per-unit price by hand. unit_cost, which the BI
        // breakdown and clicka_invoice_lines.line_total both key off, is
        // derived from it here, in one place, rounded to 4dp so quantity *
        // unit_cost reconstructs the entered total to the cent.
        const lineAmount = Math.max(0, Number(l.line_amount) || 0);
        const unitCost = Number((lineAmount / quantity).toFixed(4));
        return {
          invoice_id: invoice.id,
          supplier_product_id: l.supplier_product_id,
          line_description: l.line_description ? String(l.line_description).trim() : null,
          quantity,
          unit_cost: unitCost,
        };
      });
      const lineRes = await sb("/rest/v1/clicka_invoice_lines", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(linePayload),
      });
      const lineRows = await lineRes.json();
      if (!lineRes.ok) {
        // Header is saved either way (never leaves an orphaned photo with
        // literally nothing on record) — surface the line failure clearly so
        // the agent knows to retry rather than assuming it all went through.
        return json(200, { ok: false, error: "Invoice saved but line items failed: " + JSON.stringify(lineRows).slice(0, 300), invoice_id: invoice.id });
      }
      linesSaved = Array.isArray(lineRows) ? lineRows.length : 0;
    }

    return json(200, { ok: true, invoice_id: invoice.id, lines_saved: linesSaved });
  }

  if (event.httpMethod !== "GET") return json(405, { ok: false, error: "Method not allowed." });

  // ---------- GET: Admin app reporting view (list or one invoice) ----------
  if (!REPORT_ROLES.includes(role)) {
    return json(403, { ok: false, error: "Viewing captured invoices is limited to Admin, Supervisor, and Regional Manager." });
  }

  // Non-admin: a brand scope, if assigned, always wins over whatever the
  // query string says — closes off probing another brand by hand-editing
  // the URL. Unscoped non-admin can still voluntarily filter via qs.brand_id.
  const brandLock = callerBrandLock(caller);
  const effectiveBrandId = role === "admin" ? (qs.brand_id || null) : (brandLock || qs.brand_id || null);

  let invoiceUrl = "/rest/v1/clicka_invoices?select=*&order=captured_at.desc&limit=1000";
  if (qs.id) invoiceUrl = "/rest/v1/clicka_invoices?id=eq." + qs.id + "&select=*";
  else {
    if (qs.midi_id) invoiceUrl += "&midi_id=eq." + qs.midi_id;
    if (qs.from) invoiceUrl += "&captured_at=gte." + qs.from;
    if (qs.to) invoiceUrl += "&captured_at=lte." + qs.to;
  }
  if (role === "ppm_agent") {
    // Not reachable today (ppm_agent isn't in REPORT_ROLES) — left as a
    // guard in case that ever changes, so it fails safe instead of open.
    const mine = await myMidiIds(caller);
    if (!mine.length) return json(200, { ok: true, invoices: [] });
    invoiceUrl += "&midi_id=in.(" + mine.join(",") + ")";
  }

  const invRes = await sb(invoiceUrl);
  const invoiceRows = await invRes.json();
  let invoices = Array.isArray(invoiceRows) ? invoiceRows : [];
  if (!invoices.length) return json(200, { ok: true, invoices: [] });

  const invoiceIds = invoices.map((i) => i.id);
  const linesRes = await sb("/rest/v1/clicka_invoice_lines?invoice_id=in.(" + invoiceIds.join(",") + ")&select=*");
  const lineRows = await linesRes.json();
  const allLines = Array.isArray(lineRows) ? lineRows : [];

  const productIds = [...new Set(allLines.map((l) => l.supplier_product_id).filter(Boolean))];
  let productsById = {};
  if (productIds.length) {
    const prodRes = await sb("/rest/v1/clicka_supplier_products?id=in.(" + productIds.join(",") + ")&select=id,description,barcode,sku,brand_id");
    const prodRows = await prodRes.json();
    productsById = Object.fromEntries((Array.isArray(prodRows) ? prodRows : []).map((p) => [p.id, p]));
  }
  const brandIdsInPlay = [...new Set(Object.values(productsById).map((p) => p.brand_id).filter(Boolean))];
  let brandsById = {};
  if (brandIdsInPlay.length) {
    const brandRes = await sb("/rest/v1/bi_brands?id=in.(" + brandIdsInPlay.join(",") + ")&select=id,name");
    const brandRows = await brandRes.json();
    brandsById = Object.fromEntries((Array.isArray(brandRows) ? brandRows : []).map((b) => [b.id, b.name]));
  }

  const midiIds = [...new Set(invoices.map((i) => i.midi_id).filter(Boolean))];
  let midisById = {};
  if (midiIds.length) {
    const midiRes = await sb("/rest/v1/clicka_midis?id=in.(" + midiIds.join(",") + ")&select=id,name");
    const midiRows = await midiRes.json();
    midisById = Object.fromEntries((Array.isArray(midiRows) ? midiRows : []).map((m) => [m.id, m.name]));
  }

  const sourceIds = [...new Set(invoices.map((i) => i.source_id).filter(Boolean))];
  let sourcesById = {};
  if (sourceIds.length) {
    const srcRes = await sb("/rest/v1/clicka_invoice_sources?id=in.(" + sourceIds.join(",") + ")&select=id,name");
    const srcRows = await srcRes.json();
    sourcesById = Object.fromEntries((Array.isArray(srcRows) ? srcRows : []).map((s) => [s.id, s.name]));
  }

  const staffIds = [...new Set(invoices.map((i) => i.captured_by_staff_id).filter(Boolean))];
  let staffById = {};
  if (staffIds.length) {
    const staffRes = await sb("/rest/v1/clicka_staff?id=in.(" + staffIds.join(",") + ")&select=id,first_name,last_name");
    const staffRows = await staffRes.json();
    staffById = Object.fromEntries((Array.isArray(staffRows) ? staffRows : []).map((s) => [s.id, s.first_name + " " + s.last_name]));
  }

  const linesByInvoice = {};
  for (const l of allLines) (linesByInvoice[l.invoice_id] = linesByInvoice[l.invoice_id] || []).push(l);

  // Photos are only fetched (and signed) for the single-invoice detail
  // view — no point signing every photo of every invoice on the list.
  let photosByInvoice = {};
  if (qs.id) {
    const photoRes = await sb("/rest/v1/clicka_invoice_photos?invoice_id=in.(" + invoiceIds.join(",") + ")&select=*&order=sort_order.asc");
    const photoRows = await photoRes.json();
    for (const p of Array.isArray(photoRows) ? photoRows : []) {
      (photosByInvoice[p.invoice_id] = photosByInvoice[p.invoice_id] || []).push(p);
    }
  }

  let enriched = await Promise.all(invoices.map(async (inv) => {
    let lines = (linesByInvoice[inv.id] || []).map((l) => {
      const p = productsById[l.supplier_product_id] || {};
      return {
        id: l.id,
        supplier_product_id: l.supplier_product_id,
        description: l.line_description || p.description || "Unknown product",
        barcode: p.barcode || null,
        sku: p.sku || null,
        brand_id: p.brand_id || null,
        brand_name: p.brand_id ? (brandsById[p.brand_id] || "Unknown") : "Unknown",
        quantity: Number(l.quantity) || 0,
        unit_cost: Number(l.unit_cost) || 0,
        line_total: Number(l.line_total) || 0,
      };
    });
    // The per-line brand enforcement point: filter to the caller's locked
    // brand (Admin, or anyone with no brand scope, sees every line).
    if (effectiveBrandId) lines = lines.filter((l) => String(l.brand_id) === String(effectiveBrandId));

    return {
      id: inv.id,
      midi_id: inv.midi_id,
      midi_name: midisById[inv.midi_id] || "Unknown Midi",
      invoice_number: inv.invoice_number,
      invoice_date: inv.invoice_date || null,
      source_name: inv.source_id ? (sourcesById[inv.source_id] || "Unknown") : null,
      captured_by: staffById[inv.captured_by_staff_id] || "Unknown",
      captured_at: inv.captured_at,
      notes: inv.notes,
      photos: qs.id
        ? await Promise.all((photosByInvoice[inv.id] || []).map(async (p) => ({ id: p.id, signed_url: await signPhoto(p.photo_url) })))
        : [],
      lines,
      line_count: lines.length,
      total: lines.reduce((sum, l) => sum + l.line_total, 0),
    };
  }));

  // A brand-scoped viewer's filter can leave an invoice with zero relevant
  // lines (it was entirely some other brand's stock on that delivery) —
  // drop it rather than showing an empty shell.
  if (effectiveBrandId) enriched = enriched.filter((i) => i.line_count > 0);

  if (qs.search) {
    const s = qs.search.toLowerCase();
    enriched = enriched.filter((i) =>
      (i.invoice_number || "").toLowerCase().includes(s) ||
      (i.source_name || "").toLowerCase().includes(s) ||
      (i.midi_name || "").toLowerCase().includes(s)
    );
  }

  if (qs.id) {
    return json(200, { ok: true, invoice: enriched[0] || null });
  }
  return json(200, { ok: true, invoices: enriched });
};
