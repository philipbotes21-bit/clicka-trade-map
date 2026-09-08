// admin/netlify/functions/admin-duplicates.js
//
// FUNCTION — Clicka: duplicate store detection + merge.
// Spaza shops get captured more than once — same owner walks past a
// different Agent, a Collection Client gets quick-added again, a typo in
// the name. This scans for likely duplicates on a few fuzzy signals and
// lets Admin/Supervisor/Regional Manager review each pair side by side:
// merge them (keeps one record, moves every order/visit/survey response
// onto it, never deletes the loser — just retires it via merged_into_id),
// or dismiss the pair as genuinely two different stores.
//
// Matching signals ("Balanced" sensitivity):
//   - Same contact number (exact, digits only)               -> strong
//   - GPS within 30m of each other (both stores have a pin)  -> strong
//   - Same province AND trading name >=90% similar           -> medium
//   - Same province AND trading name >=82% similar
//       AND owner full name >=82% similar                    -> medium
// Any ONE strong signal, or the medium combo, flags the pair. This is a
// scan-on-demand tool, not a live check — results are cached in
// clicka_duplicate_candidates so the Dashboard count is cheap to show and
// a dismissed pair never resurfaces.
//
// GET  ?count=1        -> { ok, pending_count } — cheap, for the Dashboard.
// GET  (no params)      -> every pending candidate pair, enriched with both
//                          stores' details, activity counts, reasons, and
//                          a suggested_keep_id.
// POST ?action=scan     -> re-run detection, cache newly-found pairs as
//                          'pending' (never resurrects a dismissed/merged
//                          pair for the same two stores). Admin/Supervisor/
//                          Regional Manager only.
// POST ?action=merge    -> body: { candidate_id?, keep_id, merge_id }
//                          Reassigns clicka_orders, clicka_staff_scope,
//                          clicka_store_visits, clicka_survey_responses
//                          from merge_id to keep_id, then sets merge_id's
//                          merged_into_id/merged_at. Any other pending
//                          candidate involving merge_id is cleared.
// POST ?action=dismiss  -> body: { candidate_id } -> marks 'dismissed'.
//
// Self-test (no auth needed, no data touched):
//   /.netlify/functions/admin-duplicates?selftest=1

const { json, sb, getCaller } = require("./_auth");

const GPS_RADIUS_M = 30;
const NAME_SIM_HIGH = 0.90;   // name alone is enough at this similarity
const NAME_SIM_MED = 0.82;    // needs owner similarity too, below this
const OWNER_SIM_MED = 0.82;
const MAX_PREFIX_BUCKET = 400; // safety valve against a pathological bucket

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function normalizeStr(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = row;
  }
  return prev[b.length];
}

function similarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (!maxLen) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

async function resolveScopeProvinces(scope) {
  const direct = scope.filter((s) => s.scope_type === "province").map((s) => s.province);
  const regionIds = scope.filter((s) => s.scope_type === "region").map((s) => s.region_id);
  if (!regionIds.length) return [...new Set(direct)];
  const res = await sb("/rest/v1/bi_regions?id=in.(" + regionIds.join(",") + ")&select=id,province");
  const rows = await res.json();
  const fromRegions = Array.isArray(rows) ? rows.map((r) => r.province) : [];
  return [...new Set([...direct, ...fromRegions])].filter(Boolean);
}

function pairKey(idA, idB) {
  return idA < idB ? [idA, idB] : [idB, idA];
}

