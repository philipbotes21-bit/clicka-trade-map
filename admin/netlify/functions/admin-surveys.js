// admin/netlify/functions/admin-surveys.js
//
// FUNCTION — Clicka: survey definitions (branding checks, merchandising
// audits, general questions — anything an Agent can be asked at a store,
// including photos). Admin builds a survey, targets it at one or more
// provinces/sub-regions, and publishes it. Any Agent whose store pool
// touches a targeted province/region sees it in Spaza Onboard. Surveys are
// repeatable by design — a store can be surveyed again later; every
// submission (admin-survey-responses.js) is its own dated record so Admin
// can see what changed between visits.
//
// GET   (no id, no for_agent)      -> list every survey with stats
//                                      (Admin/Supervisor/Regional Manager,
//                                      scoped to their province(s)).
// GET   ?id=...                    -> one survey's full definition
//                                      (questions, region targets) + stats.
// GET   ?for_agent=1               -> active surveys targeted at a region
//                                      touching the calling Agent's pool.
//                                      Add &store_id=... to narrow this down
//                                      to surveys eligible for that ONE
//                                      store specifically (used to offer
//                                      "any surveys to do here?" right after
//                                      a check-in).
// GET   ?id=...&eligible_stores=1  -> stores in the calling Agent's pool
//                                      that fall inside this survey's
//                                      target region(s) — Admin can pass
//                                      &staff_id=... to check on behalf of
//                                      any Agent (used by the on-the-go
//                                      "do a survey" flow).
// POST                              -> create a survey (Admin only).
//   body: { title, description?, questions: [{question_text, question_type,
//           options?, required?}], regions: [{scope_type:'province'|'region',
//           province?, region_id?}], status?: 'draft'|'active' }
// PATCH ?id=...                     -> edit a survey (Admin only).
//   body: { title?, description?, status?, questions?, regions? }
//   Questions/regions can only be wholesale-replaced while the survey has
//   ZERO responses on file — once Agents have answered it, the question set
//   is locked (protects response history from silently changing shape).
//   Status can always be changed (draft -> active -> archived).
//
// Self-test (no auth needed, no data touched):
//   /.netlify/functions/admin-surveys?selftest=1

const { json, sb, getCaller } = require("./_auth");

const QUESTION_TYPES = ["multiple_choice", "checklist", "rating", "yesno", "text", "photo"];
const CHOICE_TYPES = ["multiple_choice", "checklist"];

async function resolveScopeProvinces(scope) {
  const direct = scope.filter((s) => s.scope_type === "province").map((s) => s.province);
  const regionIds = scope.filter((s) => s.scope_type === "region").map((s) => s.region_id);
  if (!regionIds.length) return [...new Set(direct)];
  const res = await sb("/rest/v1/bi_regions?id=in.(" + regionIds.join(",") + ")&select=id,province");
  const rows = await res.json();
  const fromRegions = Array.isArray(rows) ? rows.map((r) => r.province) : [];
  return [...new Set([...direct, ...fromRegions])].filter(Boolean);
}

// A store matches a survey's target list if its province is directly
// targeted, OR its sub-region is directly targeted.
function storeMatchesTargets(store, provinces, regionIds) {
  if (store.province && provinces.includes(store.province)) return true;
  if (store.region_id && regionIds.includes(store.region_id)) return true;
  return false;
}

async function fetchRegionsFor(surveyIds) {
  if (!surveyIds.length) return {};
  const res = await sb("/rest/v1/clicka_survey_regions?survey_id=in.(" + surveyIds.join(",") + ")&select=*");
  const rows = await res.json();
  const bySurvey = {};
  (Array.isArray(rows) ? rows : []).forEach((r) => {
    (bySurvey[r.survey_id] = bySurvey[r.survey_id] || []).push(r);
  });
  return bySurvey;
}

// Enrich raw target rows with human-readable labels for the builder/list UI.
async function enrichTargets(targets) {
  const regionIds = [...new Set(targets.filter((t) => t.region_id).map((t) => t.region_id))];
  let regionsById = {};
  if (regionIds.length) {
    const res = await sb("/rest/v1/bi_regions?id=in.(" + regionIds.join(",") + ")&select=id,name,province");
    const rows = await res.json();
    regionsById = Object.fromEntries((Array.isArray(rows) ? rows : []).map((r) => [r.id, r]));
  }
  return targets.map((t) => ({
    ...t,
    label: t.scope_type === "province" ? t.province : (regionsById[t.region_id] ? regionsById[t.region_id].name + " (" + regionsById[t.region_id].province + ")" : "Unknown region"),
  }));
}

