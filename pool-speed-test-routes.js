// RAZAFI Speed Test multi-pool V1 — independent backend router, 2026-10-09.
// Only additive, feature-flagged routes. Uses service_role Supabase client.
// No pricing, RADIUS, RouterOS configuration, or live Hotspot state is changed.

const FEATURE_UI = ["1", "true", "yes", "on"].includes(String(process.env.POOL_SPEED_TEST_UI_ENABLED || "false").toLowerCase());
const FEATURE_ACTIVE = ["1", "true", "yes", "on"].includes(String(process.env.POOL_SPEED_TEST_ACTIVE_ENABLED || "false").toLowerCase());
const AGENT_ROOT = String(process.env.SPEED_TEST_AGENT_URL || "").trim();
const AGENT_SECRET = String(process.env.SPEED_TEST_AGENT_SECRET || "").trim();
const AGENT_MAX_MS = 45000;
const RUN_TIMEOUT_MS = 150000;
const EXPECTED_BYTES = 8 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function agentConfigured() {
  if (!AGENT_ROOT || !AGENT_SECRET) return false;
  try {
    const u = new URL(AGENT_ROOT);
    if (u.username || u.password || u.search || u.hash) return false;
    // HTTPS preferred. Plain HTTP allowed only for configured private IPs over VPN.
    if (u.protocol === "https:") return true;
    if (u.protocol !== "http:") return false;
    const h = u.hostname;
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) return false;
    const oct = h.split(".").map(Number);
    if (oct.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return false;
    return oct[0] === 10 || (oct[0] === 172 && oct[1] >= 16 && oct[1] <= 31) ||
      (oct[0] === 192 && oct[1] === 168);
  } catch (_) { return false; }
}

const agentReady = agentConfigured();
const isFreshActive = (r) => r && ["queued", "running"].includes(r.status) &&
  Number.isFinite(Date.parse(r.created_at)) && Date.now() - Date.parse(r.created_at) < RUN_TIMEOUT_MS;
