// netlify/functions/_auth.js
//
// Shared helper for the Trade Map + BI Reports functions (bi-lookup,
// bi-sales-in, bi-sales-out, bi-products). Verifies the caller's Supabase
// session token (sent by the browser as "Authorization: Bearer
// <access_token>" after they sign in on the Trade Map's login gate) and
// loads their clicka_staff profile, so each function can refuse to run
// for anyone who isn't a signed-in Clicka Admin staff member.
//
// Same Supabase project as Clicka Admin (liemaxqgngtotzbqiqeq) — this is
// intentionally a copy of admin/netlify/functions/_auth.js rather than a
// shared import, because this app deploys as its own separate Netlify
// site/function bundle at the repo root.
//
// Nothing here is reachable by the browser directly — it only runs inside
// Netlify functions, server-side, using the service role key.

const SUPABASE_URL = "https://liemaxqgngtotzbqiqeq.supabase.co";
const SERVICE_KEY =
  process.env.CLICKA_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path, opts = {}) {
  const res = await fetch(SUPABASE_URL + path, {
    ...opts,
    headers: {
      Authorization: "Bearer " + SERVICE_KEY,
      apikey: SERVICE_KEY,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  return res;
}

// Looks up who is calling, based on the bearer token they sent.
// Returns { authUser, staff, scope } or null if the token is missing/invalid.
async function getCaller(event) {
  const header = event.headers.authorization || event.headers.Authorization;
  if (!header) return null;
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;

  const userRes = await fetch(SUPABASE_URL + "/auth/v1/user", {
    headers: { Authorization: "Bearer " + token, apikey: SERVICE_KEY },
  });
  if (!userRes.ok) return null;
  const authUser = await userRes.json();
  if (!authUser || !authUser.id) return null;

  const staffRes = await sb(
    "/rest/v1/clicka_staff?auth_user_id=eq." + authUser.id + "&select=*"
  );
  const staffRows = await staffRes.json();
  const staff = Array.isArray(staffRows) ? staffRows[0] : null;
  if (!staff) return { authUser, staff: null, scope: [] };

  return { authUser, staff, scope: [] };
}

// Roles allowed into the Trade Map + BI Reports app. This is management/
// aggregate-data surface (every store, every Midi, every brand's sales) —
// deliberately narrower than Spaza Onboard's role list, which includes
// field roles (Agent, PPM Agent, Self Order Manager) that have no reason
// to see cross-network BI.
const ALLOWED_ROLES = ["admin", "supervisor", "regional_manager"];

// Convenience guard for each function's handler: returns an error response
// to send straight back if the caller can't use this app, or null if
// they're clear to proceed.
async function requireStaff(event, json) {
  if (!SERVICE_KEY) return json(500, { ok: false, error: "Service key not configured in Netlify." });
  const caller = await getCaller(event);
  if (!caller) return json(401, { ok: false, error: "Not signed in." });
  if (!caller.staff) return json(403, { ok: false, error: "This login has no Clicka Admin profile linked to it yet." });
  if (caller.staff.status === "inactive") return json(403, { ok: false, error: "This account has been deactivated." });
  if (!ALLOWED_ROLES.includes(caller.staff.role)) {
    return json(403, { ok: false, error: "This account isn't set up to use the Trade Map / BI Reports app." });
  }
  return null;
}

module.exports = { SUPABASE_URL, SERVICE_KEY, sb, getCaller, ALLOWED_ROLES, requireStaff };
