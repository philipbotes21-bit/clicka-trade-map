// admin/netlify/functions/_auth.js
//
// Shared helper for every Clicka Admin function. Verifies the caller's
// Supabase session token (sent by the browser as "Authorization: Bearer
// <access_token>" after they log in) and loads their clicka_staff profile
// so each function can decide what that person is allowed to do.
//
// Nothing here is reachable by the browser directly — it only runs inside
// Netlify functions, server-side, using the service role key.

const SUPABASE_URL = "https://liemaxqgngtotzbqiqeq.supabase.co";
const SERVICE_KEY =
  process.env.CLICKA_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    },
    body: JSON.stringify(obj, null, 2),
  };
}

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

  const scopeRes = await sb(
    "/rest/v1/clicka_staff_scope?staff_id=eq." + staff.id + "&select=*"
  );
  const scope = await scopeRes.json();

  return { authUser, staff, scope: Array.isArray(scope) ? scope : [] };
}

// The set of brands a caller's view is locked to, or null for unrestricted.
// Same clicka_staff_scope rows (scope_type "brand") used everywhere else —
// Spaza Onboard white-labelling, Invoice/Cashless brand-locking, and now
// Stores visibility for the client_rep role (see admin-stores.js). A caller
// can carry more than one brand row — a Client Representative assigned to
// several clients — so this always returns an array, or null.
//
// bi_brands id 4 is "Clicka" itself (Clicka's own staff, not a product
// brand) — a scope row pointing at it is dropped before the lock is
// computed, same exception as the root Trade Map / BI _auth.js.
const CLICKA_OWN_BRAND_ID = 4;

function resolveBrandLocks(caller) {
  if (!caller || !caller.staff) return null;
  if (caller.staff.role === "admin") return null;
  const rows = (caller.scope || []).filter((s) => s.scope_type === "brand");
  if (!rows.length) return null;
  const ids = Array.from(new Set(rows.map((r) => Number(r.brand_id)).filter((id) => id !== CLICKA_OWN_BRAND_ID)));
  if (!ids.length) return null;
  return ids;
}

module.exports = { SUPABASE_URL, SERVICE_KEY, json, sb, getCaller, resolveBrandLocks, CLICKA_OWN_BRAND_ID };
