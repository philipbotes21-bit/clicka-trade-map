// netlify/functions/mcp-connector.js
//
// FUNCTION — Clicka MCP data connector.
//
// Lets a Clicka client (Tiger, Unilever, etc.) plug their own AI tool
// (Claude, ChatGPT, or anything else that speaks MCP) straight into their
// own brand-scoped Clicka data, using an API key issued from Clicka Admin's
// "Client API keys" panel (admin-client-api-keys.js) instead of a Clicka
// Admin login.
//
// This function is a thin translator, on purpose: it does no reporting
// logic of its own. Every tool call turns straight into a call of the
// SAME bi-sales-in.js / bi-sales-out.js / bi-products.js handlers the BI
// Reports app already uses — in-process, not over the network — via a
// shared-secret "internal service" header those three files recognise
// (see CLICKA_MCP_INTERNAL_KEY in each of them). The brand lock is always
// resolved HERE, from the caller's API key, and handed to those functions
// as a fixed brand id — never anything the client's AI could override by
// asking differently.
//
// Speaks MCP's "Streamable HTTP" transport in stateless mode: one POST
// endpoint, one JSON-RPC request in, one JSON-RPC response out. No
// server-held session state between calls (each request carries its own
// bearer key), which is the right fit for a serverless function.
//
// Phase 1 build: sales_in, sales_out, and products tools only. Onboarding
// and cashless are deliberately left out for now (Philip, Sept 2026) —
// wiring in a 4th/5th tool later is a copy of the same pattern below, not
// a redesign.
//
// Self-test (no key needed, no data touched):
//   /.netlify/functions/mcp-connector?selftest=1

const crypto = require("crypto");
const SUPABASE_URL = "https://liemaxqgngtotzbqiqeq.supabase.co";
const SERVICE_KEY =
  process.env.CLICKA_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const MCP_INTERNAL_KEY = process.env.CLICKA_MCP_INTERNAL_KEY;

const salesIn = require("./bi-sales-in");
const salesOut = require("./bi-sales-out");
const products = require("./bi-products");

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
    body: JSON.stringify(obj),
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

// Looks the caller's API key up by its sha256 hash (the same one
// admin-client-api-keys.js stored at generation time — the plaintext key
// itself is never stored anywhere). Returns { brandId, brandName, keyId }
// or null if the key is missing, unknown, or revoked.
async function resolveApiKeyCaller(event) {
  const header = event.headers.authorization || event.headers.Authorization;
  if (!header) return null;
  const key = header.replace(/^Bearer\s+/i, "").trim();
  if (!key) return null;

  const hash = crypto.createHash("sha256").update(key).digest("hex");
  const res = await sb("/rest/v1/clicka_client_api_keys?key_hash=eq." + hash + "&status=eq.active&select=id,brand_id");
  const rows = await res.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;

  const brandRes = await sb("/rest/v1/bi_brands?id=eq." + row.brand_id + "&select=id,name");
  const brandRows = await brandRes.json();
  const brand = Array.isArray(brandRows) ? brandRows[0] : null;
  if (!brand) return null;

  // Fire-and-forget usage stamp — never blocks or fails the actual call.
  sb("/rest/v1/clicka_client_api_keys?id=eq." + row.id, {
    method: "PATCH",
    body: JSON.stringify({ last_used_at: new Date().toISOString() }),
  }).catch(() => {});

  return { brandId: brand.id, brandName: brand.name, keyId: row.id };
}

// Calls one of the existing bi-*.js handlers in-process, as the internal
// service, locked to the given brand. Returns the parsed JSON body (not
// the raw Netlify response object).
// Client-safe error message — a report failure never leaks internal detail
// (table/function names, SQL error text, stack traces) to an outside AI
// tool. The real error is still logged server-side (Netlify function logs)
// for us to debug; only this generic line goes out over MCP.
const CLIENT_SAFE_ERROR = "This report couldn't be generated right now. Please try again shortly, or narrow the date range or filters.";

async function callBiFunction(handlerModule, brandId, params) {
  const qs = Object.assign({}, params, { internal_brand_id: String(brandId) });
  Object.keys(qs).forEach((k) => { if (qs[k] === undefined || qs[k] === null || qs[k] === "") delete qs[k]; });
  const fakeEvent = {
    httpMethod: "GET",
    queryStringParameters: qs,
    headers: { "x-clicka-mcp-key": MCP_INTERNAL_KEY },
  };
  const res = await handlerModule.handler(fakeEvent);
  let body;
  try { body = JSON.parse(res.body); } catch (e) { body = { ok: false, error: "Bad response from report function." }; }
  if (body && body.ok === false) {
    console.error("MCP connector: underlying report call failed:", body.error);
    body = { ok: false, error: CLIENT_SAFE_ERROR };
  }
  return body;
}

