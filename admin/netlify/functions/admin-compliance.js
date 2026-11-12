// admin/netlify/functions/admin-compliance.js
//
// FUNCTION — "Compliance": Clicka's security policy pack, the FNB / 3PIM
// Trusted Partner control scorecard (30 questions, 11 domains, pass mark 3.5
// per domain), the roadmap tasks, and an append-only audit trail of every
// change. Admin only.
//
// GET  (no params)               -> overview: domain scorecard (now / target /
//                                    pass mark), task progress, policy status
// GET  ?view=controls            -> the 30 FNB questions with maturity + status
// GET  ?view=tasks               -> roadmap tasks (&category= Platform|Document|Tool|Recurring|Setup)
// GET  ?view=policies            -> policy list (no body)
// GET  ?view=policy&code=ISMS    -> one policy with its full text
// GET  ?view=audit               -> latest audit entries (&limit=)
// PATCH { entity:"control", q_no, maturity?, status?, note? }
//       { entity:"task",    code, status?, note? }
//       { entity:"policy",  code, status?  ("draft"|"in_review"|"approved") }
//         approving stamps approver + date and sets the next review 12 months out
//
// First read seeds any empty table from _compliance_seed.json, so the tab is
// never blank. Tables are service-role only (RLS on, no policies).
//
// Self-test: /.netlify/functions/admin-compliance?selftest=1

const { json, sb, getCaller } = require("./_auth");
const seed = require("./_compliance_seed.json");
const BUILD = "compliance-2026-11-12a";
const PASS_MARK = 3.5;

const MATURITY_LABEL = ["Non-existent", "Initial", "Repeatable", "Defined", "Managed", "Optimised"];
const STATUS = ["todo", "in_progress", "done"];
const POLICY_STATUS = ["draft", "in_review", "approved"];

async function rows(path) {
  const res = await sb(path);
  const body = await res.json().catch(() => null);
  return Array.isArray(body) ? body : [];
}

async function tableEmpty(table) {
  const r = await rows("/rest/v1/" + table + "?select=id&limit=1");
  return r.length === 0;
}

async function ensureSeed() {
  const jobs = [
    ["compliance_controls", seed.controls],
    ["compliance_tasks", seed.tasks],
    ["compliance_policies", seed.policies],
  ];
  for (const [table, data] of jobs) {
    if (await tableEmpty(table)) {
      await sb("/rest/v1/" + table, { method: "POST", body: JSON.stringify(data) });
    }
  }
}

function actorName(caller) {
  const s = caller.staff || {};
  const n = [s.first_name, s.last_name].filter(Boolean).join(" ").trim();
  return n || s.email || String(s.id);
}

async function audit(actor, entity, entityId, field, oldV, newV) {
  await sb("/rest/v1/compliance_audit", {
    method: "POST",
    body: JSON.stringify([{ actor, entity, entity_id: String(entityId), field, old_value: oldV == null ? null : String(oldV), new_value: newV == null ? null : String(newV) }]),
  });
}

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const round2 = (n) => Math.round(n * 100) / 100;

function buildScorecard(controls) {
  const order = [];
  const by = {};
  for (const c of controls) {
    if (!by[c.domain]) { by[c.domain] = []; order.push(c.domain); }
    by[c.domain].push(c);
  }
  const domains = order.map((d) => {
    const list = by[d];
    const now = avg(list.map((c) => c.maturity));
    const target = avg(list.map((c) => c.target));
    return {
      domain: d,
      questions: list.length,
      done: list.filter((c) => c.status === "done").length,
      now: round2(now),
      target: round2(target),
      required: PASS_MARK,
      pass_now: now >= PASS_MARK,
      pass_target: target >= PASS_MARK,
    };
  });
  const nowAll = avg(domains.map((d) => d.now));
  const tgtAll = avg(domains.map((d) => d.target));
  return {
    domains,
    overall: {
      now: round2(nowAll),
      target: round2(tgtAll),
      required: PASS_MARK,
      domains_passing: domains.filter((d) => d.pass_now).length,
      domains_total: domains.length,
    },
  };
}

