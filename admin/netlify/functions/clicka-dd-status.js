// admin/netlify/functions/clicka-dd-status.js
//
// Backs the Due Diligence tracker tab in Clicka Admin, and the read-only
// rollup card in Clicka BI. Reads/writes clicka_dd_status.
//
// GET    -> list all rows, ordered by workstream + deliverable_ref
// PATCH  -> update one row (state, owner, blocker_note, last_touched,
//           repo_commit_ref) by id. Admin role only.
//
// Nothing here is reachable directly with the anon key — RLS on
// clicka_dd_status has zero policies, so this function (service role key,
// server-side) is the only path in or out.

const { json, sb, getCaller } = require("./_auth");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, {});

  const caller = await getCaller(event);
  if (!caller || !caller.staff) {
    return json(401, { error: "Not authenticated" });
  }
  if (caller.staff.role !== "admin") {
    return json(403, { error: "Admin role required" });
  }

  if (event.httpMethod === "GET") {
    const res = await sb(
      "/rest/v1/clicka_dd_status?select=*&order=workstream.asc,deliverable_ref.asc"
    );
    if (!res.ok) {
      const detail = await res.text();
      return json(res.status, { error: "Failed to load DD status", detail });
    }
    const rows = await res.json();
    return json(200, { rows });
  }

  if (event.httpMethod === "PATCH") {
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "Invalid JSON body" });
    }

    const { id, state, owner, blocker_note, last_touched, repo_commit_ref } = body;
    if (!id) return json(400, { error: "id is required" });

    const allowedStates = ["DONE", "IN PROGRESS", "BLOCKED", "NOT STARTED"];
    if (state && !allowedStates.includes(state)) {
      return json(400, { error: "Invalid state value" });
    }

    const update = { updated_at: new Date().toISOString() };
    if (state !== undefined) update.state = state;
    if (owner !== undefined) update.owner = owner;
    if (blocker_note !== undefined) update.blocker_note = blocker_note;
    if (last_touched !== undefined) update.last_touched = last_touched;
    if (repo_commit_ref !== undefined) update.repo_commit_ref = repo_commit_ref;

    const res = await sb("/rest/v1/clicka_dd_status?id=eq." + id, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(update),
    });

    if (!res.ok) {
      const detail = await res.text();
      return json(res.status, { error: "Failed to update DD status", detail });
    }
    const rows = await res.json();
    return json(200, { row: rows[0] || null });
  }

  return json(405, { error: "Method not allowed" });
};
