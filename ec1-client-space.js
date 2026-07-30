import crypto from "crypto";
import net from "net";
import axios from "axios";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a ?? ""));
  const bb = Buffer.from(String(b ?? ""));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function envFlag(name, fallback = false) {
  const raw = String(process.env[name] ?? (fallback ? "true" : "false")).trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

function envInt(name, fallback, min, max) {
  const parsed = Number.parseInt(String(process.env[name] ?? fallback), 10);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, safe));
}

function randomToken() {
  return crypto.randomBytes(32).toString("hex");
}

function normalizeNasId(raw) {
  const value = String(raw || "").trim();
  return /^[A-Za-z0-9_.:-]{1,160}$/.test(value) ? value : null;
}

function normalizeMacStrict(raw) {
  const compact = String(raw || "").trim().replace(/[^0-9A-Fa-f]/g, "");
  if (!/^[0-9A-Fa-f]{12}$/.test(compact)) return null;
  return compact.match(/.{2}/g).map((part) => part.toUpperCase()).join(":");
}

function normalizePrivateIpv4(raw) {
  const value = String(raw || "").trim();
  if (net.isIP(value) !== 4) return null;
  const p = value.split(".").map(Number);
  const isPrivateOrLocal =
    p[0] === 10 ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    (p[0] === 169 && p[1] === 254);
  return isPrivateOrLocal ? value : null;
}


function normalizeHotspotStatusUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    if (parsed.username || parsed.password || parsed.hash || parsed.search) return null;
    if (parsed.pathname !== "/status") return null;
    if (!normalizePrivateIpv4(parsed.hostname)) return null;
    return parsed.toString().replace(/\/$/, "");
  } catch (_) {
    return null;
  }
}

function parseNasAllowlist(raw) {
  const values = String(raw || "")
    .split(",")
    .map((value) => normalizeNasId(value))
    .filter(Boolean);
  return new Set(values);
}

function decimalString(value) {
  if (value === null || value === undefined || value === "") return null;
  try {
    const parsed = BigInt(String(value));
    return parsed >= 0n ? parsed.toString() : null;
  } catch (_) {
    return null;
  }
}

function safeSeconds(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : null;
}

function progressPct(usedRaw, totalRaw) {
  const used = decimalString(usedRaw);
  const total = decimalString(totalRaw);
  if (used === null || total === null) return null;
  const usedBig = BigInt(used);
  const totalBig = BigInt(total);
  if (totalBig <= 0n) return null;
  const basisPoints = (usedBig * 10000n) / totalBig;
  return Math.max(0, Math.min(100, Number(basisPoints) / 100));
}

function timeProgressPct(used, total) {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((used / total) * 10000) / 100));
}

function planDurationSeconds(plan) {
  const direct = Number(plan?.duration_seconds);
  if (Number.isFinite(direct) && direct > 0) return Math.floor(direct);
  const minutes = Number(plan?.duration_minutes);
  if (Number.isFinite(minutes) && minutes > 0) return Math.floor(minutes * 60);
  const hours = Number(plan?.duration_hours);
  if (Number.isFinite(hours) && hours > 0) return Math.floor(hours * 3600);
  return null;
}