function progress(list) {
  const out = { total: list.length, todo: 0, in_progress: 0, done: 0 };
  for (const t of list) out[t.status] = (out[t.status] || 0) + 1;
  out.percent = out.total ? Math.round((out.done / out.total) * 100) : 0;
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });
  const qs = event.queryStringParameters || {};
  if (qs.selftest === "1") return json(200, { ok: true, world: "CLICKA-ADMIN-COMPLIANCE", build: BUILD, seed: { controls: seed.controls.length, tasks: seed.tasks.length, policies: seed.policies.length } });

  const caller = await getCaller(event);
  if (!caller || !caller.staff) return json(401, { ok: false, error: "Not signed in." });
  if (caller.staff.status === "inactive") return json(403, { ok: false, error: "Account deactivated." });
  if (caller.staff.role !== "admin") return json(403, { ok: false, error: "Compliance is Admin only." });

  try {
    await ensureSeed();
  } catch (e) {
    return json(200, { ok: false, error: "Could not prepare compliance data: " + String(e.message || e).slice(0, 200) });
  }

  // ---------- PATCH ----------
  if (event.httpMethod === "PATCH") {
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { ok: false, error: "Invalid JSON body." }); }
    const actor = actorName(caller);
    const now = new Date().toISOString();

    if (body.entity === "control") {
      const q = Number(body.q_no);
      if (!Number.isInteger(q)) return json(400, { ok: false, error: "q_no is required." });
      const cur = (await rows("/rest/v1/compliance_controls?q_no=eq." + q + "&select=*"))[0];
      if (!cur) return json(404, { ok: false, error: "Control not found." });
      const patch = {};
      if (body.maturity !== undefined) {
        const m = Number(body.maturity);
        if (!Number.isInteger(m) || m < 0 || m > 5) return json(400, { ok: false, error: "Maturity must be 0 to 5." });
        patch.maturity = m;
      }
      if (body.status !== undefined) {
        if (!STATUS.includes(body.status)) return json(400, { ok: false, error: "Invalid status." });
        patch.status = body.status;
      }
      if (body.note !== undefined) patch.note = body.note ? String(body.note).slice(0, 500) : null;
      if (!Object.keys(patch).length) return json(400, { ok: false, error: "Nothing to change." });
      patch.updated_at = now; patch.updated_by = actor;
      const res = await sb("/rest/v1/compliance_controls?q_no=eq." + q, { method: "PATCH", body: JSON.stringify(patch) });
      if (!res.ok) return json(200, { ok: false, error: (await res.text()).slice(0, 300) });
      for (const f of ["maturity", "status", "note"]) {
        if (patch[f] !== undefined && String(patch[f]) !== String(cur[f])) await audit(actor, "control", "Q" + q, f, cur[f], patch[f]);
      }
      return json(200, { ok: true });
    }

    if (body.entity === "task") {
      if (!body.code) return json(400, { ok: false, error: "code is required." });
      const cur = (await rows("/rest/v1/compliance_tasks?code=eq." + encodeURIComponent(body.code) + "&select=*"))[0];
      if (!cur) return json(404, { ok: false, error: "Task not found." });
      const patch = {};
      if (body.status !== undefined) {
        if (!STATUS.includes(body.status)) return json(400, { ok: false, error: "Invalid status." });
        patch.status = body.status;
      }
      if (body.note !== undefined) patch.note = body.note ? String(body.note).slice(0, 500) : null;
      if (!Object.keys(patch).length) return json(400, { ok: false, error: "Nothing to change." });
      patch.updated_at = now; patch.updated_by = actor;
      const res = await sb("/rest/v1/compliance_tasks?code=eq." + encodeURIComponent(body.code), { method: "PATCH", body: JSON.stringify(patch) });
      if (!res.ok) return json(200, { ok: false, error: (await res.text()).slice(0, 300) });
      for (const f of ["status", "note"]) {
        if (patch[f] !== undefined && String(patch[f]) !== String(cur[f])) await audit(actor, "task", body.code, f, cur[f], patch[f]);
      }
      return json(200, { ok: true });
    }

    if (body.entity === "policy") {
      if (!body.code || !POLICY_STATUS.includes(body.status)) return json(400, { ok: false, error: "code and a valid status are required." });
      const cur = (await rows("/rest/v1/compliance_policies?code=eq." + encodeURIComponent(body.code) + "&select=code,status,version"))[0];
      if (!cur) return json(404, { ok: false, error: "Policy not found." });
      const patch = { status: body.status, updated_at: now, updated_by: actor };
      if (body.status === "approved") {
        const next = new Date(); next.setFullYear(next.getFullYear() + 1);
        patch.approved_by = actor; patch.approved_at = now; patch.next_review = next.toISOString().slice(0, 10);
      } else {
        patch.approved_by = null; patch.approved_at = null; patch.next_review = null;
      }
      const res = await sb("/rest/v1/compliance_policies?code=eq." + encodeURIComponent(body.code), { method: "PATCH", body: JSON.stringify(patch) });
      if (!res.ok) return json(200, { ok: false, error: (await res.text()).slice(0, 300) });
      if (cur.status !== body.status) await audit(actor, "policy", body.code, "status", cur.status, body.status);
      return json(200, { ok: true });
    }

    return json(400, { ok: false, error: "Unknown entity." });
  }

  if (event.httpMethod !== "GET") return json(405, { ok: false, error: "Method not allowed." });

  // ---------- GET views ----------
  if (qs.view === "controls") {
    const list = await rows("/rest/v1/compliance_controls?select=*&order=q_no.asc");
    return json(200, { ok: true, maturity_labels: MATURITY_LABEL, controls: list });
  }
  if (qs.view === "tasks") {
    let path = "/rest/v1/compliance_tasks?select=*&order=sort.asc";
    if (qs.category) path += "&category=eq." + encodeURIComponent(qs.category);
    return json(200, { ok: true, tasks: await rows(path) });
  }
  if (qs.view === "policies") {
    const list = await rows("/rest/v1/compliance_policies?select=id,code,title,version,status,owner,summary,approved_by,approved_at,next_review,updated_at&order=id.asc");
    return json(200, { ok: true, policies: list });
  }
  if (qs.view === "policy") {
    if (!qs.code) return json(400, { ok: false, error: "code is required." });
    const p = (await rows("/rest/v1/compliance_policies?code=eq." + encodeURIComponent(qs.code) + "&select=*"))[0];
    if (!p) return json(404, { ok: false, error: "Policy not found." });
    return json(200, { ok: true, policy: p });
  }
  if (qs.view === "audit") {
    const limit = Math.min(Math.max(parseInt(qs.limit, 10) || 100, 1), 500);
    return json(200, { ok: true, audit: await rows("/rest/v1/compliance_audit?select=*&order=id.desc&limit=" + limit) });
  }

  // ---------- GET overview ----------
  const [controls, tasks, policies, recent] = await Promise.all([
    rows("/rest/v1/compliance_controls?select=domain,q_no,maturity,target,status&order=q_no.asc"),
    rows("/rest/v1/compliance_tasks?select=code,category,status&order=sort.asc"),
    rows("/rest/v1/compliance_policies?select=code,title,version,status,approved_by,approved_at,next_review&order=id.asc"),
    rows("/rest/v1/compliance_audit?select=*&order=id.desc&limit=8"),
  ]);
  const cats = {};
  for (const t of tasks) (cats[t.category] = cats[t.category] || []).push(t);
  const byCategory = {};
  Object.keys(cats).forEach((c) => (byCategory[c] = progress(cats[c])));
  const overdue = policies.filter((p) => p.status === "approved" && p.next_review && new Date(p.next_review) < new Date()).map((p) => p.code);
  return json(200, {
    ok: true,
    build: BUILD,
    pass_mark: PASS_MARK,
    scorecard: buildScorecard(controls),
    controls_progress: progress(controls),
    tasks_progress: progress(tasks),
    tasks_by_category: byCategory,
    policies,
    policies_approved: policies.filter((p) => p.status === "approved").length,
    policies_overdue_review: overdue,
    recent,
  });
};
