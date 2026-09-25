// admin/netlify/functions/admin-users.js
//
// FUNCTION — Clicka Admin: staff / Users management.
// GET    -> list every clicka_staff row + their scope, admin-only. (The
//           Export to Excel button in the UI reuses this same list —
//           there's no separate ?export=1 shape, the scope labels already
//           returned here are enough.)
// POST   -> create a new staff member with a temporary password (no email
//           sending involved for now — an Admin tells the person their
//           temporary password directly). Admin-only, EXCEPT the very first
//           account ever created (bootstrap): if the clicka_staff table is
//           still empty, one admin account may be created without an
//           existing admin having to be logged in yet.
// POST   body: { rows: [...] } -> bulk import from the Users Excel template
//           (see cadDownloadUsersTemplate in the frontend for the exact
//           columns). Admin-only, max 50 rows/call — the frontend chunks
//           larger files. Each row goes through the exact same account
//           creation path as a single Add Staff — a temporary password
//           (universal default if left blank), no email sent. A row whose
//           email already belongs to a staff member is skipped, not
//           overwritten — bulk import creates, it doesn't edit; use the
//           Edit staff modal (or a password reset) for an existing person.
// PATCH  -> update an existing staff member's details/role/status/scope.
//           Admin-only.
// PATCH  body: { new_password } -> instantly set a staff member's password
//           via the Supabase Admin API — no reset email, no old password
//           needed. This is how an Admin handles "I forgot my password":
//           set a new one on the spot and relay it to them directly (e.g.
//           over WhatsApp). Admin-only. Can be combined with other PATCH
//           fields in the same call, or sent on its own.
//
// Self-test (no auth needed, no data touched):
//   /.netlify/functions/admin-users?selftest=1

const { SUPABASE_URL, SERVICE_KEY, json, sb, getCaller } = require("./_auth");

const ROLES = ["admin", "agent", "ppm_agent", "supervisor", "regional_manager", "self_order_manager", "driver", "client_rep"];

async function requireAdmin(event) {
  const caller = await getCaller(event);
  if (!caller || !caller.staff) return { error: json(401, { ok: false, error: "Not signed in." }) };
  if (caller.staff.status === "inactive") return { error: json(403, { ok: false, error: "Account deactivated." }) };
  if (caller.staff.role !== "admin") return { error: json(403, { ok: false, error: "Admin access only." }) };
  return { caller };
}

