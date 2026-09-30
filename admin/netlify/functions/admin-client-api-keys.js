// admin/netlify/functions/admin-client-api-keys.js
//
// FUNCTION — Clicka Admin: Client API keys for the MCP data connector.
// Lets Admin generate and revoke a per-brand API key that an outside
// client plugs into their own AI tool (Claude, ChatGPT, etc.) so it can
// query their own brand-scoped BI data through the MCP connector
// (netlify/functions/mcp-connector.js at the repo root). This function
// only manages the keys themselves — it never serves BI data.
//
// The plaintext key is shown to the caller ONCE, at creation time, and
// never again — only a sha256 hash of it is stored, the same pattern a
// password would use. The connector looks a caller's key up by hashing
// whatever it receives and matching that hash, never by storing or
// comparing plaintext.
//
// GET             -> list every key (brand name, label, status, prefix,
//                    created/revoked dates, last used) — never the full key.
// POST            -> create one { brand_id, label }. Returns the plaintext
//                    key ONCE in the response — the UI must show/copy it
//                    immediately and warn it won't be shown again.
// PATCH ?id=...   -> { action: "revoke" }. Revoking is permanent here (no
//                    un-revoke) — generate a new key instead.
//
// Admin-only — this hands out access to a client's data, same trust level
// as creating a staff login.
//
// Self-test (no auth needed, no data touched):
//   /.netlify/functions/admin-client-api-keys?selftest=1

const crypto = require("crypto");
const { json, sb, getCaller } = require("./_auth");

const KEY_PREFIX = "cka_live_";
const PREFIX_SHOW_CHARS = 12; // "cka_live_" + 3 more chars, enough to tell keys apart in the list without exposing them

function generateKey() {
  const raw = crypto.randomBytes(32).toString("hex"); // 64 hex chars
  const full = KEY_PREFIX + raw;
  const hash = crypto.createHash("sha256").update(full).digest("hex");
  const prefix = full.slice(0, PREFIX_SHOW_CHARS) + "…";
  return { full, hash, prefix };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

  const qs = event.queryStringParameters || {};
  if (qs.selftest === "1") return json(200, { ok: true, world: "CLICKA-ADMIN" });

  const caller = await getCaller(event);
  if (!caller || !caller.staff) return json(401, { ok: false, error: "Not signed in." });
  if (caller.staff.status === "inactive") return json(403, { ok: false, error: "Account deactivated." });
  if (caller.staff.role !== "admin") {
    return json(403, { ok: false, error: "Client API keys are Admin-only — they hand out access to a client's data." });
  }

  if (event.httpMethod === "GET") {
    const keysRes = await sb("/rest/v1/clicka_client_api_keys?select=id,brand_id,label,key_prefix,status,created_at,revoked_at,last_used_at&order=created_at.desc");
    const keys = await keysRes.json();

    const brandsRes = await sb("/rest/v1/bi_brands?select=id,name");
    const brands = await brandsRes.json();
    const brandsById = Object.fromEntries((brands || []).map((b) => [b.id, b.name]));

    const enriched = (keys || []).map((k) => ({
      id: k.id,
      brand_id: k.brand_id,
      brand_name: brandsById[k.brand_id] || "Unknown brand",
      label: k.label,
      key_prefix: k.key_prefix,
      status: k.status,
      created_at: k.created_at,
      revoked_at: k.revoked_at,
      last_used_at: k.last_used_at,
    }));

    return json(200, { ok: true, keys: enriched });
  }

  if (event.httpMethod === "POST") {
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { ok: false, error: "Invalid JSON body." }); }

    const brandId = Number(body.brand_id);
    if (!brandId) return json(400, { ok: false, error: "brand_id is required." });
    const label = String(body.label || "").trim();
    if (!label) return json(400, { ok: false, error: "A label is required (e.g. \"Philip — internal test\")." });

    const brandCheckRes = await sb("/rest/v1/bi_brands?id=eq." + brandId + "&select=id,name");
    const brandCheck = await brandCheckRes.json();
    if (!Array.isArray(brandCheck) || !brandCheck.length) return json(400, { ok: false, error: "That brand doesn't exist." });

    const { full, hash, prefix } = generateKey();

    const insertRes = await sb("/rest/v1/clicka_client_api_keys", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        brand_id: brandId,
        label,
        key_hash: hash,
        key_prefix: prefix,
        status: "active",
        created_by: caller.staff.id,
      }),
    });
    if (!insertRes.ok) {
      const t = await insertRes.text();
      return json(500, { ok: false, error: "Could not create key: " + t.slice(0, 300) });
    }
    const inserted = await insertRes.json();
    const row = Array.isArray(inserted) ? inserted[0] : inserted;

    return json(200, {
      ok: true,
      key: full, // shown ONCE — the UI is responsible for making the user copy it now
      id: row.id,
      brand_name: brandCheck[0].name,
      label,
      warning: "This key will not be shown again. Copy it now and give it to the client (or use it yourself for testing).",
    });
  }

  if (event.httpMethod === "PATCH") {
    const id = qs.id;
    if (!id) return json(400, { ok: false, error: "id query param required." });
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { ok: false, error: "Invalid JSON body." }); }
    if (body.action !== "revoke") return json(400, { ok: false, error: "Only { action: \"revoke\" } is supported." });

    const updateRes = await sb("/rest/v1/clicka_client_api_keys?id=eq." + id, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ status: "revoked", revoked_at: new Date().toISOString() }),
    });
    if (!updateRes.ok) {
      const t = await updateRes.text();
      return json(500, { ok: false, error: "Could not revoke key: " + t.slice(0, 300) });
    }
    return json(200, { ok: true });
  }

  return json(405, { ok: false, error: "Method not allowed." });
};
