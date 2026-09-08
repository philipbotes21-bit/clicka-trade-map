// admin/netlify/functions/admin-survey-responses.js
//
// FUNCTION — Clicka: survey submissions.
// A response is one Agent, at one store, answering one survey, on one date.
// Surveys are repeatable — the same store can be surveyed again later, and
// every submission is kept (never overwritten), so Admin can look at a
// store's history for a survey and see what changed between visits.
//
// POST -> submit a response.
//   body: { survey_id, store_id, answers: [
//     { question_id, answer_value?, photo_base64?, photo_content_type? }
//   ] }
//   Agent: store must be in their pool AND inside the survey's target
//   province(s)/sub-region(s) (same eligibility admin-surveys.js's
//   eligible_stores computes). Admin can submit on behalf of any store
//   (support/testing, mirrors admin-visits.js).
//
// GET ?survey_id=...                    -> every response to a survey, with
//   store/agent names and flattened answers (one row per response) — the
//   feed the Excel export and results table are both built from. Optional
//   &from=YYYY-MM-DD&to=YYYY-MM-DD to narrow the date range.
// GET ?survey_id=...&store_id=...       -> one store's full response
//   history for this survey, oldest first, each with its full answer set —
//   the "what's changed" view.
//
// Self-test (no auth needed, no data touched):
//   /.netlify/functions/admin-survey-responses?selftest=1

const { SUPABASE_URL, json, sb, getCaller } = require("./_auth");

const BUCKET = "clicka-uploads";

async function resolveScopeProvinces(scope) {
  const direct = scope.filter((s) => s.scope_type === "province").map((s) => s.province);
  const regionIds = scope.filter((s) => s.scope_type === "region").map((s) => s.region_id);
  if (!regionIds.length) return [...new Set(direct)];
  const res = await sb("/rest/v1/bi_regions?id=in.(" + regionIds.join(",") + ")&select=id,province");
  const rows = await res.json();
  const fromRegions = Array.isArray(rows) ? rows.map((r) => r.province) : [];
  return [...new Set([...direct, ...fromRegions])].filter(Boolean);
}

function storeMatchesTargets(store, provinces, regionIds) {
  if (store.province && provinces.includes(store.province)) return true;
  if (store.region_id && regionIds.includes(store.region_id)) return true;
  return false;
}

async function signPhoto(path) {
  if (!path) return null;
  const res = await sb("/storage/v1/object/sign/" + BUCKET + "/" + path, {
    method: "POST",
    body: JSON.stringify({ expiresIn: 3600 }),
  });
  if (!res.ok) return null;
  const body = await res.json();
  if (!body.signedURL) return null;
  return SUPABASE_URL + "/storage/v1" + body.signedURL;
}

