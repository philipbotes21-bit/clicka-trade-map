// admin/netlify/functions/admin-agent-route.js
//
// FUNCTION — Clicka: Agent field route.
// Computes an Agent's "today's route" — which stores in their pool are due
// a visit, and in what order to drive them — entirely from data already on
// file (store GPS pins + visit_frequency_days + clicka_store_visits). No
// mapping API, no external cost: nearest-neighbour sequencing over the
// haversine distance between GPS points, which is more than accurate enough
// for a 15-17 stop town/township route.
//
// An Agent's pool is the exact same set admin-stores.js already shows them
// as "my stores": stores THEY captured (staff_id) OR any store in a
// sub-region assigned to them (scope_type "region").
//
// Due logic: a store is due once (last check-in, or created_at if it's
// never been checked into) + visit_frequency_days has passed. Selection
// prioritises the most overdue first, capped at ?limit= (default 17). If
// fewer than 15 stores are due, the list is padded with the soonest-to-be-
// due stores from the rest of the pool so an Agent always has a reasonably
// full day rather than an unexpectedly short one.
//
// GET  -> { ok, date, due_count, route: [{ id, trading_name, outlet_address,
//           province, gps_lat, gps_lng, status, days_overdue, sequence,
//           checked_in_today }] }
//   Optional: ?lat=&lng= (agent's current GPS, from the browser) — if given,
//   the route starts from the nearest store to the agent's current
//   position instead of an arbitrary one.
//   Optional: ?limit=17
//
// Self-test (no auth needed, no data touched):
//   /.netlify/functions/admin-agent-route?selftest=1

const { json, sb, getCaller } = require("./_auth");

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

// Greedy nearest-neighbour chain — not globally optimal (that's a much
// harder problem), but for 15-17 stops in one town/township it produces a
// sensible, non-backtracking loop, which is what actually matters here.
function nearestNeighbourOrder(stores, startLat, startLng) {
  const remaining = stores.slice();
  const ordered = [];
  let curLat = startLat, curLng = startLng;
  while (remaining.length) {
    let bestIdx = 0, bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const s = remaining[i];
      const d = haversineMeters(curLat, curLng, s.gps_lat, s.gps_lng);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    const next = remaining.splice(bestIdx, 1)[0];
    ordered.push(next);
    curLat = next.gps_lat; curLng = next.gps_lng;
  }
  return ordered;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

  const qs = event.queryStringParameters || {};
  if (qs.selftest === "1") return json(200, { ok: true, world: "CLICKA-ADMIN" });

  const caller = await getCaller(event);
  if (!caller || !caller.staff) return json(401, { ok: false, error: "Not signed in." });
  if (caller.staff.status === "inactive") return json(403, { ok: false, error: "Account deactivated." });
  if (caller.staff.role !== "agent") {
    return json(403, { ok: false, error: "Field routes are only available on an Agent account." });
  }
  if (event.httpMethod !== "GET") return json(405, { ok: false, error: "Method not allowed." });

  const targetMin = 15;
  const limit = Math.max(1, Math.min(30, parseInt(qs.limit, 10) || 17));

  const agentRegionIds = (caller.scope || []).filter((s) => s.scope_type === "region").map((s) => s.region_id);
  const poolFilter = agentRegionIds.length
    ? "or(staff_id.eq." + caller.staff.id + ",region_id.in.(" + agentRegionIds.join(",") + "))"
    : "staff_id.eq." + caller.staff.id;

  const storesRes = await sb(
    "/rest/v1/clicka_registrations?and=(" + poolFilter + ")" +
    "&select=id,trading_name,outlet_address,province,status,gps_lat,gps_lng,visit_frequency_days,created_at" +
    "&gps_lat=not.is.null&gps_lng=not.is.null&limit=1000"
  );
  const stores = await storesRes.json();
  if (!storesRes.ok) return json(200, { ok: false, error: JSON.stringify(stores).slice(0, 300) });
  if (!Array.isArray(stores) || !stores.length) {
    return json(200, { ok: true, date: new Date().toISOString().slice(0, 10), due_count: 0, route: [], note: "No stores with a GPS pin on file in your pool yet." });
  }

  const storeIds = stores.map((s) => s.id);
  const todayStr = new Date().toISOString().slice(0, 10);

  // Latest check-in per store (any agent — a store visited by a colleague
  // still counts as "recently visited" for cadence purposes), plus whether
  // THIS agent has already checked in today (to grey it out, not exclude it
  // — someone might need a second visit the same day).
  const visitsRes = await sb(
    "/rest/v1/clicka_store_visits?store_id=in.(" + storeIds.join(",") + ")&select=store_id,staff_id,checked_in_at&order=checked_in_at.desc&limit=5000"
  );
  const visits = await visitsRes.json();
  const lastVisitByStore = {};
  const checkedInTodayByStore = {};
  for (const v of Array.isArray(visits) ? visits : []) {
    if (!lastVisitByStore[v.store_id]) lastVisitByStore[v.store_id] = v.checked_in_at; // first hit per store = most recent, thanks to the order above
    if (v.staff_id === caller.staff.id && v.checked_in_at.slice(0, 10) === todayStr) {
      checkedInTodayByStore[v.store_id] = true;
    }
  }

  const now = Date.now();
  const withDueInfo = stores.map((s) => {
    const lastVisit = lastVisitByStore[s.id] || s.created_at;
    const dueAt = new Date(lastVisit).getTime() + s.visit_frequency_days * 86400000;
    const daysOverdue = Math.round((now - dueAt) / 86400000);
    return { ...s, dueAt, daysOverdue };
  });

  const due = withDueInfo.filter((s) => s.daysOverdue >= 0).sort((a, b) => b.daysOverdue - a.daysOverdue);
  let selected = due.slice(0, limit);

  if (selected.length < targetMin) {
    const selectedIds = new Set(selected.map((s) => s.id));
    const upcoming = withDueInfo
      .filter((s) => !selectedIds.has(s.id))
      .sort((a, b) => a.dueAt - b.dueAt);
    for (const s of upcoming) {
      if (selected.length >= Math.min(targetMin, withDueInfo.length)) break;
      selected.push(s);
    }
  }

  const startLat = qs.lat ? Number(qs.lat) : selected[0].gps_lat;
  const startLng = qs.lng ? Number(qs.lng) : selected[0].gps_lng;
  const ordered = nearestNeighbourOrder(selected, startLat, startLng);

  const route = ordered.map((s, i) => ({
    id: s.id,
    trading_name: s.trading_name,
    outlet_address: s.outlet_address,
    province: s.province,
    status: s.status,
    gps_lat: s.gps_lat,
    gps_lng: s.gps_lng,
    days_overdue: Math.max(0, s.daysOverdue),
    sequence: i + 1,
    checked_in_today: !!checkedInTodayByStore[s.id],
  }));

  return json(200, { ok: true, date: todayStr, due_count: due.length, route });
};