// ---------------------------------------------------------------- scan ----
async function runScan() {
  const storesRes = await sb(
    "/rest/v1/clicka_registrations?merged_into_id=is.null&select=id,trading_name,owner_full_name,contact_number,province,gps_lat,gps_lng,created_at&limit=8000"
  );
  const storeRows = await storesRes.json();
  const stores = Array.isArray(storeRows) ? storeRows : [];

  const foundKey = new Set(); // "idA|idB" already flagged this scan
  const found = []; // { a, b, reasons: [...] }

  function flag(a, b, reason) {
    const [x, y] = pairKey(a.id, b.id);
    const key = x + "|" + y;
    if (foundKey.has(key + "|" + reason)) return;
    foundKey.add(key + "|" + reason);
    let entry = found.find((f) => f.aId === x && f.bId === y);
    if (!entry) { entry = { aId: x, bId: y, reasons: [] }; found.push(entry); }
    if (!entry.reasons.includes(reason)) entry.reasons.push(reason);
  }

  // ---- signal: same contact number ----
  const byContact = {};
  stores.forEach((s) => {
    const c = (s.contact_number || "").replace(/[^0-9]/g, "");
    if (c.length >= 7) (byContact[c] = byContact[c] || []).push(s);
  });
  Object.values(byContact).forEach((group) => {
    if (group.length < 2) return;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) flag(group[i], group[j], "Same contact number");
    }
  });

  // ---- signal: GPS within 30m — pairwise per province (cheap trig, and
  // real per-province store counts stay well within what this can chew
  // through inside a function invocation). ----
  const byProvinceGps = {};
  stores.filter((s) => s.gps_lat != null && s.gps_lng != null).forEach((s) => {
    (byProvinceGps[s.province || ""] = byProvinceGps[s.province || ""] || []).push(s);
  });
  Object.values(byProvinceGps).forEach((group) => {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const d = haversineMeters(group[i].gps_lat, group[i].gps_lng, group[j].gps_lat, group[j].gps_lng);
        if (d <= GPS_RADIUS_M) flag(group[i], group[j], "GPS " + Math.round(d) + "m apart");
      }
    }
  });

  // ---- signal: similar trading name / owner name — bucketed by province +
  // first 3 characters of the normalized name, since Levenshtein per pair
  // is far more expensive than a distance check and a large flat province
  // bucket could time the function out. This misses a duplicate whose name
  // was typed with a different leading word — an accepted v1 trade-off. ----
  const byBucket = {};
  stores.forEach((s) => {
    const norm = normalizeStr(s.trading_name);
    if (!norm) return;
    const key = (s.province || "") + "|" + norm.slice(0, 3);
    (byBucket[key] = byBucket[key] || []).push(s);
  });
  Object.values(byBucket).forEach((group) => {
    if (group.length < 2 || group.length > MAX_PREFIX_BUCKET) return;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        const nameSim = similarity(normalizeStr(a.trading_name), normalizeStr(b.trading_name));
        if (nameSim >= NAME_SIM_HIGH) {
          flag(a, b, "Similar name (" + Math.round(nameSim * 100) + "%)");
        } else if (nameSim >= NAME_SIM_MED && a.owner_full_name && b.owner_full_name) {
          const ownerSim = similarity(normalizeStr(a.owner_full_name), normalizeStr(b.owner_full_name));
          if (ownerSim >= OWNER_SIM_MED) flag(a, b, "Similar name & owner (" + Math.round(nameSim * 100) + "% / " + Math.round(ownerSim * 100) + "%)");
        }
      }
    }
  });

  return found; // [{ aId, bId, reasons: [...] }]
}