// The Agent's own "patch" — provinces of stores they've personally captured,
// union with provinces covered by any sub-region assigned to them. Same
// pool concept used for routing/take-up, expressed as a province list so it
// can be compared against a survey's target list.
async function resolveAgentProvinces(caller) {
  const scopeProvinces = await resolveScopeProvinces(caller.scope || []);
  const ownRes = await sb("/rest/v1/clicka_registrations?staff_id=eq." + caller.staff.id + "&select=province&limit=2000");
  const ownRows = await ownRes.json();
  const ownProvinces = (Array.isArray(ownRows) ? ownRows : []).map((r) => r.province).filter(Boolean);
  return [...new Set([...scopeProvinces, ...ownProvinces])];
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

  const qs = event.queryStringParameters || {};
  if (qs.selftest === "1") return json(200, { ok: true, world: "CLICKA-ADMIN" });

  const caller = await getCaller(event);
  if (!caller || !caller.staff) return json(401, { ok: false, error: "Not signed in." });
  if (caller.staff.status === "inactive") return json(403, { ok: false, error: "Account deactivated." });
  const role = caller.staff.role;

  // ---------- POST: create a survey ----------
  if (event.httpMethod === "POST") {
    if (role !== "admin") return json(403, { ok: false, error: "Only Admin can create surveys." });
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { ok: false, error: "Invalid JSON body." }); }

    if (!body.title || !String(body.title).trim()) return json(400, { ok: false, error: "A title is required." });
    const questions = Array.isArray(body.questions) ? body.questions : [];
    if (!questions.length) return json(400, { ok: false, error: "Add at least one question." });
    for (const q of questions) {
      if (!q.question_text || !String(q.question_text).trim()) return json(400, { ok: false, error: "Every question needs its text filled in." });
      if (!QUESTION_TYPES.includes(q.question_type)) return json(400, { ok: false, error: "Unknown question type: " + q.question_type });
      if (CHOICE_TYPES.includes(q.question_type) && (!Array.isArray(q.options) || q.options.filter(Boolean).length < 2)) {
        return json(400, { ok: false, error: "\"" + q.question_text + "\" needs at least two options." });
      }
    }
    const regions = Array.isArray(body.regions) ? body.regions : [];
    if (!regions.length) return json(400, { ok: false, error: "Target at least one province or sub-region." });
    for (const r of regions) {
      if (r.scope_type === "province" && !r.province) return json(400, { ok: false, error: "A province target is missing its province." });
      if (r.scope_type === "region" && !r.region_id) return json(400, { ok: false, error: "A sub-region target is missing its region." });
      if (!["province", "region"].includes(r.scope_type)) return json(400, { ok: false, error: "Unknown target scope: " + r.scope_type });
    }

    const status = body.status === "active" ? "active" : "draft";

    const surveyRes = await sb("/rest/v1/clicka_surveys", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify([{ title: String(body.title).trim(), description: body.description || null, status, created_by: caller.staff.id }]),
    });
    const surveyRows = await surveyRes.json();
    if (!surveyRes.ok || !Array.isArray(surveyRows) || !surveyRows.length) {
      return json(200, { ok: false, error: "Couldn't create the survey: " + JSON.stringify(surveyRows).slice(0, 300) });
    }
    const survey = surveyRows[0];

    await sb("/rest/v1/clicka_survey_questions", {
      method: "POST",
      body: JSON.stringify(questions.map((q, i) => ({
        survey_id: survey.id,
        sort_order: i,
        question_text: String(q.question_text).trim(),
        question_type: q.question_type,
        options: CHOICE_TYPES.includes(q.question_type) ? q.options.filter(Boolean) : null,
        required: q.required !== false,
      }))),
    });

    await sb("/rest/v1/clicka_survey_regions", {
      method: "POST",
      body: JSON.stringify(regions.map((r) => ({
        survey_id: survey.id,
        scope_type: r.scope_type,
        province: r.scope_type === "province" ? r.province : null,
        region_id: r.scope_type === "region" ? r.region_id : null,
      }))),
    });

    return json(200, { ok: true, survey_id: survey.id });
  }

  // ---------- PATCH: edit a survey ----------
  if (event.httpMethod === "PATCH") {
    if (role !== "admin") return json(403, { ok: false, error: "Only Admin can edit surveys." });
    if (!qs.id) return json(400, { ok: false, error: "id is required." });
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { ok: false, error: "Invalid JSON body." }); }

    const existingRes = await sb("/rest/v1/clicka_surveys?id=eq." + qs.id + "&select=id");
    const existingRows = await existingRes.json();
    if (!Array.isArray(existingRows) || !existingRows.length) return json(404, { ok: false, error: "Survey not found." });

    const patch = {};
    if (body.title != null) patch.title = String(body.title).trim();
    if (body.description !== undefined) patch.description = body.description || null;
    if (body.status) {
      if (!["draft", "active", "archived"].includes(body.status)) return json(400, { ok: false, error: "Unknown status." });
      patch.status = body.status;
    }
    if (Object.keys(patch).length) {
      await sb("/rest/v1/clicka_surveys?id=eq." + qs.id, { method: "PATCH", body: JSON.stringify(patch) });
    }

    if (body.regions) {
      await sb("/rest/v1/clicka_survey_regions?survey_id=eq." + qs.id, { method: "DELETE" });
      const regions = Array.isArray(body.regions) ? body.regions : [];
      if (regions.length) {
        await sb("/rest/v1/clicka_survey_regions", {
          method: "POST",
          body: JSON.stringify(regions.map((r) => ({
            survey_id: qs.id,
            scope_type: r.scope_type,
            province: r.scope_type === "province" ? r.province : null,
            region_id: r.scope_type === "region" ? r.region_id : null,
          }))),
        });
      }
    }

    if (body.questions) {
      const countRes = await sb("/rest/v1/clicka_survey_responses?survey_id=eq." + qs.id + "&select=id&limit=1");
      const countRows = await countRes.json();
      if (Array.isArray(countRows) && countRows.length) {
        return json(400, { ok: false, error: "This survey already has responses — its questions are locked. Archive it and create a new survey instead." });
      }
      const questions = Array.isArray(body.questions) ? body.questions : [];
      if (!questions.length) return json(400, { ok: false, error: "Add at least one question." });
      for (const q of questions) {
        if (!q.question_text || !String(q.question_text).trim()) return json(400, { ok: false, error: "Every question needs its text filled in." });
        if (!QUESTION_TYPES.includes(q.question_type)) return json(400, { ok: false, error: "Unknown question type: " + q.question_type });
        if (CHOICE_TYPES.includes(q.question_type) && (!Array.isArray(q.options) || q.options.filter(Boolean).length < 2)) {
          return json(400, { ok: false, error: "\"" + q.question_text + "\" needs at least two options." });
        }
      }
      await sb("/rest/v1/clicka_survey_questions?survey_id=eq." + qs.id, { method: "DELETE" });
      await sb("/rest/v1/clicka_survey_questions", {
        method: "POST",
        body: JSON.stringify(questions.map((q, i) => ({
          survey_id: qs.id,
          sort_order: i,
          question_text: String(q.question_text).trim(),
          question_type: q.question_type,
          options: CHOICE_TYPES.includes(q.question_type) ? q.options.filter(Boolean) : null,
          required: q.required !== false,
        }))),
      });
    }

    return json(200, { ok: true });
  }

  if (event.httpMethod !== "GET") return json(405, { ok: false, error: "Method not allowed." });

  // ---------- GET ?for_agent=1: surveys this Agent can see ----------
  if (qs.for_agent === "1") {
    if (role !== "agent") return json(403, { ok: false, error: "This is for Agent accounts only." });
    const myProvinces = await resolveAgentProvinces(caller);
    if (!myProvinces.length) return json(200, { ok: true, surveys: [], note: "No stores or sub-region assigned to you yet." });

    const res = await sb("/rest/v1/clicka_surveys?status=eq.active&select=id,title,description,created_at&order=created_at.desc");
    const surveys = await res.json();
    const list = Array.isArray(surveys) ? surveys : [];
    if (!list.length) return json(200, { ok: true, surveys: [] });

    const regionsBySurvey = await fetchRegionsFor(list.map((s) => s.id));
    const myRegionIds = new Set((caller.scope || []).filter((s) => s.scope_type === "region").map((s) => s.region_id));

    let matching = list.filter((s) => {
      const targets = regionsBySurvey[s.id] || [];
      return targets.some((t) =>
        (t.scope_type === "province" && myProvinces.includes(t.province)) ||
        (t.scope_type === "region" && myRegionIds.has(t.region_id))
      );
    });

    // Narrow further to ONE specific store — e.g. "any surveys to do here?"
    // right after a check-in.
    if (qs.store_id) {
      const storeRes = await sb("/rest/v1/clicka_registrations?id=eq." + qs.store_id + "&select=id,province,region_id");
      const storeRows = await storeRes.json();
      const store = Array.isArray(storeRows) ? storeRows[0] : null;
      matching = store
        ? matching.filter((s) => {
            const targets = regionsBySurvey[s.id] || [];
            const provinces = targets.filter((t) => t.scope_type === "province").map((t) => t.province);
            const regionIds = targets.filter((t) => t.scope_type === "region").map((t) => t.region_id);
            return storeMatchesTargets(store, provinces, regionIds);
          })
        : [];
    }

    return json(200, { ok: true, surveys: matching });
  }

  // ---------- GET ?id=...&eligible_stores=1 ----------
  if (qs.id && qs.eligible_stores === "1") {
    const targetStaffId = (role === "admin" && qs.staff_id) ? qs.staff_id : caller.staff.id;
    if (targetStaffId !== caller.staff.id && role !== "admin") {
      return json(403, { ok: false, error: "You can only check your own eligible stores." });
    }

    const regionsRes = await sb("/rest/v1/clicka_survey_regions?survey_id=eq." + qs.id + "&select=*");
    const targets = await regionsRes.json();
    const provinces = (Array.isArray(targets) ? targets : []).filter((t) => t.scope_type === "province").map((t) => t.province);
    const regionIds = (Array.isArray(targets) ? targets : []).filter((t) => t.scope_type === "region").map((t) => t.region_id);

    let agentRegionIds = [];
    if (targetStaffId === caller.staff.id) {
      agentRegionIds = (caller.scope || []).filter((s) => s.scope_type === "region").map((s) => s.region_id);
    } else {
      const scopeRes = await sb("/rest/v1/clicka_staff_scope?staff_id=eq." + targetStaffId + "&scope_type=eq.region&select=region_id");
      const scopeRows = await scopeRes.json();
      agentRegionIds = (Array.isArray(scopeRows) ? scopeRows : []).map((r) => r.region_id);
    }

    const poolAnd = agentRegionIds.length
      ? "or(staff_id.eq." + targetStaffId + ",region_id.in.(" + agentRegionIds.join(",") + "))"
      : "staff_id.eq." + targetStaffId;
    const poolRes = await sb(
      "/rest/v1/clicka_registrations?and=(" + poolAnd + ")&select=id,trading_name,outlet_address,province,region_id,status&limit=2000"
    );
    const poolRows = await poolRes.json();
    const pool = Array.isArray(poolRows) ? poolRows : [];

    const eligible = pool.filter((s) => storeMatchesTargets(s, provinces, regionIds));
    return json(200, { ok: true, stores: eligible });
  }

  // ---------- GET ?id=...: one survey's full definition + stats ----------
  if (qs.id) {
    if (!["admin", "supervisor", "regional_manager"].includes(role)) {
      return json(403, { ok: false, error: "Viewing survey setup is limited to Admin, Supervisor, and Regional Manager." });
    }
    const surveyRes = await sb("/rest/v1/clicka_surveys?id=eq." + qs.id + "&select=*");
    const surveyRows = await surveyRes.json();
    const survey = Array.isArray(surveyRows) ? surveyRows[0] : null;
    if (!survey) return json(404, { ok: false, error: "Survey not found." });

    const questionsRes = await sb("/rest/v1/clicka_survey_questions?survey_id=eq." + qs.id + "&select=*&order=sort_order.asc");
    const questions = await questionsRes.json();

    const regionsRes = await sb("/rest/v1/clicka_survey_regions?survey_id=eq." + qs.id + "&select=*");
    const rawTargets = await regionsRes.json();
    const targets = await enrichTargets(Array.isArray(rawTargets) ? rawTargets : []);

    const provinces = targets.filter((t) => t.scope_type === "province").map((t) => t.province);
    const regionIds = targets.filter((t) => t.scope_type === "region").map((t) => t.region_id);

    let allowedProvinces = null;
    if (role !== "admin") {
      allowedProvinces = await resolveScopeProvinces(caller.scope || []);
    }

    const storesRes = await sb("/rest/v1/clicka_registrations?select=id,province,region_id&limit=5000");
    const storeRows = await storesRes.json();
    let targetStores = (Array.isArray(storeRows) ? storeRows : []).filter((s) => storeMatchesTargets(s, provinces, regionIds));
    if (allowedProvinces) targetStores = targetStores.filter((s) => allowedProvinces.includes(s.province));
    const targetStoreIds = new Set(targetStores.map((s) => s.id));

    const responsesRes = await sb("/rest/v1/clicka_survey_responses?survey_id=eq." + qs.id + "&select=store_id,submitted_at");
    const responseRows = await responsesRes.json();
    const scopedResponses = (Array.isArray(responseRows) ? responseRows : []).filter((r) => targetStoreIds.has(r.store_id));
    const storesSurveyed = new Set(scopedResponses.map((r) => r.store_id));

    return json(200, {
      ok: true,
      survey: {
        ...survey,
        questions: Array.isArray(questions) ? questions : [],
        targets,
        assigned_count: targetStoreIds.size,
        stores_surveyed_count: storesSurveyed.size,
        total_submissions: scopedResponses.length,
        completion_pct: targetStoreIds.size ? Math.round((storesSurveyed.size / targetStoreIds.size) * 1000) / 10 : 0,
      },
    });
  }

  // ---------- GET (list): every survey + stats ----------
  if (!["admin", "supervisor", "regional_manager"].includes(role)) {
    return json(403, { ok: false, error: "Viewing surveys is limited to Admin, Supervisor, and Regional Manager." });
  }

  let allowedProvinces = null;
  if (role !== "admin") {
    allowedProvinces = await resolveScopeProvinces(caller.scope || []);
    if (!allowedProvinces.length) {
      return json(200, { ok: true, surveys: [], note: "No region assigned to this account yet." });
    }
  }

  const listRes = await sb("/rest/v1/clicka_surveys?select=*&order=created_at.desc");
  const listRows = await listRes.json();
  const surveys = Array.isArray(listRows) ? listRows : [];
  if (!surveys.length) return json(200, { ok: true, surveys: [] });

  const regionsBySurvey = await fetchRegionsFor(surveys.map((s) => s.id));
  const storesRes = await sb("/rest/v1/clicka_registrations?select=id,province,region_id&limit=5000");
  const storeRows = await storesRes.json();
  const allStores = Array.isArray(storeRows) ? storeRows : [];

  const responsesRes = await sb("/rest/v1/clicka_survey_responses?select=survey_id,store_id");
  const responseRows = await responsesRes.json();
  const responsesBySurvey = {};
  (Array.isArray(responseRows) ? responseRows : []).forEach((r) => {
    (responsesBySurvey[r.survey_id] = responsesBySurvey[r.survey_id] || []).push(r.store_id);
  });

  const enriched = [];
  for (const s of surveys) {
    const rawTargets = regionsBySurvey[s.id] || [];
    const targets = await enrichTargets(rawTargets);
    const provinces = targets.filter((t) => t.scope_type === "province").map((t) => t.province);
    const regionIds = targets.filter((t) => t.scope_type === "region").map((t) => t.region_id);

    let targetStores = allStores.filter((st) => storeMatchesTargets(st, provinces, regionIds));
    if (allowedProvinces) targetStores = targetStores.filter((st) => allowedProvinces.includes(st.province));
    if (allowedProvinces && !targetStores.length) continue; // outside this Supervisor/RM's patch entirely — skip, don't show a 0-row

    const targetStoreIds = new Set(targetStores.map((st) => st.id));
    const storeIdsSurveyed = (responsesBySurvey[s.id] || []).filter((id) => targetStoreIds.has(id));
    const storesSurveyed = new Set(storeIdsSurveyed);

    enriched.push({
      ...s,
      targets,
      assigned_count: targetStoreIds.size,
      stores_surveyed_count: storesSurveyed.size,
      total_submissions: storeIdsSurveyed.length,
      completion_pct: targetStoreIds.size ? Math.round((storesSurveyed.size / targetStoreIds.size) * 1000) / 10 : 0,
    });
  }

  return json(200, { ok: true, surveys: enriched });
};
