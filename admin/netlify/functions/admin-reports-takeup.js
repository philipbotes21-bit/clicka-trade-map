// admin/netlify/functions/admin-reports-takeup.js
//
// FUNCTION — Clicka: Take-up rate report.
// The question every brand asks: "if an Agent has 15 stores to visit, how
// many of them actually order?" This answers it — per Agent, and company-
// wide — for a day/week/month window.
//
// An Agent's "assigned stores" is the same pool used everywhere else in the
// app: stores THEY captured (staff_id) OR any store in a sub-region
// assigned to them (scope_type "region"). "Ordered" means the store placed
// at least one clicka_orders row in the window — who placed it doesn't
// matter (self-order, Agent-assisted, PPM Agent), only that the store
// itself transacted.
//
// GET ?period=day|week|month&date=YYYY-MM-DD (date optional, defaults to
//   today; anchors which day/week/month is reported on)
//   -> {
//        ok, period, range: {from, to},
//        agents: [{ staff_id, name, assigned_count, ordered_count, take_up_pct }],
//        avg_of_agent_pct,                      -- simple mean across agents
//        company: { assigned_count, ordered_count, take_up_pct }  -- deduplicated
//                                                    union of every agent's pool
//      }
//
// Admin / Supervisor / Regional Manager only — Supervisor/Regional Manager
// see agents whose pool falls within their assigned province(s).
//
// Self-test (no auth needed, no data touched):
//   /.netlify/functions/admin-reports-takeup?selftest=1

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

function dateRange(period, anchorStr) {
  const anchor = anchorStr ? new Date(anchorStr + "T00:00:00Z") : new Date();
  let from, to;
  if (period === "week") {
    const day = anchor.getUTCDay(); // 0=Sun
    const mondayOffset = day === 0 ? -6 : 1 - day;
    from = new Date(anchor); from.setUTCDate(anchor.getUTCDate() + mondayOffset);
    to = new Date(from); to.setUTCDate(from.getUTCDate() + 7);
  } else if (period === "month") {
    from = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
    to = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 1));
  } else {
    from = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate()));
    to = new Date(from); to.setUTCDate(from.getUTCDate() + 1);
  }
  return { from, to };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

  const qs = event.queryStringParameters || {};
  if (qs.selftest === "1") return json(200, { ok: true, world: "CLICKA-ADMIN" });

  const caller = await getCaller(event);
  if (!caller || !caller.staff) return json(401, { ok: false, error: "Not signed in." });
  if (caller.staff.status === "inactive") return json(403, { ok: false, error: "Account deactivated." });
  if (!["admin", "supervisor", "regional_manager"].includes(caller.staff.role)) {
    return json(403, { ok: false, error: "This report isn't available on this account." });
  }
  if (event.httpMethod !== "GET") return json(405, { ok: false, error: "Method not allowed." });

  const period = ["day", "week", "month"].includes(qs.period) ? qs.period : "week";
  const { from, to } = dateRange(period, qs.date);

  let allowedProvinces = null;
  if (caller.staff.role !== "admin") {
    allowedProvinces = await resolveScopeProvinces(caller.scope || []);
    if (!allowedProvinces.length) {
      return json(200, { ok: true, period, range: { from: from.toISOString(), to: to.toISOString() }, agents: [], avg_of_agent_pct: 0, company: { assigned_count: 0, ordered_count: 0, take_up_pct: 0 }, note: "No region assigned to this account yet." });
    }
  }

  // Every active Agent, plus their assigned sub-regions (if any).
  const agentsRes = await sb("/rest/v1/clicka_staff?role=eq.agent&status=eq.active&select=id,first_name,last_name");
  const agentRows = await agentsRes.json();
  const agents = Array.isArray(agentRows) ? agentRows : [];
  if (!agents.length) {
    return json(200, { ok: true, period, range: { from: from.toISOString(), to: to.toISOString() }, agents: [], avg_of_agent_pct: 0, company: { assigned_count: 0, ordered_count: 0, take_up_pct: 0 } });
  }
  const agentIds = agents.map((a) => a.id);

  const scopeRes = await sb("/rest/v1/clicka_staff_scope?staff_id=in.(" + agentIds.join(",") + ")&scope_type=eq.region&select=staff_id,region_id");
  const scopeRows = await scopeRes.json();
  const regionIdsByAgent = {};
  for (const s of Array.isArray(scopeRows) ? scopeRows : []) {
    (regionIdsByAgent[s.staff_id] = regionIdsByAgent[s.staff_id] || []).push(s.region_id);
  }

  // Every store that could plausibly be in SOME agent's pool. Capped at
  // 5000 for now — revisit with real pagination once capture volume grows
  // well past that.
  const storesRes = await sb("/rest/v1/clicka_registrations?merged_into_id=is.null&select=id,staff_id,region_id,province&limit=5000");
  const storeRows = await storesRes.json();
  const stores = Array.isArray(storeRows) ? storeRows : [];

  // Stores with >=1 order placed within the window.
  const ordersRes = await sb(
    "/rest/v1/clicka_orders?select=store_id&created_at=gte." + from.toISOString() + "&created_at=lt." + to.toISOString() + "&limit=20000"
  );
  const orderRows = await ordersRes.json();
  const orderedStoreIds = new Set((Array.isArray(orderRows) ? orderRows : []).map((o) => o.store_id));

  const agentResults = [];
  const companyAssigned = new Set();
  const companyOrdered = new Set();

  for (const a of agents) {
    const myRegionIds = new Set(regionIdsByAgent[a.id] || []);
    const pool = stores.filter((s) => s.staff_id === a.id || (s.region_id && myRegionIds.has(s.region_id)));
    const scopedPool = allowedProvinces ? pool.filter((s) => allowedProvinces.includes(s.province)) : pool;
    // A Supervisor/Regional Manager only sees agents who actually have at
    // least one store within their province(s) — skip everyone else rather
    // than list a wall of 0/0 rows for agents outside their patch.
    if (allowedProvinces && scopedPool.length === 0) continue;

    const assignedIds = scopedPool.map((s) => s.id);
    const orderedIds = assignedIds.filter((id) => orderedStoreIds.has(id));
    assignedIds.forEach((id) => companyAssigned.add(id));
    orderedIds.forEach((id) => companyOrdered.add(id));

    agentResults.push({
      staff_id: a.id,
      name: a.first_name + " " + a.last_name,
      assigned_count: assignedIds.length,
      ordered_count: orderedIds.length,
      take_up_pct: assignedIds.length ? Math.round((orderedIds.length / assignedIds.length) * 1000) / 10 : 0,
    });
  }

  agentResults.sort((a, b) => b.take_up_pct - a.take_up_pct);
  const avgOfAgentPct = agentResults.length
    ? Math.round((agentResults.reduce((sum, a) => sum + a.take_up_pct, 0) / agentResults.length) * 10) / 10
    : 0;

  return json(200, {
    ok: true,
    period,
    range: { from: from.toISOString(), to: to.toISOString() },
    agents: agentResults,
    avg_of_agent_pct: avgOfAgentPct,
    company: {
      assigned_count: companyAssigned.size,
      ordered_count: companyOrdered.size,
      take_up_pct: companyAssigned.size ? Math.round((companyOrdered.size / companyAssigned.size) * 1000) / 10 : 0,
    },
  });
};
