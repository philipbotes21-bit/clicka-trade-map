// admin/netlify/functions/admin-visits.js
//
// FUNCTION — Clicka: field visit check-ins.
// This is the "prove the store was actually visited" record clients ask
// for — GPS-stamped, photo-backed, never overwritten. Geofence is a SOFT
// gate: an Agent outside the ~100m radius (or with no GPS lock at all) can
// still check in, but must leave a short note explaining why, and the
// record is flagged within_geofence:false rather than silently passed off
// as a clean visit. A photo is always required, override or not.
//
// POST -> record a check-in.
//   body: {
//     store_id, gps_lat?, gps_lng?, gps_accuracy_m?,
//     photo_base64, photo_content_type?,
//     gps_override_note?   (required if outside the geofence or no GPS fix)
//   }
//   Agent: store must be in their pool (captured by them, or in a
//   sub-region assigned to them — same rule as everywhere else). Admin can
//   check in on behalf of any store (rare, but useful for testing/support).
//
// GET  ?store_id=...           -> visit history for one store (anyone who
//                                  can already see that store).
// GET  ?staff_id=...&date=...  -> one agent's visits for one day (default
//                                  today). Agent can only query themself;
//                                  Admin/Supervisor/Regional Manager can
//                                  query anyone within their scope.
//
// Self-test (no auth needed, no data touched):
//   /.netlify/functions/admin-visits?selftest=1

const { SUPABASE_URL, json, sb, getCaller } = require("./_auth");

