// admin/netlify/functions/admin-whoami.js
//
// FUNCTION — "Who am I?"
// The front-end calls this right after login to find out which
// clicka_staff profile belongs to the signed-in session, and therefore
// which role/scope-gated parts of the dashboard to show.
//
// Self-test (no auth needed, no data touched):
//   /.netlify/functions/admin-whoami?selftest=1

const { SERVICE_KEY, json, getCaller } = require("./_auth");

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

  return json(200, {
    ok: true,
    staff: caller.staff,
    scope: caller.scope,
  });
};