function rosEncodeLength(len) {
  if (len < 0x80) return Buffer.from([len]);
  if (len < 0x4000) return Buffer.from([(len >> 8) | 0x80, len & 0xff]);
  if (len < 0x200000) return Buffer.from([(len >> 16) | 0xc0, (len >> 8) & 0xff, len & 0xff]);
  if (len < 0x10000000) return Buffer.from([(len >> 24) | 0xe0, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
  return Buffer.from([0xf0, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
}

function rosEncodeWord(word) {
  const bytes = Buffer.from(String(word), "utf8");
  return Buffer.concat([rosEncodeLength(bytes.length), bytes]);
}

function rosDecodeLength(buffer, offset) {
  if (offset >= buffer.length) return null;
  let c = buffer[offset++];
  if ((c & 0x80) === 0x00) return { len: c, offset };
  if ((c & 0xc0) === 0x80) {
    if (offset >= buffer.length) return null;
    return { len: ((c & ~0xc0) << 8) + buffer[offset++], offset };
  }
  if ((c & 0xe0) === 0xc0) {
    if (offset + 1 >= buffer.length) return null;
    return { len: ((c & ~0xe0) << 16) + (buffer[offset++] << 8) + buffer[offset++], offset };
  }
  if ((c & 0xf0) === 0xe0) {
    if (offset + 2 >= buffer.length) return null;
    return { len: ((c & ~0xf0) << 24) + (buffer[offset++] << 16) + (buffer[offset++] << 8) + buffer[offset++], offset };
  }
  if ((c & 0xf8) === 0xf0) {
    if (offset + 3 >= buffer.length) return null;
    return { len: (buffer[offset++] << 24) + (buffer[offset++] << 16) + (buffer[offset++] << 8) + buffer[offset++], offset };
  }
  return null;
}

class RouterOsApiClient {
  constructor({ host, port, user, password, timeoutMs }) {
    this.host = host;
    this.port = Number(port || 8728);
    this.user = user;
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port }, resolve);
      this.socket = socket;
      const timer = setTimeout(() => {
        try { socket.destroy(); } catch (_) {}
        reject(new Error("router_connect_timeout"));
      }, this.timeoutMs);
      socket.once("connect", () => clearTimeout(timer));
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.on("data", (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.drain();
      });
    });
  }

  close() {
    try { this.socket?.end(); } catch (_) {}
    try { this.socket?.destroy(); } catch (_) {}
  }

  writeSentence(words) {
    const chunks = words.map(rosEncodeWord);
    chunks.push(Buffer.from([0]));
    this.socket.write(Buffer.concat(chunks));
  }

  drain() {
    while (true) {
      const sentence = [];
      let offset = 0;
      while (true) {
        const decoded = rosDecodeLength(this.buffer, offset);
        if (!decoded) return;
        const { len } = decoded;
        offset = decoded.offset;
        if (this.buffer.length < offset + len) return;
        if (len === 0) {
          this.buffer = this.buffer.slice(offset);
          const pending = this.pending.shift();
          if (pending) pending(sentence);
          break;
        }
        sentence.push(this.buffer.slice(offset, offset + len).toString("utf8"));
        offset += len;
      }
    }
  }

  sentence(words) {
    if (!this.socket) return Promise.reject(new Error("router_not_connected"));
    return new Promise((resolve, reject) => {
      const output = [];
      const timeout = setTimeout(() => reject(new Error("router_sentence_timeout")), this.timeoutMs);
      const readOne = (sentence) => {
        output.push(sentence);
        const head = sentence[0] || "";
        if (head === "!done") {
          clearTimeout(timeout);
          resolve(output);
          return;
        }
        if (head === "!fatal" || head === "!trap") {
          clearTimeout(timeout);
          reject(new Error("router_command_failed"));
          return;
        }
        this.pending.push(readOne);
      };
      this.pending.push(readOne);
      this.writeSentence(words);
    });
  }

  async login() {
    await this.sentence(["/login", `=name=${this.user}`, `=password=${this.password}`]);
  }

  command(words) {
    return this.sentence(words);
  }
}

function rosRows(sentences) {
  const rows = [];
  for (const sentence of sentences || []) {
    if (!Array.isArray(sentence) || sentence[0] !== "!re") continue;
    const row = {};
    for (const word of sentence.slice(1)) {
      if (!word.startsWith("=")) continue;
      const index = word.indexOf("=", 1);
      if (index === -1) continue;
      row[word.slice(1, index)] = word.slice(index + 1);
    }
    rows.push(row);
  }
  return rows;
}

