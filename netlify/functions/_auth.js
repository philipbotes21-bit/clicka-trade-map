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

  // This used to hardcode scope: [] — meaning brand-scoped access could
  // never actually be enforced anywhere in the Trade Map / BI Reports app,
  // even though the SAME clicka_staff_scope rows (scope_type "brand") are
  // already how Spaza Onboard white-labelling and Invoice brand-locking
  // work. Ported from admin/netlify/functions/_auth.js so a brand-scoped
  // viewer here only ever sees their own brand's BI, same rule everywhere
  // else in the codebase.
  const scopeRes = await sb(
    "/rest/v1/clicka_staff_scope?staff_id=eq." + staff.id + "&select=*"
  );
  const scope = await scopeRes.json();

  return { authUser, staff, scope: Array.isArray(scope) ? scope : [] };
}

// Roles allowed into the Trade Map + BI Reports app. This is management/
// aggregate-data surface (every store, every Midi, every brand's sales) —
// deliberately narrower than Spaza Onboard's role list, which includes
// field roles (Agent, PPM Agent, Self Order Manager) that have no reason
// to see cross-network BI.
//
// client_rep is the odd one out: it's here so a Client Representative can
// sign in and reach BI Reports at all, but it never sees the unrestricted
// view every other role on this list can reach — resolveBrandLocks() below
// always returns their locked brand(s) for this role, and the frontend
// hides the raw Trade Map pin view for it entirely (that dataset is a
// static bulk import with no per-client attribution, so it can't be scoped
// down honestly — see map-data.js).
const ALLOWED_ROLES = ["admin", "supervisor", "regional_manager", "client_rep"];

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

// The set of brands a caller's BI view is locked to, or null for
// unrestricted (sees every brand, plus the "Clicka" combined rollup). Same
// clicka_staff_scope rows (scope_type "brand") used everywhere else in
// Clicka — Spaza Onboard white-labelling, Invoice/Cashless brand-locking
// in the Admin app (admin-invoices.js, admin-cashless-payments.js), and
// Stores visibility (admin-stores.js). A caller can carry MORE THAN ONE
// brand row — a Client Representative assigned to several clients, say —
// so this always returns an array (never a single id), or null.
//
// One deliberate exception, per Warren: bi_brands id 4 is "Clicka" itself
// (Clicka's own staff, not a product brand — it has zero rows in any of
// the bi_* sales tables). Someone scoped to "Clicka" is Clicka's own
// person, not a brand client's, so a scope row pointing at it is dropped
// before the lock is computed — if that leaves zero brand rows, the caller
// is unrestricted, same as an unscoped Admin/Supervisor/Regional Manager.
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

// Back-compat single-id helper for call sites that only ever expect one
// brand (kept narrow on purpose — new code should use resolveBrandLocks).
function resolveBrandLock(caller) {
  const ids = resolveBrandLocks(caller);
  return ids && ids.length ? ids[0] : null;
}

module.exports = { SUPABASE_URL, SERVICE_KEY, sb, getCaller, ALLOWED_ROLES, requireStaff, resolveBrandLock, resolveBrandLocks, CLICKA_OWN_BRAND_ID };