function validateScopeRows(role, scopeInput) {
  const rows = Array.isArray(scopeInput) ? scopeInput : [];

  const cleaned = [];
  for (const s of rows) {
    if (!s || !s.scope_type) continue;
    if (s.scope_type === "province" && s.province) {
      cleaned.push({ scope_type: "province", province: s.province, region_id: null, midi_id: null, store_id: null, brand_id: null });
    } else if (s.scope_type === "region" && s.region_id) {
      cleaned.push({ scope_type: "region", province: null, region_id: s.region_id, midi_id: null, store_id: null, brand_id: null });
    } else if (s.scope_type === "midi" && s.midi_id) {
      cleaned.push({ scope_type: "midi", province: null, region_id: null, midi_id: s.midi_id, store_id: null, brand_id: null });
    } else if (s.scope_type === "store" && s.store_id) {
      cleaned.push({ scope_type: "store", province: null, region_id: null, midi_id: null, store_id: s.store_id, brand_id: null });
    } else if (s.scope_type === "brand" && s.brand_id) {
      cleaned.push({ scope_type: "brand", province: null, region_id: null, midi_id: null, store_id: null, brand_id: s.brand_id });
    }
  }

  // Client / brand used to be purely cosmetic branding (logo/colours on
  // Spaza Onboard) and stayed allowed alongside any role, including Admin,
  // without counting toward the role-specific "must be assigned to X"
  // checks below. It's since become a REAL access boundary too — BI
  // Reports, Invoices/Cashless and Stores are all brand-locked for anyone
  // scoped to a brand (see resolveBrandLock(s) in the various _auth.js
  // files) — but it's still layered on top of a role's normal scope for
  // every role except client_rep, which exists purely to carry brand scope
  // and nothing else: a client_rep has no province/region/midi/store scope
  // at all, only one or more brand rows (can be assigned to several
  // clients at once).
  const brandRows = cleaned.filter((r) => r.scope_type === "brand");
  const roleScoped = role === "admin" || role === "client_rep" ? [] : cleaned.filter((r) => r.scope_type !== "brand"); // admins/client_reps are otherwise unscoped by design

  if (role === "ppm_agent" && roleScoped.filter((r) => r.scope_type === "midi").length === 0) {
    return { error: "A PPM Agent must be assigned to at least one Midi / wholesaler." };
  }
  if (role === "regional_manager" && roleScoped.filter((r) => r.scope_type === "province").length === 0) {
    return { error: "A Regional Manager must be assigned to a province." };
  }
  if ((role === "agent" || role === "supervisor") && roleScoped.length === 0) {
    return { error: "Please assign at least one region or sub-region." };
  }
  if (role === "self_order_manager" && roleScoped.filter((r) => r.scope_type === "store").length === 0) {
    return { error: "A Self Order Manager must be linked to a store." };
  }
  if (role === "client_rep" && brandRows.length === 0) {
    return { error: "A Client Representative must be assigned to at least one Client / brand." };
  }
  return { rows: [...roleScoped, ...brandRows] };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

  const qs = event.queryStringParameters || {};
  if (qs.selftest === "1") {
    return json(200, { ok: true, world: "CLICKA-ADMIN", serviceKeySet: !!SERVICE_KEY });
  }
  if (!SERVICE_KEY) return json(500, { ok: false, error: "Service key not configured in Netlify." });

  // ---------- GET: public bootstrap check ----------
  // No auth required — the login screen calls this to decide whether to
  // offer "create the first Admin account". Reveals nothing except whether
  // any staff exist yet.
  if (event.httpMethod === "GET" && qs.bootstrap_check === "1") {
    const countRes = await sb("/rest/v1/clicka_staff?select=id&limit=1");
    const countRows = await countRes.json();
    return json(200, { ok: true, empty: Array.isArray(countRows) && countRows.length === 0 });
  }

  // ---------- GET: list staff ----------
  if (event.httpMethod === "GET") {
    const gate = await requireAdmin(event);
    if (gate.error) return gate.error;

    const staffRes = await sb("/rest/v1/clicka_staff?select=*&order=first_name.asc,last_name.asc");
    const staff = await staffRes.json();

    const scopeRes = await sb("/rest/v1/clicka_staff_scope?select=*");
    const scope = await scopeRes.json();

    const regionsRes = await sb("/rest/v1/bi_regions?select=id,name,province");
    const regions = await regionsRes.json();
    const midisRes = await sb("/rest/v1/bi_midis?select=id,name,province,region");
    const midis = await midisRes.json();
    const storeIds = [...new Set((scope || []).filter((s) => s.scope_type === "store" && s.store_id).map((s) => s.store_id))];
    let storesById = {};
    if (storeIds.length) {
      const storesRes = await sb("/rest/v1/clicka_registrations?id=in.(" + storeIds.join(",") + ")&select=id,trading_name");
      const stores = await storesRes.json();
      storesById = Object.fromEntries((stores || []).map((s) => [s.id, s]));
    }
    const brandsRes = await sb("/rest/v1/bi_brands?select=id,name");
    const brands = await brandsRes.json();
    const brandsById = Object.fromEntries((brands || []).map((b) => [b.id, b]));

    const regionsById = Object.fromEntries((regions || []).map((r) => [r.id, r]));
    const midisById = Object.fromEntries((midis || []).map((m) => [m.id, m]));

    const scopeByStaff = {};
    for (const s of scope || []) {
      if (!scopeByStaff[s.staff_id]) scopeByStaff[s.staff_id] = [];
      let label = "";
      if (s.scope_type === "province") label = s.province;
      else if (s.scope_type === "region") label = regionsById[s.region_id] ? regionsById[s.region_id].name + " (" + regionsById[s.region_id].province + ")" : "Unknown region";
      else if (s.scope_type === "midi") label = midisById[s.midi_id] ? midisById[s.midi_id].name : "Unknown Midi";
      else if (s.scope_type === "store") label = storesById[s.store_id] ? storesById[s.store_id].trading_name : "Unknown store";
      else if (s.scope_type === "brand") label = brandsById[s.brand_id] ? brandsById[s.brand_id].name : "Unknown client";
      scopeByStaff[s.staff_id].push({ ...s, label });
    }

    const enriched = (staff || []).map((st) => ({ ...st, scope: scopeByStaff[st.id] || [] }));
    return json(200, { ok: true, staff: enriched });
  }

  // ---------- POST: bulk import ----------
  if (event.httpMethod === "POST") {
    let bodyPeek;
    try {
      bodyPeek = JSON.parse(event.body || "{}");
    } catch (e) {
      return json(400, { ok: false, error: "Invalid JSON body." });
    }
    if (Array.isArray(bodyPeek.rows)) {
      const gate = await requireAdmin(event);
      if (gate.error) return gate.error;

      const rows = bodyPeek.rows;
      if (!rows.length) return json(400, { ok: false, error: "No rows to import." });
      if (rows.length > 50) return json(400, { ok: false, error: "Send at most 50 rows per request — split larger files into chunks." });

      const ROLE_BY_LABEL = {
        "admin": "admin", "agent": "agent", "ppm agent": "ppm_agent",
        "ppm agent (payment & packing manager)": "ppm_agent",
        "supervisor": "supervisor", "regional manager": "regional_manager",
        "self order manager": "self_order_manager", "self order manager (shop owner)": "self_order_manager",
        "driver": "driver", "client representative": "client_rep", "client rep": "client_rep",
      };

      const [regionsRes, midisRes, brandsRes, storesRes, existingStaffRes] = await Promise.all([
        sb("/rest/v1/bi_regions?select=id,name,province"),
        sb("/rest/v1/bi_midis?select=id,name"),
        sb("/rest/v1/bi_brands?select=id,name"),
        sb("/rest/v1/clicka_registrations?merged_into_id=is.null&select=id,trading_name"),
        sb("/rest/v1/clicka_staff?select=email"),
      ]);
      const regionRows = await regionsRes.json();
      const midiRows = await midisRes.json();
      const brandRows = await brandsRes.json();
      const storeRows = await storesRes.json();
      const existingStaffRows = await existingStaffRes.json();

      const regionByKey = {}; // "name|province" lowercased -> id
      (Array.isArray(regionRows) ? regionRows : []).forEach((r) => { regionByKey[(r.name + "|" + r.province).toLowerCase()] = r.id; });
      const midiByName = {};
      (Array.isArray(midiRows) ? midiRows : []).forEach((m) => { midiByName[m.name.toLowerCase()] = m.id; });
      const brandByName = {};
      (Array.isArray(brandRows) ? brandRows : []).forEach((b) => { brandByName[b.name.toLowerCase()] = b.id; });
      const storeByName = {};
      (Array.isArray(storeRows) ? storeRows : []).forEach((s) => { storeByName[(s.trading_name || "").toLowerCase()] = s.id; });
      const existingEmails = new Set((Array.isArray(existingStaffRows) ? existingStaffRows : []).map((s) => s.email.toLowerCase()));

      const results = [];
      for (const row of rows) {
        const rowNum = row.row_number || results.length + 1;
        const first_name = String(row.first_name || "").trim();
        const last_name = String(row.last_name || "").trim();
        const email = String(row.email || "").trim();
        const roleLabel = String(row.role || "").trim().toLowerCase();
        const role = ROLE_BY_LABEL[roleLabel];

        if (!first_name || !last_name || !email) { results.push({ row_number: rowNum, email, status: "error", message: "First name, last name, and email are required." }); continue; }
        if (!role) { results.push({ row_number: rowNum, email, status: "error", message: row.role ? "Unrecognized role: \"" + row.role + "\"." : "Role is required." }); continue; }
        if (existingEmails.has(email.toLowerCase())) { results.push({ row_number: rowNum, email, status: "skipped", message: "A staff member with this email already exists — edit them individually instead." }); continue; }

        // ---- resolve this row's scope from plain-text names ----
        const scopeRows = [];
        let resolveError = null;
        const province = String(row.province || "").trim();

        if (role === "regional_manager") {
          if (!province) resolveError = "Regional Manager needs a Province.";
          else scopeRows.push({ scope_type: "province", province });
        } else if (role === "ppm_agent") {
          const midiName = String(row.midi || "").trim();
          if (!midiName) resolveError = "PPM Agent needs a Midi / Wholesaler.";
          else {
            const id = midiByName[midiName.toLowerCase()];
            if (!id) resolveError = "Midi / Wholesaler \"" + midiName + "\" not found.";
            else scopeRows.push({ scope_type: "midi", midi_id: id });
          }
        } else if (role === "agent" || role === "supervisor") {
          const names = String(row.sub_region || "").split(";").map((s) => s.trim()).filter(Boolean);
          if (!names.length) resolveError = (role === "agent" ? "Agent" : "Supervisor") + " needs at least one Sub-region.";
          else if (!province) resolveError = "Sub-region needs a Province to match against.";
          else {
            for (const n of names) {
              const id = regionByKey[(n + "|" + province).toLowerCase()];
              if (!id) { resolveError = "Sub-region \"" + n + "\" not found in " + province + "."; break; }
              scopeRows.push({ scope_type: "region", region_id: id });
            }
          }
        } else if (role === "self_order_manager") {
          const storeName = String(row.store || "").trim();
          if (!storeName) resolveError = "Self Order Manager needs a Store.";
          else {
            const id = storeByName[storeName.toLowerCase()];
            if (!id) resolveError = "Store \"" + storeName + "\" not found.";
            else scopeRows.push({ scope_type: "store", store_id: id });
          }
        }

        if (role === "client_rep") {
          const names = String(row.client_brand || "").split(";").map((s) => s.trim()).filter(Boolean);
          if (!names.length) resolveError = "Client Representative needs at least one Client / brand.";
          else {
            for (const n of names) {
              const id = brandByName[n.toLowerCase()];
              if (!id) { resolveError = "Client / brand \"" + n + "\" not found."; break; }
              scopeRows.push({ scope_type: "brand", brand_id: id });
            }
          }
        } else if (row.client_brand && String(row.client_brand).trim()) {
          // Cosmetic white-label pick for any other role — single, optional.
          const n = String(row.client_brand).split(";")[0].trim();
          const id = brandByName[n.toLowerCase()];
          if (id) scopeRows.push({ scope_type: "brand", brand_id: id });
        }

        if (resolveError) { results.push({ row_number: rowNum, email, status: "error", message: resolveError }); continue; }

        const scopeCheck = validateScopeRows(role, scopeRows);
        if (scopeCheck.error) { results.push({ row_number: rowNum, email, status: "error", message: scopeCheck.error }); continue; }

        const tempPassword = (row.temp_password && String(row.temp_password).trim().length >= 8) ? String(row.temp_password).trim() : "Clicka123@";

        const createRes = await fetch(SUPABASE_URL + "/auth/v1/admin/users", {
          method: "POST",
          headers: { Authorization: "Bearer " + SERVICE_KEY, apikey: SERVICE_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ email, password: tempPassword, email_confirm: true }),
        });
        const createBody = await createRes.json();
        if (!createRes.ok) {
          results.push({ row_number: rowNum, email, status: "error", message: "Couldn't create account: " + (createBody.msg || createBody.error_description || JSON.stringify(createBody)).slice(0, 200) });
          continue;
        }
        const authUserId = createBody.id;

        const staffInsertRes = await sb("/rest/v1/clicka_staff", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({
            auth_user_id: authUserId, first_name, last_name, email,
            cell_number: row.cell_number ? String(row.cell_number).trim() : null,
            alt_number: row.alt_number ? String(row.alt_number).trim() : null,
            role, status: "active",
          }),
        });
        const staffInsertBody = await staffInsertRes.json();
        if (!staffInsertRes.ok) {
          results.push({ row_number: rowNum, email, status: "error", message: "Account created but staff record failed: " + JSON.stringify(staffInsertBody).slice(0, 200) });
          continue;
        }
        const staff = staffInsertBody[0];
        existingEmails.add(email.toLowerCase()); // guard against a duplicate row later in the SAME file

        if (scopeCheck.rows.length) {
          await sb("/rest/v1/clicka_staff_scope", {
            method: "POST",
            body: JSON.stringify(scopeCheck.rows.map((r) => ({ ...r, staff_id: staff.id }))),
          });
        }

        results.push({ row_number: rowNum, email, status: "created", id: staff.id, temp_password: tempPassword });
      }

      results.sort((a, b) => a.row_number - b.row_number);
      const summary = {
        total: results.length,
        created: results.filter((r) => r.status === "created").length,
        skipped: results.filter((r) => r.status === "skipped").length,
        errors: results.filter((r) => r.status === "error").length,
      };
      return json(200, { ok: true, summary, results });
    }
  }

  // ---------- POST: invite / create ----------
  if (event.httpMethod === "POST") {
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch (e) {
      return json(400, { ok: false, error: "Invalid JSON body." });
    }

    const countRes = await sb("/rest/v1/clicka_staff?select=id&limit=1");
    const countRows = await countRes.json();
    const isBootstrap = Array.isArray(countRows) && countRows.length === 0;

    if (!isBootstrap) {
      const gate = await requireAdmin(event);
      if (gate.error) return gate.error;
    } else if (body.role !== "admin") {
      return json(400, {
        ok: false,
        error: "No staff exist yet — the first account created must be an Admin.",
      });
    }

    const { first_name, last_name, email, cell_number, alt_number, role } = body;
    if (!first_name || !last_name || !email || !role) {
      return json(400, { ok: false, error: "first_name, last_name, email, and role are required." });
    }
    if (!ROLES.includes(role)) {
      return json(400, { ok: false, error: "Invalid role." });
    }

    const scopeCheck = validateScopeRows(role, body.scope);
    if (scopeCheck.error) return json(400, { ok: false, error: scopeCheck.error });

    // 1. Create (or, if a previous attempt already created the auth user,
    //    re-use and re-password) the account directly with a temporary
    //    password — no invite email involved. Email sending is parked for
    //    now; staff are told their temporary password directly by an Admin.
    const tempPassword = (body.temp_password && String(body.temp_password).length >= 8)
      ? body.temp_password
      : "Clicka123@";

    let authUserId = null;
    const createRes = await fetch(SUPABASE_URL + "/auth/v1/admin/users", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + SERVICE_KEY,
        apikey: SERVICE_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password: tempPassword, email_confirm: true }),
    });
    const createBody = await createRes.json();

    if (createRes.ok) {
      authUserId = createBody.id;
    } else if (createBody.error_code === "email_exists" || createRes.status === 422) {
      // Left over from an earlier attempt (e.g. an invite that failed to
      // send) — find that auth user and set the temporary password on it
      // instead of failing outright.
      const lookupRes = await fetch(SUPABASE_URL + "/auth/v1/admin/users?email=" + encodeURIComponent(email), {
        headers: { Authorization: "Bearer " + SERVICE_KEY, apikey: SERVICE_KEY },
      });
      const lookupBody = await lookupRes.json();
      const existing = (lookupBody.users || lookupBody || [])[0];
      if (!existing || !existing.id) {
        return json(200, { ok: false, stage: "create_account", error: "An account with this email already exists but couldn't be located to reset." });
      }
      const updateRes = await fetch(SUPABASE_URL + "/auth/v1/admin/users/" + existing.id, {
        method: "PUT",
        headers: {
          Authorization: "Bearer " + SERVICE_KEY,
          apikey: SERVICE_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ password: tempPassword, email_confirm: true }),
      });
      if (!updateRes.ok) {
        const t = await updateRes.text();
        return json(200, { ok: false, stage: "create_account", error: t.slice(0, 300) });
      }
      authUserId = existing.id;
    } else {
      return json(200, {
        ok: false,
        stage: "create_account",
        error: createBody.msg || createBody.error_description || JSON.stringify(createBody).slice(0, 300),
      });
    }

    // 2. Create the clicka_staff row, linked to that auth user.
    const staffInsertRes = await sb("/rest/v1/clicka_staff", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        auth_user_id: authUserId,
        first_name,
        last_name,
        email,
        cell_number: cell_number || null,
        alt_number: alt_number || null,
        role,
        status: "active",
      }),
    });
    const staffInsertBody = await staffInsertRes.json();
    if (!staffInsertRes.ok) {
      return json(200, {
        ok: false,
        stage: "insert_staff",
        error: JSON.stringify(staffInsertBody).slice(0, 400),
      });
    }
    const staff = staffInsertBody[0];

    // 3. Create the scope rows (region / sub-region / Midi assignment).
    if (scopeCheck.rows.length) {
      await sb("/rest/v1/clicka_staff_scope", {
        method: "POST",
        body: JSON.stringify(scopeCheck.rows.map((r) => ({ ...r, staff_id: staff.id }))),
      });
    }

    return json(200, { ok: true, staff, tempPassword });
  }

  // ---------- PATCH: update ----------
  if (event.httpMethod === "PATCH") {
    const gate = await requireAdmin(event);
    if (gate.error) return gate.error;

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch (e) {
      return json(400, { ok: false, error: "Invalid JSON body." });
    }
    const id = qs.id || body.id;
    if (!id) return json(400, { ok: false, error: "Missing id." });

    // Instant password set — no reset email, no old password needed. Used
    // for the "staff member forgot their password" case: an Admin sets a
    // fresh one right here and relays it directly (e.g. over WhatsApp).
    if (body.new_password !== undefined) {
      const newPassword = String(body.new_password || "").trim();
      if (newPassword.length < 8) return json(400, { ok: false, error: "Password must be at least 8 characters." });

      const staffRowRes = await sb("/rest/v1/clicka_staff?id=eq." + id + "&select=auth_user_id");
      const staffRowsForPw = await staffRowRes.json();
      const authUserId = staffRowsForPw[0] && staffRowsForPw[0].auth_user_id;
      if (!authUserId) return json(404, { ok: false, error: "Staff member not found." });

      const pwRes = await fetch(SUPABASE_URL + "/auth/v1/admin/users/" + authUserId, {
        method: "PUT",
        headers: { Authorization: "Bearer " + SERVICE_KEY, apikey: SERVICE_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ password: newPassword }),
      });
      if (!pwRes.ok) {
        const t = await pwRes.text();
        return json(200, { ok: false, stage: "set_password", error: t.slice(0, 300) });
      }
      // Falls through to the normal patch handling below, in case other
      // fields were sent in the same request — but works fine standalone too.
    }

    const role = body.role;
    if (role && !ROLES.includes(role)) return json(400, { ok: false, error: "Invalid role." });

    const patch = {};
    for (const f of ["first_name", "last_name", "cell_number", "alt_number", "role", "status"]) {
      if (body[f] !== undefined) patch[f] = body[f];
    }
    patch.updated_at = new Date().toISOString();

    if (Object.keys(patch).length) {
      const updRes = await sb("/rest/v1/clicka_staff?id=eq." + id, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(patch),
      });
      if (!updRes.ok) {
        const t = await updRes.text();
        return json(200, { ok: false, stage: "update_staff", error: t.slice(0, 400) });
      }
    }

    // Replace scope rows if a new scope array was sent.
    if (body.scope !== undefined) {
      const effectiveRole = role || (await (async () => {
        const r = await sb("/rest/v1/clicka_staff?id=eq." + id + "&select=role");
        const rows = await r.json();
        return rows[0] ? rows[0].role : null;
      })());
      const scopeCheck = validateScopeRows(effectiveRole, body.scope);
      if (scopeCheck.error) return json(400, { ok: false, error: scopeCheck.error });

      await sb("/rest/v1/clicka_staff_scope?staff_id=eq." + id, { method: "DELETE" });
      if (scopeCheck.rows.length) {
        await sb("/rest/v1/clicka_staff_scope", {
          method: "POST",
          body: JSON.stringify(scopeCheck.rows.map((r) => ({ ...r, staff_id: id }))),
        });
      }
    }

    return json(200, { ok: true });
  }

  return json(405, { ok: false, error: "Method not allowed." });
};