export function registerEc1ClientSpace({
  app,
  supabase,
  isProd,
  allowedOrigins = [],
  cleanOptionalText,
  buildPoolDisplayName,
  mikrotikRateLimitToSpeedHuman,
  loadVoucherBonusV2Truth,
}) {
  if (!app) throw new Error("ec1_app_required");
  if (typeof cleanOptionalText !== "function") throw new Error("ec1_clean_text_helper_required");
  if (typeof buildPoolDisplayName !== "function") throw new Error("ec1_pool_name_helper_required");
  if (typeof mikrotikRateLimitToSpeedHuman !== "function") throw new Error("ec1_speed_helper_required");
  if (typeof loadVoucherBonusV2Truth !== "function") throw new Error("ec1_bonus_helper_required");

  const enabled = envFlag("CLIENT_SPACE_ENABLED", false);
  const autoDetectEnabled = envFlag("CLIENT_SPACE_AUTO_DETECT_ENABLED", false);
  const dynamicNasEnabled = envFlag("CLIENT_SPACE_DYNAMIC_NAS_ENABLED", false);
  const allowedNasIds = parseNasAllowlist(process.env.CLIENT_SPACE_ALLOWED_NAS_IDS || "");
  const hotspotStatusUrl = normalizeHotspotStatusUrl(
    process.env.CLIENT_SPACE_HOTSPOT_STATUS_URL || "http://192.168.88.1/status"
  );
  const autoDetectReady = autoDetectEnabled && Boolean(hotspotStatusUrl) &&
    (dynamicNasEnabled || allowedNasIds.size > 0);
  const bindUserAgent = envFlag("CLIENT_SPACE_BIND_USER_AGENT", true);
  const claimTtlSeconds = envInt("CLIENT_SPACE_CLAIM_TTL_SECONDS", 180, 60, 600);
  const sessionTtlSeconds = envInt("CLIENT_SPACE_SESSION_TTL_SECONDS", 45 * 24 * 60 * 60, 3600, 90 * 24 * 60 * 60);
  const radiusWindowSeconds = envInt("CLIENT_SPACE_RADIUS_WINDOW_SECONDS", 180, 60, 600);
  const maxClaimAttempts = envInt("CLIENT_SPACE_MAX_CLAIM_ATTEMPTS", 5, 1, 20);
  const routerTimeoutMs = envInt("CLIENT_SPACE_ROUTER_TIMEOUT_MS", 7000, 2000, 15000);
  const verifyMode = String(process.env.CLIENT_SPACE_ROUTER_VERIFY_MODE || "direct").trim().toLowerCase() === "agent"
    ? "agent"
    : "direct";
  const verifyAgentUrl = String(process.env.CLIENT_SPACE_VERIFY_AGENT_URL || "").trim();
  const verifyAgentSecret = String(process.env.CLIENT_SPACE_VERIFY_AGENT_SECRET || "").trim();

  const sessionCookie = "razafi_client_session";
  const claimCookie = "razafi_client_claim";
  const normalizedOrigins = new Set((allowedOrigins || []).map((origin) => String(origin || "").trim().replace(/\/$/, "")).filter(Boolean));

  function noStore(res) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
  }

  function hidden(res) {
    return res.status(404).json({ error: "not_found" });
  }

  function cookieOptions(maxAge) {
    return {
      httpOnly: true,
      secure: Boolean(isProd),
      sameSite: "lax",
      path: "/api/client",
      maxAge: Math.max(0, Number(maxAge || 0)),
    };
  }

  function clearCookie(res, name) {
    try {
      res.clearCookie(name, {
        httpOnly: true,
        secure: Boolean(isProd),
        sameSite: "lax",
        path: "/api/client",
      });
    } catch (_) {}
  }

  function userAgentHash(req) {
    const raw = String(req.get("user-agent") || "").trim();
    return raw ? hashToken(raw) : null;
  }

  function originAllowed(req) {
    const fetchSite = String(req.get("sec-fetch-site") || "").trim().toLowerCase();
    if (fetchSite === "cross-site") return false;
    const origin = String(req.get("origin") || "").trim().replace(/\/$/, "");
    return !origin || normalizedOrigins.has(origin);
  }

  function primaryPayload(row) {
    if (!row || typeof row !== "object") return null;
    const plan = row.plans && typeof row.plans === "object" ? row.plans : {};
    const totalSeconds = planDurationSeconds(plan);
    const remainingSeconds = safeSeconds(row.remaining_seconds);
    const usedSeconds = totalSeconds === null || remainingSeconds === null
      ? null
      : Math.max(0, totalSeconds - Math.min(totalSeconds, remainingSeconds));
    const totalBytes = decimalString(row.data_total_bytes);
    const usedBytes = decimalString(row.data_used_bytes) || "0";
    const remainingBytes = decimalString(row.data_remaining_bytes);
    const unlimited = totalBytes === null || BigInt(totalBytes) <= 0n;

    return {
      status: String(row.truth_status || row.status || "unknown").toLowerCase(),
      plan: {
        name: cleanOptionalText(plan.name, 160),
        speed_human: mikrotikRateLimitToSpeedHuman(plan.mikrotik_rate_limit),
        duration_seconds: totalSeconds,
        data_unlimited: unlimited,
        data_total_bytes: unlimited ? null : totalBytes,
      },
      consumption: {
        time_used_seconds: usedSeconds,
        time_remaining_seconds: remainingSeconds,
        time_progress_pct: usedSeconds === null || totalSeconds === null ? null : timeProgressPct(usedSeconds, totalSeconds),
        data_used_bytes: usedBytes,
        data_remaining_bytes: unlimited ? null : remainingBytes,
        data_progress_pct: unlimited ? null : progressPct(usedBytes, totalBytes),
        data_total_human: row.data_total_human ?? null,
        data_used_human: row.data_used_human ?? null,
        data_remaining_human: unlimited ? null : (row.data_remaining_human ?? null),
      },
      started_at: row.started_at || row.activated_at || null,
      expires_at: row.expires_at || null,
    };
  }

  function bonusPayload(bonus) {
    if (!bonus || typeof bonus !== "object") return null;
    const state = String(bonus.state || "").toLowerCase();
    const effectiveState = String(bonus.effective_state || state || "").toLowerCase();
    if (!["available", "active"].includes(state) && !["available", "active"].includes(effectiveState)) return null;

    const totalSeconds = safeSeconds(bonus.duration_seconds);
    const remainingSeconds = safeSeconds(bonus.remaining_seconds);
    const usedSeconds = totalSeconds === null || remainingSeconds === null
      ? null
      : Math.max(0, totalSeconds - Math.min(totalSeconds, remainingSeconds));
    const unlimited = bonus.data_unlimited === true;
    const totalBytes = unlimited ? null : decimalString(bonus.total_bytes);
    const usedBytes = decimalString(bonus.consumed_bytes) || "0";
    const remainingBytes = unlimited ? null : decimalString(bonus.remaining_bytes);

    return {
      status: effectiveState || state || "unknown",
      can_activate: bonus.can_activate === true,
      currently_consumed: effectiveState === "active" && bonus.can_authorize === true,
      duration_seconds: totalSeconds,
      time_used_seconds: usedSeconds,
      time_remaining_seconds: remainingSeconds,
      time_progress_pct: usedSeconds === null || totalSeconds === null ? null : timeProgressPct(usedSeconds, totalSeconds),
      data_unlimited: unlimited,
      data_total_bytes: totalBytes,
      data_used_bytes: usedBytes,
      data_remaining_bytes: remainingBytes,
      data_progress_pct: unlimited ? null : progressPct(usedBytes, totalBytes),
      data_total_human: bonus.total_human || null,
      data_used_human: bonus.consumed_human || null,
      data_remaining_human: unlimited ? null : (bonus.remaining_human || null),
      prepared_at: bonus.prepared_at || null,
      started_at: bonus.started_at || null,
      expires_at: bonus.expires_at || null,
    };
  }

  let lastCleanupAt = 0;
  async function cleanupExpiredRows() {
    if (!supabase) return;
    const now = Date.now();
    if (now - lastCleanupAt < 10 * 60 * 1000) return;
    lastCleanupAt = now;
    try {
      await Promise.all([
        supabase.from("client_space_claims").delete().lt("expires_at", new Date(now - 24 * 60 * 60 * 1000).toISOString()),
        supabase.from("client_space_sessions").delete().lt("expires_at", new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString()),
      ]);
    } catch (error) {
      console.warn("[EC1] cleanup skipped", String(error?.message || error).slice(0, 160));
    }
  }

  async function revokeSessionById(id, reason) {
    if (!supabase || !id) return;
    try {
      await supabase
        .from("client_space_sessions")
        .update({ revoked_at: new Date().toISOString(), revoke_reason: cleanOptionalText(reason, 160) || "revoked" })
        .eq("id", id)
        .is("revoked_at", null);
    } catch (_) {}
  }

  async function loadSession(req, res) {
    const rawToken = String(req.cookies?.[sessionCookie] || "").trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(rawToken)) {
      if (rawToken) clearCookie(res, sessionCookie);
      return null;
    }
    if (!supabase) throw new Error("supabase_not_configured");

    const nowIso = new Date().toISOString();
    const { data, error } = await supabase
      .from("client_space_sessions")
      .select("id,voucher_session_id,pool_id,bound_nas_id,bound_client_mac,bound_client_ip,user_agent_hash,last_seen_at,expires_at,session_version")
      .eq("session_token_hash", hashToken(rawToken))
      .is("revoked_at", null)
      .gt("expires_at", nowIso)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      clearCookie(res, sessionCookie);
      return null;
    }

    if (bindUserAgent && data.user_agent_hash) {
      const currentHash = userAgentHash(req);
      if (!currentHash || !safeEqual(currentHash, data.user_agent_hash)) {
        await revokeSessionById(data.id, "user_agent_mismatch");
        clearCookie(res, sessionCookie);
        return null;
      }
    }

    const lastSeenMs = Date.parse(data.last_seen_at || "") || 0;
    if (Date.now() - lastSeenMs > 60_000) {
      Promise.resolve(
        supabase.from("client_space_sessions").update({ last_seen_at: nowIso }).eq("id", data.id).is("revoked_at", null)
      ).catch(() => {});
    }
    return data;
  }

  async function loadRouterAndPool(nasId) {
    const { data: router, error: routerError } = await supabase
      .from("mikrotik_routers")
      .select("nas_id,api_host,api_port,api_user,api_password,api_enabled")
      .eq("nas_id", nasId)
      .maybeSingle();
    if (routerError) throw routerError;
    if (!router || router.api_enabled !== true || !router.api_host || !router.api_user || !router.api_password) {
      throw new Error("router_unavailable");
    }

    const { data: pool, error: poolError } = await supabase
      .from("internet_pools")
      .select("id,radius_nas_id,is_active,system")
      .eq("radius_nas_id", nasId)
      .maybeSingle();
    if (poolError) throw poolError;
    if (!pool || pool.is_active !== true || String(pool.system || "").toLowerCase() !== "mikrotik") {
      throw new Error("pool_unavailable");
    }
    return { router, pool };
  }

  async function verifyRouterDirect(router, nasId, clientMac, clientIp) {
    if (isProd && !normalizePrivateIpv4(router.api_host)) {
      throw new Error("router_host_not_private");
    }
    const api = new RouterOsApiClient({
      host: router.api_host,
      port: router.api_port || 8728,
      user: router.api_user,
      password: router.api_password,
      timeoutMs: routerTimeoutMs,
    });
    try {
      await api.connect();
      await api.login();

      const identityRows = rosRows(await api.command(["/system/identity/print"]));
      const identities = Array.from(new Set(
        (identityRows || []).map((row) => normalizeNasId(row?.name)).filter(Boolean)
      ));
      if (identities.length !== 1 || !safeEqual(identities[0], nasId)) {
        throw new Error("router_identity_mismatch");
      }

      const rows = rosRows(await api.command(["/ip/hotspot/active/print", `?mac-address=${clientMac}`]));
      const users = Array.from(new Set(
        (rows || [])
          .filter((row) => normalizeMacStrict(row?.["mac-address"]) === clientMac && String(row?.address || "").trim() === clientIp)
          .map((row) => String(row?.user || "").trim())
          .filter(Boolean)
      ));
      if (users.length !== 1) throw new Error("router_session_not_unique");
      return { username: users[0] };
    } finally {
      api.close();
    }
  }

  async function verifyRouterAgent(router, nasId, clientMac, clientIp) {
    if (!verifyAgentUrl || !verifyAgentSecret) throw new Error("verify_agent_not_configured");
    if (isProd && !/^https:\/\//i.test(verifyAgentUrl)) throw new Error("verify_agent_https_required");

    const response = await axios.post(
      verifyAgentUrl,
      {
        nas_id: nasId,
        router_ip: router.api_host,
        router_port: router.api_port || 8728,
        api_user: router.api_user,
        api_password: router.api_password,
        client_mac: clientMac,
        client_ip: clientIp,
      },
      {
        headers: { "Content-Type": "application/json", "x-secret": verifyAgentSecret },
        timeout: routerTimeoutMs + 2000,
        validateStatus: () => true,
      }
    );

    const body = response?.data && typeof response.data === "object" ? response.data : {};
    if (response.status < 200 || response.status >= 300 || body.ok !== true || body.active !== true) {
      throw new Error("verify_agent_rejected");
    }
    if (normalizeNasId(body.nas_id) !== nasId ||
        normalizeMacStrict(body.client_mac || clientMac) !== clientMac ||
        String(body.client_ip || clientIp).trim() !== clientIp) {
      throw new Error("verify_agent_mismatch");
    }
    const username = String(body.username || "").trim();
    if (!username) throw new Error("verify_agent_username_missing");
    return { username };
  }

  async function recentRadiusRows(nasId, clientMac) {
    const cutoff = new Date(Date.now() - radiusWindowSeconds * 1000).toISOString();
    const variants = Array.from(new Set([clientMac, clientMac.replace(/:/g, "-")]));
    const exact = await supabase
      .from("radius_acct_sessions")
      .select("voucher_code,client_mac,calling_station_id,framed_ip_address,acct_status_type,updated_at")
      .eq("nas_id", nasId)
      .in("client_mac", variants)
      .gte("updated_at", cutoff)
      .order("updated_at", { ascending: false })
      .limit(20);
    if (!exact.error && Array.isArray(exact.data) && exact.data.length) return exact.data;

    const fallback = await supabase
      .from("radius_acct_sessions")
      .select("voucher_code,client_mac,calling_station_id,framed_ip_address,acct_status_type,updated_at")
      .eq("nas_id", nasId)
      .gte("updated_at", cutoff)
      .order("updated_at", { ascending: false })
      .limit(100);
    if (fallback.error) throw exact.error || fallback.error;
    return fallback.data || [];
  }

  async function verifyClaimIdentity({ nasId, clientMac, clientIp }) {
    const { router, pool } = await loadRouterAndPool(nasId);
    const routerProof = verifyMode === "agent"
      ? await verifyRouterAgent(router, nasId, clientMac, clientIp)
      : await verifyRouterDirect(router, nasId, clientMac, clientIp);

    const expectedUsername = String(routerProof.username || "").trim().toLowerCase();
    const radiusRows = await recentRadiusRows(nasId, clientMac);
    const radiusRow = (radiusRows || []).find((row) => {
      const status = String(row.acct_status_type || "").trim().toLowerCase();
      const active = status === "interim-update" || status === "start" || status === "alive";
      const rowIp = String(row.framed_ip_address || "").trim();
      return active &&
        normalizeMacStrict(row.client_mac || row.calling_station_id) === clientMac &&
        String(row.voucher_code || "").trim().toLowerCase() === expectedUsername &&
        (!rowIp || rowIp === clientIp);
    });
    if (!radiusRow) throw new Error("radius_session_not_verified");

    const { data: voucherRows, error: voucherError } = await supabase
      .from("voucher_sessions")
      .select("id,client_mac")
      .eq("voucher_code", radiusRow.voucher_code)
      .order("created_at", { ascending: false })
      .limit(1);
    if (voucherError) throw voucherError;
    const voucher = Array.isArray(voucherRows) && voucherRows.length ? voucherRows[0] : null;
    if (!voucher || normalizeMacStrict(voucher.client_mac) !== clientMac) throw new Error("voucher_session_not_verified");

    const { data: truth, error: truthError } = await supabase
      .from("vw_voucher_sessions_truth")
      .select("id,truth_status,status")
      .eq("id", voucher.id)
      .maybeSingle();
    if (truthError || !truth) throw truthError || new Error("voucher_truth_missing");

    let bonus = null;
    try {
      bonus = (await loadVoucherBonusV2Truth({ voucherSessionId: voucher.id })).bonus || null;
    } catch (_) {}
    const primaryActive = String(truth.truth_status || truth.status || "").toLowerCase() === "active";
    const bonusActive = String(bonus?.effective_state || bonus?.state || "").toLowerCase() === "active" && bonus?.can_authorize === true;
    if (!primaryActive && !bonusActive) throw new Error("access_not_active");

    return { voucherSessionId: voucher.id, poolId: pool.id };
  }

  async function latestLiveRow(session, voucherCode) {
    const rows = await recentRadiusRows(session.bound_nas_id, normalizeMacStrict(session.bound_client_mac));
    const expectedVoucher = String(voucherCode || "").trim().toLowerCase();
    return (rows || []).find((row) =>
      normalizeMacStrict(row.client_mac || row.calling_station_id) === normalizeMacStrict(session.bound_client_mac) &&
      String(row.voucher_code || "").trim().toLowerCase() === expectedVoucher
    ) || null;
  }

  async function buildConsumption(session) {
    const { data: row, error } = await supabase
      .from("vw_voucher_sessions_truth")
      .select(`
        id,voucher_code,status,truth_status,remaining_seconds,activated_at,started_at,expires_at,
        data_total_bytes,data_used_bytes,data_remaining_bytes,
        data_total_human,data_used_human,data_remaining_human,client_mac,
        plans:plans(id,name,duration_seconds,duration_minutes,duration_hours,data_mb,mikrotik_rate_limit)
      `)
      .eq("id", session.voucher_session_id)
      .maybeSingle();
    if (error) throw error;
    if (!row) throw new Error("voucher_session_missing");

    const rowMac = normalizeMacStrict(row.client_mac);
    if (!rowMac || rowMac !== normalizeMacStrict(session.bound_client_mac)) {
      await revokeSessionById(session.id, "voucher_binding_changed");
      throw new Error("session_binding_invalid");
    }

    const { data: pool, error: poolError } = await supabase
      .from("internet_pools")
      .select("name,brand_name,branding_logo_url,contact_phone")
      .eq("id", session.pool_id)
      .maybeSingle();
    if (poolError) throw poolError;

    let rawBonus = null;
    try {
      rawBonus = (await loadVoucherBonusV2Truth({ voucherSessionId: session.voucher_session_id })).bonus || null;
    } catch (errorBonus) {
      console.warn("[EC1] bonus truth unavailable", String(errorBonus?.message || errorBonus).slice(0, 120));
      throw new Error("bonus_truth_unavailable");
    }

    const primary = primaryPayload(row);
    const bonus = bonusPayload(rawBonus);
    const bonusActive = bonus?.currently_consumed === true;
    const primaryActive = primary?.status === "active";

    let liveRow = null;
    try { liveRow = await latestLiveRow(session, row.voucher_code); } catch (_) {}
    const liveStatus = String(liveRow?.acct_status_type || "").trim().toLowerCase();
    const rowIsLive = liveStatus === "interim-update" || liveStatus === "start" || liveStatus === "alive";
    const online = Boolean((primaryActive || bonusActive) && rowIsLive);

    return {
      ok: true,
      authenticated: true,
      server_time: new Date().toISOString(),
      refresh_after_seconds: 30,
      currently_consumed: bonusActive ? "bonus" : (primaryActive ? "primary" : "none"),
      pool: {
        display_name: buildPoolDisplayName(pool) || cleanOptionalText(pool?.name, 120),
        logo_url: cleanOptionalText(pool?.branding_logo_url, 2000),
        contact_phone: cleanOptionalText(pool?.contact_phone, 80),
      },
      primary_voucher: primary,
      active_bonus: bonus?.status === "active" ? bonus : null,
      available_bonus: bonus?.status === "available" ? bonus : null,
      live: {
        status: liveRow ? (online ? "online" : "offline") : "unknown",
        updated_at: liveRow?.updated_at || null,
        accounting_interval_seconds: 60,
      },
    };
  }

  const bootstrapLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req),
    message: { error: "too_many_requests" },
  });
  const claimLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req),
    message: { error: "too_many_requests" },
  });
  const readLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req),
    message: { error: "too_many_requests" },
  });

  app.get("/api/client/bootstrap", bootstrapLimiter, async (req, res) => {
    noStore(res);
    if (!enabled) return hidden(res);
    try {
      if (!supabase) return res.status(503).json({ error: "service_unavailable" });
      cleanupExpiredRows().catch(() => {});

      const session = await loadSession(req, res);
      if (session) return res.json({ ok: true, authenticated: true, auto_detect_enabled: autoDetectReady });
      if (!autoDetectReady) return res.json({ ok: true, authenticated: false, auto_detect_enabled: false });

      const oldBinding = String(req.cookies?.[claimCookie] || "").trim().toLowerCase();
      if (/^[0-9a-f]{64}$/.test(oldBinding)) {
        await supabase
          .from("client_space_claims")
          .update({ revoked_at: new Date().toISOString() })
          .eq("browser_binding_hash", hashToken(oldBinding))
          .is("consumed_at", null)
          .is("revoked_at", null);
      }

      const challenge = randomToken();
      const browserBinding = randomToken();
      const expiresAt = new Date(Date.now() + claimTtlSeconds * 1000);
      const { error } = await supabase.from("client_space_claims").insert({
        challenge_hash: hashToken(challenge),
        browser_binding_hash: hashToken(browserBinding),
        expires_at: expiresAt.toISOString(),
      });
      if (error) throw error;

      res.cookie(claimCookie, browserBinding, cookieOptions(claimTtlSeconds * 1000));
      const detectionUrl = new URL(hotspotStatusUrl);
      detectionUrl.searchParams.set("var", `ec1_${challenge}`);

      return res.json({
        ok: true,
        authenticated: false,
        auto_detect_enabled: true,
        detection_url: detectionUrl.toString(),
        expires_in_seconds: claimTtlSeconds,
      });
    } catch (error) {
      console.error("[EC1] bootstrap error", String(error?.message || error).slice(0, 160));
      return res.status(503).json({ error: "service_unavailable" });
    }
  });

  app.post("/api/client/claim", claimLimiter, async (req, res) => {
    noStore(res);
    if (!enabled || !autoDetectReady) return hidden(res);
    if (!originAllowed(req)) return res.status(403).json({ error: "forbidden" });

    try {
      if (!supabase) return res.status(503).json({ error: "service_unavailable" });
      const challenge = String(req.body?.challenge || "").trim().toLowerCase();
      const browserBinding = String(req.cookies?.[claimCookie] || "").trim().toLowerCase();
      const nasId = normalizeNasId(req.body?.nas_id || req.body?.nasId);
      const clientMac = normalizeMacStrict(req.body?.client_mac || req.body?.clientMac);
      const clientIp = normalizePrivateIpv4(req.body?.client_ip || req.body?.clientIp);
      if (!/^[0-9a-f]{64}$/.test(challenge) || !/^[0-9a-f]{64}$/.test(browserBinding) || !nasId || !clientMac || !clientIp) {
        return res.status(400).json({ error: "claim_invalid" });
      }
      if (!dynamicNasEnabled && !allowedNasIds.has(nasId)) {
        return res.status(401).json({ error: "device_not_verified" });
      }

      const now = new Date();
      const nowIso = now.toISOString();
      const { data: claim, error: claimError } = await supabase
        .from("client_space_claims")
        .select("id,attempt_count,expires_at,consumed_at,revoked_at")
        .eq("challenge_hash", hashToken(challenge))
        .eq("browser_binding_hash", hashToken(browserBinding))
        .maybeSingle();
      if (claimError) throw claimError;
      if (!claim || claim.consumed_at || claim.revoked_at || Date.parse(claim.expires_at || "") <= now.getTime()) {
        clearCookie(res, claimCookie);
        return res.status(401).json({ error: "claim_invalid" });
      }

      const nextAttempt = Number(claim.attempt_count || 0) + 1;
      if (nextAttempt > maxClaimAttempts) {
        await supabase
          .from("client_space_claims")
          .update({ attempt_count: Math.min(20, nextAttempt), last_attempt_at: nowIso, revoked_at: nowIso })
          .eq("id", claim.id)
          .is("consumed_at", null)
          .is("revoked_at", null);
        clearCookie(res, claimCookie);
        return res.status(401).json({ error: "claim_invalid" });
      }

      await supabase
        .from("client_space_claims")
        .update({ attempt_count: Math.min(20, nextAttempt), last_attempt_at: nowIso })
        .eq("id", claim.id)
        .is("consumed_at", null)
        .is("revoked_at", null);

      let identity;
      try {
        identity = await verifyClaimIdentity({ nasId, clientMac, clientIp });
      } catch (verificationError) {
        console.warn("[EC1] device verification failed", String(verificationError?.message || "verification_failed").slice(0, 120));
        return res.status(401).json({ error: "device_not_verified" });
      }

      const sessionToken = randomToken();
      const sessionExpiresAt = new Date(Date.now() + sessionTtlSeconds * 1000);
      const { data: createdSession, error: sessionError } = await supabase
        .from("client_space_sessions")
        .insert({
          session_token_hash: hashToken(sessionToken),
          source_claim_id: claim.id,
          voucher_session_id: identity.voucherSessionId,
          pool_id: identity.poolId,
          bound_nas_id: nasId,
          bound_client_mac: clientMac,
          bound_client_ip: clientIp,
          user_agent_hash: userAgentHash(req),
          expires_at: sessionExpiresAt.toISOString(),
        })
        .select("id")
        .single();
      if (sessionError || !createdSession?.id) {
        if (String(sessionError?.code || "") === "23505") {
          clearCookie(res, claimCookie);
          return res.status(401).json({ error: "claim_invalid" });
        }
        throw sessionError || new Error("session_insert_failed");
      }

      const { data: consumed, error: consumeError } = await supabase
        .from("client_space_claims")
        .update({
          consumed_at: nowIso,
          voucher_session_id: identity.voucherSessionId,
          pool_id: identity.poolId,
          nas_id: nasId,
          client_mac: clientMac,
          client_ip: clientIp,
        })
        .eq("id", claim.id)
        .is("consumed_at", null)
        .is("revoked_at", null)
        .gt("expires_at", nowIso)
        .select("id");
      if (consumeError || !Array.isArray(consumed) || consumed.length !== 1) {
        try {
          await supabase.from("client_space_sessions").delete().eq("id", createdSession.id);
        } catch (_) {
          await revokeSessionById(createdSession.id, "claim_consume_failed");
        }
        throw consumeError || new Error("claim_consume_failed");
      }

      res.cookie(sessionCookie, sessionToken, cookieOptions(sessionTtlSeconds * 1000));
      clearCookie(res, claimCookie);
      return res.json({ ok: true, authenticated: true });
    } catch (error) {
      console.error("[EC1] claim error", String(error?.message || error).slice(0, 160));
      return res.status(503).json({ error: "service_unavailable" });
    }
  });

  app.get("/api/client/consumption", readLimiter, async (req, res) => {
    noStore(res);
    if (!enabled) return hidden(res);
    try {
      if (!supabase) return res.status(503).json({ error: "service_unavailable" });
      const session = await loadSession(req, res);
      if (!session) return res.status(401).json({ error: "client_session_required" });
      return res.json(await buildConsumption(session));
    } catch (error) {
      if (["session_binding_invalid", "voucher_session_missing"].includes(String(error?.message || ""))) {
        clearCookie(res, sessionCookie);
        return res.status(401).json({ error: "client_session_invalid" });
      }
      console.error("[EC1] consumption error", String(error?.message || error).slice(0, 160));
      return res.status(503).json({ error: "service_unavailable" });
    }
  });

  app.post("/api/client/logout", claimLimiter, async (req, res) => {
    noStore(res);
    if (!enabled) return hidden(res);
    if (!originAllowed(req)) return res.status(403).json({ error: "forbidden" });
    try {
      const rawToken = String(req.cookies?.[sessionCookie] || "").trim().toLowerCase();
      if (supabase && /^[0-9a-f]{64}$/.test(rawToken)) {
        await supabase
          .from("client_space_sessions")
          .update({ revoked_at: new Date().toISOString(), revoke_reason: "client_logout" })
          .eq("session_token_hash", hashToken(rawToken))
          .is("revoked_at", null);
      }
    } catch (_) {}
    clearCookie(res, sessionCookie);
    clearCookie(res, claimCookie);
    return res.json({ ok: true });
  });

  console.log(`[EC1] backend registered; enabled=${enabled}; auto_detect=${autoDetectReady}; dynamic_nas=${dynamicNasEnabled}; allowed_nas_count=${allowedNasIds.size}; verify_mode=${verifyMode}`);
}

export const __ec1Test = {
  normalizeNasId,
  normalizeMacStrict,
  normalizePrivateIpv4,
  normalizeHotspotStatusUrl,
  parseNasAllowlist,
  decimalString,
  progressPct,
  planDurationSeconds,
};