// ---- MCP tool definitions — Phase 1: sales_in, sales_out, products ----
const FILTER_SCHEMA_PROPS = {
  region: { type: "string", description: "Province name to filter to, e.g. \"Gauteng\". Omit for all provinces." },
  subregion: { type: "string", description: "Sub-region name to filter to, e.g. \"Tembisa\". Omit for all sub-regions." },
  start: { type: "string", description: "Start date, YYYY-MM-DD. Omit for no lower bound." },
  end: { type: "string", description: "End date, YYYY-MM-DD. Omit for no upper bound." },
};

const TOOLS = [
  {
    name: "get_sales_in",
    description: "Sales In: Midi orders from wholesalers for your brand — volumes, value, by region/sub-region/month, top wholesalers and Midis.",
    inputSchema: { type: "object", properties: FILTER_SCHEMA_PROPS },
  },
  {
    name: "get_sales_out",
    description: "Sales Out: Spaza shop orders placed through Midis for your brand — volumes, value, by region/sub-region/month.",
    inputSchema: { type: "object", properties: FILTER_SCHEMA_PROPS },
  },
  {
    name: "get_products",
    description: "Products: which SKUs and categories of your brand are moving, by region.",
    inputSchema: { type: "object", properties: FILTER_SCHEMA_PROPS },
  },
];

async function runTool(name, args, brandId) {
  const params = {
    region: args && args.region,
    subregion: args && args.subregion,
    start: args && args.start,
    end: args && args.end,
  };
  if (name === "get_sales_in") return callBiFunction(salesIn, brandId, params);
  if (name === "get_sales_out") return callBiFunction(salesOut, brandId, params);
  if (name === "get_products") return callBiFunction(products, brandId, params);
  return { ok: false, error: "Unknown tool: " + name };
}

// ---- JSON-RPC 2.0 dispatch ----
function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

  const qs = event.queryStringParameters || {};
  if (qs.selftest === "1") {
    return json(200, {
      ok: true,
      world: "CLICKA-MCP",
      serviceKeySet: !!SERVICE_KEY,
      internalKeySet: !!MCP_INTERNAL_KEY,
      note: (!SERVICE_KEY || !MCP_INTERNAL_KEY)
        ? "Missing config — set CLICKA_SERVICE_ROLE_KEY and CLICKA_MCP_INTERNAL_KEY in this Netlify site's environment variables."
        : "Config looks good.",
    });
  }

  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "MCP requests are POST." });
  if (!SERVICE_KEY || !MCP_INTERNAL_KEY) return json(500, { ok: false, error: "Connector not configured in Netlify." });

  let rpcReq;
  try { rpcReq = JSON.parse(event.body || "{}"); } catch (e) {
    return json(200, rpcError(null, -32700, "Parse error"));
  }
  const { id, method, params } = rpcReq;

  // Handshake and notifications need no auth — a client's MCP library
  // always sends these before it knows whether a key is even needed.
  if (method === "initialize") {
    return json(200, rpcResult(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "clicka-data-connector", version: "1.0.0" },
    }));
  }
  if (method === "notifications/initialized" || method === "ping") {
    return json(200, rpcResult(id, {}));
  }

  // Every other method needs a valid, active client API key.
  const caller = await resolveApiKeyCaller(event);
  if (!caller) return json(200, rpcError(id, -32001, "Missing or invalid API key — pass it as \"Authorization: Bearer <key>\"."));

  if (method === "tools/list") {
    return json(200, rpcResult(id, { tools: TOOLS }));
  }

  if (method === "tools/call") {
    const toolName = params && params.name;
    const toolArgs = (params && params.arguments) || {};
    try {
      const data = await runTool(toolName, toolArgs, caller.brandId);
      return json(200, rpcResult(id, {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        isError: data && data.ok === false,
      }));
    } catch (e) {
      console.error("MCP connector: tool call threw:", e && e.message);
      return json(200, rpcResult(id, {
        content: [{ type: "text", text: CLIENT_SAFE_ERROR }],
        isError: true,
      }));
    }
  }

  return json(200, rpcError(id, -32601, "Method not found: " + method));
};
