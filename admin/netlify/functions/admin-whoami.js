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

  // If this account is assigned to a Client / brand — e.g. an Agent working
  // Unilever gets Unilever's logo AND colour scheme in Spaza Onboard —
  // resolve it here so the front-end doesn't need a second round trip.
  // accent_color/accent_deep_color are only used to re-theme Spaza Onboard;
  // the Trade Map + BI Reports app stays Clicka green regardless.
  //
  // Most roles carry at most one brand scope row, so clientBrand (the
  // first one) is all Spaza Onboard white-labelling ever needed — kept as
  // its own field for backward compatibility. A Client Representative can
  // be assigned to SEVERAL clients though, so clientBrands (plural) always
  // resolves every brand row this account has, in case a client_rep needs
  // the full set (BI Reports and Stores visibility use the ids directly
  // server-side; this is for the front-end to show "your assigned
  // client(s)" without a second round trip).
  let clientBrand = null;
  let clientBrands = [];
  const brandScopeRows = (caller.scope || []).filter((s) => s.scope_type === "brand" && s.brand_id);
  if (brandScopeRows.length) {
    const ids = [...new Set(brandScopeRows.map((s) => s.brand_id))];
    const brandRes = await sb("/rest/v1/bi_brands?id=in.(" + ids.join(",") + ")&select=id,name,logo_url,accent_color,accent_deep_color");
    const brandRows = await brandRes.json();
    clientBrands = Array.isArray(brandRows) ? brandRows : [];
    clientBrand = clientBrands[0] || null;
  }

  return json(200, {
    ok: true,
    staff: caller.staff,
    scope: caller.scope,
    clientBrand,
    clientBrands,
  });
};