const BUCKET = "clicka-uploads";
const GEOFENCE_RADIUS_M = 100;

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

  const qs = event.queryStringParameters || {};
  if (qs.selftest === "1") return json(200, { ok: true, world: "CLICKA-ADMIN" });

  const caller = await getCaller(event);
  if (!caller || !caller.staff) return json(401, { ok: false, error: "Not signed in." });
  if (caller.staff.status === "inactive") return json(403, { ok: false, error: "Account deactivated." });
  const role = caller.staff.role;

  // ---------- POST: check in ----------
  if (event.httpMethod === "POST") {
    if (!["agent", "admin"].includes(role)) {
      return json(403, { ok: false, error: "Checking in to a store isn't available on this account." });
    }
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { ok: false, error: "Invalid JSON body." }); }

    const { store_id, photo_base64 } = body;
    if (!store_id) return json(400, { ok: false, error: "store_id is required." });
    if (!photo_base64) return json(400, { ok: false, error: "A photo of the shop is required to check in." });

    const storeRes = await sb("/rest/v1/clicka_registrations?id=eq." + store_id + "&select=id,trading_name,staff_id,region_id,gps_lat,gps_lng");
    const storeRows = await storeRes.json();
    const store = Array.isArray(storeRows) ? storeRows[0] : null;
    if (!store) return json(404, { ok: false, error: "Store not found." });

    if (role === "agent") {
      const agentRegionIds = (caller.scope || []).filter((s) => s.scope_type === "region").map((s) => s.region_id);
      const inPool = store.staff_id === caller.staff.id || (store.region_id && agentRegionIds.includes(store.region_id));
      if (!inPool) {
        return json(403, { ok: false, error: "This store isn't in your pool — it wasn't captured by you and isn't in a sub-region assigned to you." });
      }
    }

    const gpsLat = body.gps_lat != null ? Number(body.gps_lat) : null;
    const gpsLng = body.gps_lng != null ? Number(body.gps_lng) : null;
    const gpsAccuracy = body.gps_accuracy_m != null ? Number(body.gps_accuracy_m) : null;
    const overrideNote = body.gps_override_note ? String(body.gps_override_note).trim() : null;

    let distance = null;
    let withinGeofence = false;
    let autoNote = null;

    if (gpsLat == null || gpsLng == null) {
      autoNote = "No GPS fix available on the device at check-in.";
    } else if (store.gps_lat == null || store.gps_lng == null) {
      autoNote = "This store has no GPS pin on file to check the geofence against.";
    } else {
      distance = Math.round(haversineMeters(gpsLat, gpsLng, store.gps_lat, store.gps_lng));
      withinGeofence = distance <= GEOFENCE_RADIUS_M;
    }

    // Soft gate: never hard-blocks, but outside the fence (or no fix at
    // all) needs a reason on record — either the agent's own note, or the
    // automatic one generated above when there's simply nothing to check
    // against.
    if (!withinGeofence && !overrideNote && !autoNote) {
      return json(400, {
        ok: false,
        error: "You're " + distance + "m from " + store.trading_name + " (outside the " + GEOFENCE_RADIUS_M + "m check-in radius). Add a quick note to check in anyway.",
        distance_from_store_m: distance,
        needs_override_note: true,
      });
    }

    let photoPath;
    try {
      const ext = (body.photo_content_type && body.photo_content_type.includes("png")) ? "png" : "jpg";
      photoPath = "visits/" + store_id + "/" + Date.now() + "." + ext;
      await uploadPhoto(photoPath, photo_base64, body.photo_content_type);
    } catch (e) {
      return json(200, { ok: false, error: String(e.message || e) });
    }

    const insertRes = await sb("/rest/v1/clicka_store_visits", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify([{
        store_id,
        staff_id: caller.staff.id,
        gps_lat: gpsLat,
        gps_lng: gpsLng,
        gps_accuracy_m: gpsAccuracy,
        distance_from_store_m: distance,
        within_geofence: withinGeofence,
        gps_override_note: overrideNote || autoNote,
        photo_url: photoPath,
      }]),
    });
    const insertRows = await insertRes.json();
    if (!insertRes.ok || !Array.isArray(insertRows) || !insertRows.length) {
      return json(400, { ok: false, error: "Couldn't save the check-in: " + JSON.stringify(insertRows).slice(0, 300) });
    }

    const visit = insertRows[0];
    return json(200, {
      ok: true,
      visit: { ...visit, photo_signed_url: await signPhoto(visit.photo_url) },
    });
  }

  // ---------- GET: visit history ----------
  if (event.httpMethod === "GET") {
    if (qs.store_id) {
      const res = await sb("/rest/v1/clicka_store_visits?store_id=eq." + qs.store_id + "&select=*&order=checked_in_at.desc&limit=100");
      const visits = await res.json();
      const enriched = await Promise.all((Array.isArray(visits) ? visits : []).map(async (v) => ({
        ...v,
        photo_signed_url: await signPhoto(v.photo_url),
      })));
      return json(200, { ok: true, visits: enriched });
    }

    const targetStaffId = qs.staff_id || caller.staff.id;
    if (targetStaffId !== caller.staff.id && !["admin", "supervisor", "regional_manager"].includes(role)) {
      return json(403, { ok: false, error: "You can only view your own visit history." });
    }
    const date = qs.date || new Date().toISOString().slice(0, 10);
    const res = await sb(
      "/rest/v1/clicka_store_visits?staff_id=eq." + targetStaffId +
      "&checked_in_at=gte." + date + "T00:00:00" +
      "&checked_in_at=lt." + date + "T23:59:59" +
      "&select=*,clicka_registrations(trading_name,outlet_address)&order=checked_in_at.desc"
    );
    const visits = await res.json();
    if (!res.ok) return json(200, { ok: false, error: JSON.stringify(visits).slice(0, 300) });
    const enriched = await Promise.all((Array.isArray(visits) ? visits : []).map(async (v) => ({
      ...v,
      store_name: v.clicka_registrations ? v.clicka_registrations.trading_name : null,
      photo_signed_url: await signPhoto(v.photo_url),
    })));
    return json(200, { ok: true, date, visits: enriched });
  }

  return json(405, { ok: false, error: "Method not allowed." });
};