// -------------------------------------------------------------- enrich ----
async function enrichCandidates(rows) {
  if (!rows.length) return [];
  const storeIds = [...new Set(rows.flatMap((r) => [r.store_id_a, r.store_id_b]))];
  const storesRes = await sb("/rest/v1/clicka_registrations?id=in.(" + storeIds.join(",") + ")&select=id,trading_name,owner_full_name,contact_number,province,region_id,outlet_address,status,gps_lat,gps_lng,created_at,merged_into_id");
  const storeRows = await storesRes.json();
  const storesById = Object.fromEntries((Array.isArray(storeRows) ? storeRows : []).map((s) => [s.id, s]));

  const regionIds = [...new Set(Object.values(storesById).map((s) => s.region_id).filter(Boolean))];
  let regionsById = {};
  if (regionIds.length) {
    const rres = await sb("/rest/v1/bi_regions?id=in.(" + regionIds.join(",") + ")&select=id,name");
    const rrows = await rres.json();
    regionsById = Object.fromEntries((rrows || []).map((r) => [r.id, r.name]));
  }

  const [ordersRes, visitsRes, surveysRes] = await Promise.all([
    sb("/rest/v1/clicka_orders?store_id=in.(" + storeIds.join(",") + ")&select=store_id"),
    sb("/rest/v1/clicka_store_visits?store_id=in.(" + storeIds.join(",") + ")&select=store_id"),
    sb("/rest/v1/clicka_survey_responses?store_id=in.(" + storeIds.join(",") + ")&select=store_id"),
  ]);
  const countBy = (rowsArr) => {
    const m = {};
    (Array.isArray(rowsArr) ? rowsArr : []).forEach((r) => { m[r.store_id] = (m[r.store_id] || 0) + 1; });
    return m;
  };
  const orderCounts = countBy(await ordersRes.json());
  const visitCounts = countBy(await visitsRes.json());
  const surveyCounts = countBy(await surveysRes.json());

  function scoreStore(s) {
    if (!s) return -1;
    const counts = { orders: orderCounts[s.id] || 0, visits: visitCounts[s.id] || 0, surveys: surveyCounts[s.id] || 0 };
    let score = counts.orders * 3 + counts.visits * 2 + counts.surveys * 1;
    if (s.gps_lat != null) score += 1;
    if (s.owner_full_name) score += 1;
    if (s.contact_number) score += 1;
    return score;
  }
  function describeStore(s) {
    if (!s) return null;
    return {
      id: s.id,
      trading_name: s.trading_name,
      owner_full_name: s.owner_full_name,
      contact_number: s.contact_number,
      province: s.province,
      region_name: s.region_id ? (regionsById[s.region_id] || null) : null,
      outlet_address: s.outlet_address,
      status: s.status,
      gps_lat: s.gps_lat,
      gps_lng: s.gps_lng,
      created_at: s.created_at,
      order_count: orderCounts[s.id] || 0,
      visit_count: visitCounts[s.id] || 0,
      survey_response_count: surveyCounts[s.id] || 0,
    };
  }

  return rows
    .map((r) => {
      const a = storesById[r.store_id_a];
      const b = storesById[r.store_id_b];
      if (!a || !b || a.merged_into_id || b.merged_into_id) return null; // one side already resolved elsewhere
      const scoreA = scoreStore(a), scoreB = scoreStore(b);
      let suggestedKeepId = scoreA >= scoreB ? a.id : b.id;
      if (scoreA === scoreB) suggestedKeepId = new Date(a.created_at) <= new Date(b.created_at) ? a.id : b.id;
      return {
        candidate_id: r.id,
        reasons: r.reasons || [],
        detected_at: r.detected_at,
        suggested_keep_id: suggestedKeepId,
        store_a: describeStore(a),
        store_b: describeStore(b),
      };
    })
    .filter(Boolean);
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

  const qs = event.queryStringParameters || {};
  if (qs.selftest === "1") return json(200, { ok: true, world: "CLICKA-ADMIN" });

  const caller = await getCaller(event);
  if (!caller || !caller.staff) return json(401, { ok: false, error: "Not signed in." });
  if (caller.staff.status === "inactive") return json(403, { ok: false, error: "Account deactivated." });
  const role = caller.staff.role;
  if (!["admin", "supervisor", "regional_manager"].includes(role)) {
    return json(403, { ok: false, error: "Duplicate review is limited to Admin, Supervisor, and Regional Manager." });
  }

  let allowedProvinces = null;
  if (role !== "admin") {
    allowedProvinces = await resolveScopeProvinces(caller.scope || []);
  }

  // ---------- POST: scan / merge / dismiss ----------
  if (event.httpMethod === "POST") {
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { ok: false, error: "Invalid JSON body." }); }

    if (qs.action === "scan") {
      const found = await runScan();
      let inserted = 0;
      for (const f of found) {
        const res = await sb("/rest/v1/clicka_duplicate_candidates", {
          method: "POST",
          // unique(store_id_a,store_id_b) — ON CONFLICT DO NOTHING so a
          // pair that's already pending/dismissed/merged is left exactly
          // as it is, never resurrected. return=representation is what
          // lets us tell "inserted" from "skipped, already existed" —
          // status alone isn't reliable for that with ignore-duplicates.
          headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
          body: JSON.stringify([{ store_id_a: f.aId, store_id_b: f.bId, reasons: f.reasons }]),
        });
        let rows = [];
        try { rows = await res.json(); } catch (_) {}
        if (Array.isArray(rows) && rows.length) inserted++;
      }
      const pendingRes = await sb("/rest/v1/clicka_duplicate_candidates?status=eq.pending&select=id", { headers: { Prefer: "count=exact" } });
      const pendingCount = Number((pendingRes.headers.get("content-range") || "/0").split("/")[1]) || 0;
      return json(200, { ok: true, scanned: found.length, new_candidates: inserted, pending_count: pendingCount });
    }

    if (qs.action === "dismiss") {
      if (!body.candidate_id) return json(400, { ok: false, error: "candidate_id is required." });
      await sb("/rest/v1/clicka_duplicate_candidates?id=eq." + body.candidate_id, {
        method: "PATCH",
        body: JSON.stringify({ status: "dismissed", reviewed_by: caller.staff.id, reviewed_at: new Date().toISOString() }),
      });
      return json(200, { ok: true });
    }

    if (qs.action === "merge") {
      const { keep_id, merge_id } = body;
      if (!keep_id || !merge_id) return json(400, { ok: false, error: "keep_id and merge_id are required." });
      if (keep_id === merge_id) return json(400, { ok: false, error: "Can't merge a store into itself." });

      const storesRes = await sb("/rest/v1/clicka_registrations?id=in.(" + keep_id + "," + merge_id + ")&select=id,province,merged_into_id");
      const storeRows = await storesRes.json();
      const keep = (storeRows || []).find((s) => s.id === keep_id);
      const merge = (storeRows || []).find((s) => s.id === merge_id);
      if (!keep || !merge) return json(404, { ok: false, error: "One of these stores wasn't found." });
      if (keep.merged_into_id || merge.merged_into_id) return json(400, { ok: false, error: "One of these stores has already been merged elsewhere." });
      if (allowedProvinces && (!allowedProvinces.includes(keep.province) || !allowedProvinces.includes(merge.province))) {
        return json(403, { ok: false, error: "Outside your assigned province." });
      }

      const reassign = async (table) => {
        const r = await sb("/rest/v1/" + table + "?store_id=eq." + merge_id, {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ store_id: keep_id }),
        });
        const t = await r.text();
        let rows = [];
        try { rows = JSON.parse(t); } catch (_) {}
        return Array.isArray(rows) ? rows.length : 0;
      };

      const [orders, visits, surveys, scopes] = await Promise.all([
        reassign("clicka_orders"),
        reassign("clicka_store_visits"),
        reassign("clicka_survey_responses"),
        reassign("clicka_staff_scope"),
      ]);

      await sb("/rest/v1/clicka_registrations?id=eq." + merge_id, {
        method: "PATCH",
        body: JSON.stringify({ merged_into_id: keep_id, merged_at: new Date().toISOString() }),
      });

      if (body.candidate_id) {
        await sb("/rest/v1/clicka_duplicate_candidates?id=eq." + body.candidate_id, {
          method: "PATCH",
          body: JSON.stringify({ status: "merged", reviewed_by: caller.staff.id, reviewed_at: new Date().toISOString() }),
        });
      }
      // Any other pending pair involving the now-retired store no longer
      // means anything — clear it rather than leave a dangling row.
      await sb("/rest/v1/clicka_duplicate_candidates?status=eq.pending&or=(store_id_a.eq." + merge_id + ",store_id_b.eq." + merge_id + ")", {
        method: "PATCH",
        body: JSON.stringify({ status: "merged", reviewed_by: caller.staff.id, reviewed_at: new Date().toISOString() }),
      });

      return json(200, { ok: true, kept_id: keep_id, merged_id: merge_id, reassigned: { orders, visits, survey_responses: surveys, staff_scope: scopes } });
    }

    return json(400, { ok: false, error: "Unknown action. Use scan, merge, or dismiss." });
  }

  if (event.httpMethod !== "GET") return json(405, { ok: false, error: "Method not allowed." });

  // ---------- GET ?count=1 ----------
  if (qs.count === "1") {
    const res = await sb("/rest/v1/clicka_duplicate_candidates?status=eq.pending&select=id", { headers: { Prefer: "count=exact" } });
    const count = Number((res.headers.get("content-range") || "/0").split("/")[1]) || 0;
    return json(200, { ok: true, pending_count: count });
  }

  // ---------- GET: pending candidates, enriched ----------
  const res = await sb("/rest/v1/clicka_duplicate_candidates?status=eq.pending&select=*&order=detected_at.desc&limit=500");
  const rows = await res.json();
  let enriched = await enrichCandidates(Array.isArray(rows) ? rows : []);
  if (allowedProvinces) {
    enriched = enriched.filter((c) => allowedProvinces.includes(c.store_a.province) && allowedProvinces.includes(c.store_b.province));
  }
  return json(200, { ok: true, candidates: enriched });
};