async function uploadPhoto(path, base64, contentType) {
  const bytes = Buffer.from(base64, "base64");
  const res = await sb("/storage/v1/object/" + BUCKET + "/" + path, {
    method: "POST",
    headers: { "Content-Type": contentType || "image/jpeg", "x-upsert": "true" },
    body: bytes,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error("Storage upload failed: " + res.status + " " + t.slice(0, 200));
  }
  return path;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

  const qs = event.queryStringParameters || {};
  if (qs.selftest === "1") return json(200, { ok: true, world: "CLICKA-ADMIN" });

  const caller = await getCaller(event);
  if (!caller || !caller.staff) return json(401, { ok: false, error: "Not signed in." });
  if (caller.staff.status === "inactive") return json(403, { ok: false, error: "Account deactivated." });
  const role = caller.staff.role;

  // ---------- POST: submit a response ----------
  if (event.httpMethod === "POST") {
    if (!["agent", "admin"].includes(role)) {
      return json(403, { ok: false, error: "Submitting a survey isn't available on this account." });
    }
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { ok: false, error: "Invalid JSON body." }); }

    const { survey_id, store_id } = body;
    if (!survey_id || !store_id) return json(400, { ok: false, error: "survey_id and store_id are required." });
    const answers = Array.isArray(body.answers) ? body.answers : [];

    const surveyRes = await sb("/rest/v1/clicka_surveys?id=eq." + survey_id + "&select=id,title,status");
    const surveyRows = await surveyRes.json();
    const survey = Array.isArray(surveyRows) ? surveyRows[0] : null;
    if (!survey) return json(404, { ok: false, error: "Survey not found." });
    if (survey.status !== "active") return json(400, { ok: false, error: "This survey isn't open for responses right now." });

    const storeRes = await sb("/rest/v1/clicka_registrations?id=eq." + store_id + "&select=id,trading_name,staff_id,region_id,province");
    const storeRows = await storeRes.json();
    const store = Array.isArray(storeRows) ? storeRows[0] : null;
    if (!store) return json(404, { ok: false, error: "Store not found." });

    if (role === "agent") {
      const agentRegionIds = (caller.scope || []).filter((s) => s.scope_type === "region").map((s) => s.region_id);
      const inPool = store.staff_id === caller.staff.id || (store.region_id && agentRegionIds.includes(store.region_id));
      if (!inPool) {
        return json(403, { ok: false, error: "This store isn't in your pool." });
      }
      const regionsRes = await sb("/rest/v1/clicka_survey_regions?survey_id=eq." + survey_id + "&select=*");
      const targets = await regionsRes.json();
      const provinces = (Array.isArray(targets) ? targets : []).filter((t) => t.scope_type === "province").map((t) => t.province);
      const regionIds = (Array.isArray(targets) ? targets : []).filter((t) => t.scope_type === "region").map((t) => t.region_id);
      if (!storeMatchesTargets(store, provinces, regionIds)) {
        return json(403, { ok: false, error: "\"" + survey.title + "\" isn't targeted at this store's area." });
      }
    }

    const questionsRes = await sb("/rest/v1/clicka_survey_questions?survey_id=eq." + survey_id + "&select=*");
    const questionRows = await questionsRes.json();
    const questions = Array.isArray(questionRows) ? questionRows : [];
    const answersByQ = Object.fromEntries(answers.map((a) => [a.question_id, a]));

    for (const q of questions) {
      if (!q.required) continue;
      const a = answersByQ[q.id];
      if (q.question_type === "photo") {
        if (!a || !a.photo_base64) return json(400, { ok: false, error: "\"" + q.question_text + "\" needs a photo." });
      } else {
        const v = a ? a.answer_value : null;
        const empty = v == null || v === "" || (Array.isArray(v) && !v.length);
        if (empty) return json(400, { ok: false, error: "\"" + q.question_text + "\" is required." });
      }
    }

    const responseRes = await sb("/rest/v1/clicka_survey_responses", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify([{ survey_id, store_id, staff_id: caller.staff.id }]),
    });
    const responseRows = await responseRes.json();
    if (!responseRes.ok || !Array.isArray(responseRows) || !responseRows.length) {
      return json(200, { ok: false, error: "Couldn't save the response: " + JSON.stringify(responseRows).slice(0, 300) });
    }
    const response = responseRows[0];

    const answerRows = [];
    for (const q of questions) {
      const a = answersByQ[q.id];
      if (!a) continue;
      if (q.question_type === "photo" && a.photo_base64) {
        const ext = (a.photo_content_type && a.photo_content_type.includes("png")) ? "png" : "jpg";
        const path = "surveys/" + survey_id + "/" + store_id + "/" + response.id + "/" + q.id + "." + ext;
        try {
          await uploadPhoto(path, a.photo_base64, a.photo_content_type);
        } catch (e) {
          continue; // don't fail the whole submission over one photo upload hiccup
        }
        answerRows.push({ response_id: response.id, question_id: q.id, answer_value: null, answer_photo_url: path });
      } else if (a.answer_value != null && a.answer_value !== "") {
        answerRows.push({ response_id: response.id, question_id: q.id, answer_value: a.answer_value, answer_photo_url: null });
      }
    }
    if (answerRows.length) {
      await sb("/rest/v1/clicka_survey_answers", { method: "POST", body: JSON.stringify(answerRows) });
    }

    return json(200, { ok: true, response_id: response.id });
  }

  if (event.httpMethod !== "GET") return json(405, { ok: false, error: "Method not allowed." });
  if (!["admin", "supervisor", "regional_manager"].includes(role)) {
    return json(403, { ok: false, error: "Viewing survey responses is limited to Admin, Supervisor, and Regional Manager." });
  }
  if (!qs.survey_id) return json(400, { ok: false, error: "survey_id is required." });

  let allowedProvinces = null;
  if (role !== "admin") {
    allowedProvinces = await resolveScopeProvinces(caller.scope || []);
    if (!allowedProvinces.length) return json(200, { ok: true, responses: [] });
  }

  const questionsRes = await sb("/rest/v1/clicka_survey_questions?survey_id=eq." + qs.survey_id + "&select=*&order=sort_order.asc");
  const questions = await questionsRes.json();
  const questionList = Array.isArray(questions) ? questions : [];

  // ---------- GET ?survey_id=&store_id=: one store's history ----------
  if (qs.store_id) {
    const responsesRes = await sb(
      "/rest/v1/clicka_survey_responses?survey_id=eq." + qs.survey_id + "&store_id=eq." + qs.store_id +
      "&select=*,clicka_staff(first_name,last_name)&order=submitted_at.asc"
    );
    const responseRows = await responsesRes.json();
    const responses = Array.isArray(responseRows) ? responseRows : [];
    if (!responses.length) return json(200, { ok: true, questions: questionList, responses: [] });

    const responseIds = responses.map((r) => r.id);
    const answersRes = await sb("/rest/v1/clicka_survey_answers?response_id=in.(" + responseIds.join(",") + ")&select=*");
    const answerRows = await answersRes.json();
    const answersByResponse = {};
    for (const a of Array.isArray(answerRows) ? answerRows : []) {
      (answersByResponse[a.response_id] = answersByResponse[a.response_id] || {})[a.question_id] = {
        answer_value: a.answer_value,
        photo_signed_url: a.answer_photo_url ? await signPhoto(a.answer_photo_url) : null,
      };
    }

    const enriched = responses.map((r) => ({
      id: r.id,
      submitted_at: r.submitted_at,
      agent_name: r.clicka_staff ? (r.clicka_staff.first_name + " " + r.clicka_staff.last_name) : "—",
      answers: answersByResponse[r.id] || {},
    }));

    return json(200, { ok: true, questions: questionList, responses: enriched });
  }

  // ---------- GET ?survey_id=: every response, flattened ----------
  const from = qs.from ? qs.from + "T00:00:00" : null;
  const to = qs.to ? qs.to + "T23:59:59" : null;
  let url = "/rest/v1/clicka_survey_responses?survey_id=eq." + qs.survey_id +
    "&select=*,clicka_staff(first_name,last_name),clicka_registrations(trading_name,province,region_id)&order=submitted_at.desc&limit=5000";
  if (from) url += "&submitted_at=gte." + from;
  if (to) url += "&submitted_at=lte." + to;

  const responsesRes = await sb(url);
  const responseRows = await responsesRes.json();
  let responses = Array.isArray(responseRows) ? responseRows : [];
  if (allowedProvinces) {
    responses = responses.filter((r) => r.clicka_registrations && allowedProvinces.includes(r.clicka_registrations.province));
  }
  if (!responses.length) return json(200, { ok: true, questions: questionList, responses: [] });

  const responseIds = responses.map((r) => r.id);
  const answersRes = await sb("/rest/v1/clicka_survey_answers?response_id=in.(" + responseIds.join(",") + ")&select=*");
  const answerRows = await answersRes.json();
  const answersByResponse = {};
  for (const a of Array.isArray(answerRows) ? answerRows : []) {
    (answersByResponse[a.response_id] = answersByResponse[a.response_id] || {})[a.question_id] =
      a.answer_photo_url ? { photo_url: a.answer_photo_url } : { answer_value: a.answer_value };
  }

  const enriched = responses.map((r) => ({
    id: r.id,
    store_id: r.store_id,
    submitted_at: r.submitted_at,
    store_name: r.clicka_registrations ? r.clicka_registrations.trading_name : "—",
    province: r.clicka_registrations ? r.clicka_registrations.province : null,
    agent_name: r.clicka_staff ? (r.clicka_staff.first_name + " " + r.clicka_staff.last_name) : "—",
    answers: answersByResponse[r.id] || {},
  }));

  return json(200, { ok: true, questions: questionList, responses: enriched });
};