const errResult = (res, e, code = "speed_test_unavailable") => {
  console.error("[POOL SPEED TEST]", String(e?.code || e?.message || code).slice(0, 100));
  return res.status(503).json({ ok: false, error: code });
};
function safeMeasurement(r) {
  if (!r || r.status !== "completed") return null;
  return {
    id: r.id, download_mbps: r.download_mbps === null ? null : Number(r.download_mbps),
    upload_mbps: r.upload_mbps === null ? null : Number(r.upload_mbps),
    latency_ms: r.latency_ms === null ? null : Number(r.latency_ms),
    completed_at: r.completed_at, created_at: r.created_at,
    quality: r.quality || "indicative", method: r.method || "routeros_https_fetch",
    cpu_peak_pct: r.cpu_peak_pct === null ? null : Number(r.cpu_peak_pct),
  };
}
function validatePoolId(req, res) {
  const raw = req.method === "POST" ? req.body?.pool_id : req.query?.pool_id;
  if (typeof raw !== "string" || !UUID_RE.test(raw)) {
    res.status(400).json({ ok: false, error: "pool_id_invalid" });
    return null;
  }
  return raw;
}
function withJsonHeaders(res) {
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

export function registerPoolSpeedTestRoutes({ app, requireAdmin, supabase, canAdminAccessPool, buildPoolDisplayName }) {
  if (!app || typeof requireAdmin !== "function") throw new Error("pool_speed_test_missing_dependencies");

  async function selectPool(req, res, poolId) {
    if (!canAdminAccessPool(req.admin, poolId)) {
      res.status(403).json({ ok: false, error: "forbidden_pool" }); return null;
    }
    const { data: pool, error } = await supabase.from("internet_pools")
      .select("id,name,brand_name,radius_nas_id,system")
      .eq("id", poolId).eq("system", "mikrotik").maybeSingle();
    if (error) throw error;
    if (!pool || !pool.radius_nas_id) {
      res.status(404).json({ ok: false, error: "pool_not_found" }); return null;
    }
    return pool;
  }

  async function fetchLast(poolId) {
    const { data, error } = await supabase.from("pool_speed_test_runs")
      .select("id,created_at,completed_at,download_mbps,upload_mbps,latency_ms,quality,method,cpu_peak_pct,status")
      .eq("pool_id", poolId).eq("status", "completed")
      .order("completed_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    return safeMeasurement(data);
  }

  async function fetchSetting(poolId) {
    const { data, error } = await supabase.from("pool_speed_test_settings")
      .select("active_enabled,cooldown_until").eq("pool_id", poolId).maybeSingle();
    if (error) throw error;
    return data || { active_enabled: false, cooldown_until: null };
  }

  async function currentActive() {
    const { data, error } = await supabase.from("pool_speed_test_runs")
      .select("id,pool_id,status,created_at")
      .in("status", ["queued", "running"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    return isFreshActive(data) ? data : null;
  }

  function getViewEnabled(req) {
    return FEATURE_UI && (req.admin?.is_superadmin === true ||
      (Array.isArray(req.admin?.pool_ids) && req.admin.pool_ids.length > 0));
  }

  // Read: all MikroTik pools visible to this exact session; never expose router credentials.
  app.get("/api/admin/pool-speed-test", requireAdmin, async (req, res) => {
    withJsonHeaders(res);
    if (!getViewEnabled(req)) return res.status(404).json({ ok: false, error: "not_found" });
    if (!supabase) return res.status(503).json({ ok: false, error: "service_unavailable" });
    try {
      const poolId = req.query?.pool_id;
      if (poolId !== undefined) {
        const pid = validatePoolId(req, res);
        if (!pid) return;
        const pool = await selectPool(req, res, pid);
        if (!pool) return;
        const [{ data: router, error: rErr }, setting, latest, active] = await Promise.all([
          supabase.from("mikrotik_routers").select("wan_interface,api_enabled")
            .eq("nas_id", pool.radius_nas_id).maybeSingle(),
          fetchSetting(pid), fetchLast(pid), currentActive(),
        ]);
        if (rErr) throw rErr;
        const isOwnRunning = active?.pool_id === pid;
        const until = setting.cooldown_until;
        const cooldown = Boolean(until && Date.parse(until) > Date.now());
        const mayStart = FEATURE_ACTIVE && agentReady && setting.active_enabled === true &&
          !active && !cooldown && router?.api_enabled === true && Boolean(router?.wan_interface);
        return res.json({
          ok: true, feature_enabled: true,
          pool: { id: pool.id, display_name: buildPoolDisplayName(pool) || pool.name,
            radius_nas_id: pool.radius_nas_id, wan_interface: router?.wan_interface || null },
          state: { can_start: mayStart, is_running: isOwnRunning,
            status: isOwnRunning ? active.status : "idle", cooldown_until: until || null },
          measurement: latest,
        });
      }

      let q = supabase.from("internet_pools")
        .select("id,name,brand_name,radius_nas_id,system")
        .eq("system", "mikrotik").not("radius_nas_id", "is", null)
        .order("name", { ascending: true }).limit(500);
      if (!req.admin?.is_superadmin) {
        const allowed = Array.isArray(req.admin?.pool_ids) ?
          req.admin.pool_ids.filter(id => UUID_RE.test(String(id))) : [];
        if (!allowed.length) return res.json({ ok: true, feature_enabled: true, pools: [] });
        q = q.in("id", allowed);
      }
      const { data: pools, error } = await q;
      if (error) throw error;
      const safePools = (pools || []).filter(p => canAdminAccessPool(req.admin, p.id));
      const ids = safePools.map(p => p.id);
      let completed = [];
      if (ids.length) {
        const result = await supabase.from("pool_speed_test_runs")
          .select("pool_id,created_at,completed_at,download_mbps,status")
          .in("pool_id", ids).eq("status", "completed")
          .order("completed_at", { ascending: false }).limit(500);
        if (result.error) throw result.error;
        completed = result.data || [];
      }
      const byPool = new Map();
      for (const r of completed) if (!byPool.has(r.pool_id)) byPool.set(r.pool_id, r);
      return res.json({ ok: true, feature_enabled: true, pools: safePools.map(p => ({
        pool_id: p.id, display_name: buildPoolDisplayName(p) || p.name,
        radius_nas_id: p.radius_nas_id,
        last_test: byPool.has(p.id) ? { download_mbps: Number(byPool.get(p.id).download_mbps),
          completed_at: byPool.get(p.id).completed_at } : null,
      })) });
    } catch (e) { return errResult(res, e); }
  });

  app.get("/api/admin/pool-speed-test/history", requireAdmin, async (req, res) => {
    withJsonHeaders(res);
    if (!getViewEnabled(req)) return res.status(404).json({ ok: false, error: "not_found" });
    const pid = validatePoolId(req, res);
    if (!pid) return;
    try {
      const pool = await selectPool(req, res, pid);
      if (!pool) return;
      const { data, error } = await supabase.from("pool_speed_test_runs")
        .select("id,created_at,completed_at,download_mbps,upload_mbps,latency_ms,quality,method,cpu_peak_pct,status")
        .eq("pool_id", pid).eq("status", "completed")
        .order("completed_at", { ascending: false }).limit(30);
      if (error) throw error;
      return res.json({ ok: true, items: (data || []).map(safeMeasurement).filter(Boolean) });
    } catch (e) { return errResult(res, e); }
  });

  async function executeRun(runId, poolId) {
    // Persisted reservation exists before any work. No automatic job retries.
    try {
      const { data: claimed, error: startErr } = await supabase.from("pool_speed_test_runs")
        .update({ status: "running", started_at: new Date().toISOString() })
        .eq("id", runId).eq("status", "queued").select("id").maybeSingle();
      if (startErr || !claimed) throw new Error("worker_claim_failed");
      const { data: pool, error: pErr } = await supabase.from("internet_pools")
        .select("id,radius_nas_id,system").eq("id", poolId).maybeSingle();
      if (pErr || !pool || pool.system !== "mikrotik" || !pool.radius_nas_id) {
        throw new Error("pool_config_unavailable");
      }
      const { data: router, error: rErr } = await supabase.from("mikrotik_routers")
        .select("api_host,api_port,api_user,api_password,api_enabled,wan_interface")
        .eq("nas_id", pool.radius_nas_id).maybeSingle();
      if (rErr || !router || router.api_enabled !== true || !router.api_host ||
          !router.api_user || !router.api_password || !router.wan_interface) {
        throw new Error("router_config_unavailable");
      }
      if (!FEATURE_ACTIVE || !agentReady) throw new Error("test_disabled");
      const agentUrl = new URL("/pool-speed-test/run", AGENT_ROOT).toString();
      const response = await fetch(agentUrl, {
        method: "POST", signal: AbortSignal.timeout(AGENT_MAX_MS),
        headers: { "Content-Type": "application/json", "x-secret": AGENT_SECRET },
        body: JSON.stringify({ nas_id: pool.radius_nas_id, router_ip: router.api_host,
          router_port: router.api_port || 8728, api_user: router.api_user,
          api_password: router.api_password, wan_interface: router.wan_interface }),
      });
      const data = await response.json().catch(() => ({}));
      const mbps = Number(data.download_mbps);
      const elapsed = Number(data.duration_ms);
      if (!response.ok || data.ok !== true || data.test_performed !== true ||
          data.status !== "finished" || data.nas_id !== pool.radius_nas_id ||
          data.wan_interface !== router.wan_interface ||
          data.method !== "routeros_https_fetch" || data.quality !== "indicative" ||
          Number(data.downloaded_bytes) !== EXPECTED_BYTES ||
          !Number.isFinite(mbps) || mbps <= 0 || mbps > 1000 ||
          !Number.isInteger(elapsed) || elapsed <= 0 || elapsed > 27000) {
        throw new Error("agent_result_invalid_or_failed");
      }
      const cpuBefore = data.cpu_before_pct === null || data.cpu_before_pct === undefined ? null : Number(data.cpu_before_pct);
      const { error: completeErr } = await supabase.from("pool_speed_test_runs")
        .update({ status: "completed", completed_at: new Date().toISOString(),
          download_mbps: mbps, upload_mbps: null, latency_ms: null,
          method: "routeros_https_fetch", quality: "indicative",
          downloaded_bytes: EXPECTED_BYTES, duration_ms: elapsed,
          cpu_before_pct: Number.isFinite(cpuBefore) && cpuBefore >= 0 && cpuBefore <= 100 ? cpuBefore : null,
          cpu_peak_pct: null, error_code: null })
        .eq("id", runId).eq("status", "running");
      if (completeErr) throw new Error("result_persistence_failed");
    } catch (e) {
      console.warn("[POOL SPEED TEST RUN FAILED]", String(e?.message || "error").slice(0, 100));
      // Do not leak agent internals to owner/manager/viewer.
      const { error } = await supabase.from("pool_speed_test_runs")
        .update({ status: "failed", completed_at: new Date().toISOString(),
          error_code: "test_unavailable" })
        .eq("id", runId).in("status", ["queued", "running"]);
      if (error) console.error("[POOL SPEED TEST PERSIST FAILURE]", String(error.code || "db_error"));
    }
  }

  // Triggering traffic is an explicit scoped POST exception in requireAdmin.
  app.post("/api/admin/pool-speed-test/start", requireAdmin, async (req, res) => {
    withJsonHeaders(res);
    if (!getViewEnabled(req)) return res.status(403).json({ ok: false, error: "forbidden" });
    if (!FEATURE_ACTIVE || !agentReady) return res.status(503).json({ ok: false, error: "test_disabled" });
    if (!req.body || typeof req.body !== "object" ||
        Object.keys(req.body).some(k => k !== "pool_id")) {
      return res.status(400).json({ ok: false, error: "invalid_request" });
    }
    const pid = validatePoolId(req, res);
    if (!pid) return;
    try {
      const pool = await selectPool(req, res, pid);
      if (!pool) return;
      const { data: router, error: rErr } = await supabase.from("mikrotik_routers")
        .select("wan_interface,api_enabled")
        .eq("nas_id", pool.radius_nas_id).maybeSingle();
      if (rErr) throw rErr;
      if (!router?.wan_interface || router.api_enabled !== true) {
        return res.status(503).json({ ok: false, error: "router_not_ready" });
      }
      const actorId = String(req.admin?.actor_id || req.admin?.id || "").trim();
      if (!actorId || actorId.length > 160) return res.status(403).json({ ok: false, error: "identity_unavailable" });
      const { data, error } = await supabase.rpc("reserve_pool_speed_test", {
        p_pool_id: pid, p_requested_by: actorId,
      });
      if (error) throw error;
      if (data?.accepted !== true) {
        const code = String(data?.reason || "test_rejected");
        const status = code === "pool_not_enabled" ? 403 : code === "invalid_request" ? 400 : 409;
        return res.status(status).json({ ok: false, error: code });
      }
      const runId = String(data.run_id || "");
      if (!UUID_RE.test(runId)) throw new Error("reservation_missing_run_id");
      res.status(202).json({ ok: true, accepted: true, test_id: runId, status: "queued" });
      // Run only after 202; job survives in DB if Render restarts and will be
      // closed as failed after timeout. Never replay automatically.
      setImmediate(() => { void executeRun(runId, pid); });
    } catch (e) { if (!res.headersSent) return errResult(res, e); }
  });
}
