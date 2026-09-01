// admin/netlify/functions/admin-whoami.js
//
// FUNCTION — "Who am I?"
// The front-end calls this right after login to find out which
// clicka_staff profile belongs to the signed-in session, and therefore
// which role/scope-gated parts of the dashboard to show.
//
// Self-test (no auth needed, no data touched):
//   /.netlify/functions/admin-whoami?selftest=1

const { SERVICE_KEY, json, sb, getCaller } = require("./_auth");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

  const qs = event.queryStringParameters || {};
  if (qs.selftest === "1") {
    return json(200, {
      ok: true,
      world: "CLICKA-ADMIN",
      serviceKeySet: !!SERVICE_KEY,
    });
  }

  if (!SERVICE_KEY) return json(500, { ok: false, error: "Service key not configured in Netlify." });

  const caller = await getCaller(event);
  if (!caller) return json(401, { ok: false, error: "Not signed in." });
  if (!caller.staff) {
    return json(403, {
      ok: false,
      error: "This login has no Clicka Admin profile linked to it yet.",
    });
  }
  if (caller.staff.status === "inactive") {
    return json(403, { ok: false, error: "This account has been deactivated." });
  }

  // If this account is assigned to a Client / brand (cosmetic branding today
  // — e.g. an Agent working Unilever gets Unilever's logo in the app —
  // resolve it here so the front-end doesn't need a second round trip.
  let clientBrand = null;
  const brandScope = (caller.scope || []).find((s) => s.scope_type === "brand");
  if (brandScope && brandScope.brand_id) {
    const brandRes = await sb("/rest/v1/bi_brands?id=eq." + brandScope.brand_id + "&select=id,name,logo_url");
    const brandRows = await brandRes.json();
    clientBrand = Array.isArray(brandRows) && brandRows[0] ? brandRows[0] : null;
  }

  return json(200, {
    ok: true,
    staff: caller.staff,
    scope: caller.scope,
    clientBrand,
  });
};
