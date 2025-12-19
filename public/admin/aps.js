async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, { credentials: "include", ...opts });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error("Server returned non-JSON"); }
  if (!res.ok) throw new Error(data?.error || data?.message || "Request failed");
  return data;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

function fmtDate(v) {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString();
}

document.addEventListener("DOMContentLoaded", async () => {
  const meEl = document.getElementById("me");
  const errEl = document.getElementById("error");
  const rowsEl = document.getElementById("rows");

  const qEl = document.getElementById("q");
  const poolEl = document.getElementById("poolId");
  const activeEl = document.getElementById("activeFilter");
  const staleEl = document.getElementById("staleFilter");
  const refreshBtn = document.getElementById("refreshBtn");
  const logoutBtn = document.getElementById("logoutBtn");

  async function guardSession() {
    try {
      const me = await fetchJSON("/api/admin/me");
      meEl.textContent = `Connected as ${me.email}`;
      return true;
    } catch {
      window.location.href = "/admin/login.html";
      return false;
    }
  }

  async function loadAPs() {
    errEl.textContent = "";
    rowsEl.innerHTML = `<tr><td style="padding:10px;" colspan="7">Loading...</td></tr>`;

    const params = new URLSearchParams();
    const q = qEl.value.trim();
    const pool_id = poolEl.value.trim();

    if (q) params.set("q", q);
    if (pool_id) params.set("pool_id", pool_id);

    params.set("active", activeEl.value);
    params.set("stale", staleEl.value);

    params.set("limit", "200");
    params.set("offset", "0");

    const data = await fetchJSON(`/api/admin/aps?${params.toString()}`);
    const aps = data.aps || [];

    if (!aps.length) {
      rowsEl.innerHTML = `<tr><td style="padding:10px;" colspan="7">No APs</td></tr>`;
      return;
    }

    rowsEl.innerHTML = aps.map(a => {
      const stale = a.is_stale ? "⚠️" : "✅";
      const active = a.is_active ? "✅" : "—";
      const clients = Number.isFinite(Number(a.active_clients)) ? Number(a.active_clients) : 0;
      const pool = a.pool_id ? esc(a.pool_id) : "—";
      const cap = (a.capacity_max === null || a.capacity_max === undefined) ? "—" : esc(a.capacity_max);

      return `
        <tr style="border-top:1px solid rgba(255,255,255,.12);">
          <td style="padding:10px; font-weight:600;">${esc(a.ap_mac)}</td>
          <td style="padding:10px;">${pool}</td>
          <td style="padding:10px;">${esc(clients)}</td>
          <td style="padding:10px;">${esc(fmtDate(a.last_computed_at))}</td>
          <td style="padding:10px;">${stale}</td>
          <td style="padding:10px;">${active}</td>
          <td style="padding:10px;">${cap}</td>
        </tr>
      `;
    }).join("");
  }

  // init
  if (!(await guardSession())) return;
  await loadAPs();

  refreshBtn.addEventListener("click", () => loadAPs().catch(e => errEl.textContent = e.message));

  qEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadAPs().catch(err => errEl.textContent = err.message);
  });
  poolEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadAPs().catch(err => errEl.textContent = err.message);
  });

  activeEl.addEventListener("change", () => loadAPs().catch(err => errEl.textContent = err.message));
  staleEl.addEventListener("change", () => loadAPs().catch(err => errEl.textContent = err.message));

  logoutBtn.addEventListener("click", async () => {
    try {
      await fetchJSON("/api/admin/logout", { method: "POST" });
      window.location.href = "/admin/login.html";
    } catch (e) {
      errEl.textContent = e.message;
    }
  });
});
