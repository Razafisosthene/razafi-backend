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

document.addEventListener("DOMContentLoaded", async () => {
  const meEl = document.getElementById("me");
  const rowsEl = document.getElementById("rows");
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

  async function loadPools() {
    rowsEl.innerHTML = `<tr><td colspan="2" style="padding:10px;">Loading...</td></tr>`;
    const data = await fetchJSON("/api/admin/pools?limit=200&offset=0");
    const pools = data.pools || [];

    if (!pools.length) {
      rowsEl.innerHTML = `<tr><td colspan="2" style="padding:10px;">No pools</td></tr>`;
      return;
    }

    rowsEl.innerHTML = pools.map(p => {
      const id = esc(p.id || "—");
      const cap = (p.capacity_max === null || p.capacity_max === undefined) ? "—" : esc(p.capacity_max);
      return `
        <tr style="border-top:1px solid rgba(255,255,255,.12);">
          <td style="padding:10px; font-weight:600;">${id}</td>
          <td style="padding:10px;">${cap}</td>
        </tr>
      `;
    }).join("");
  }

  if (!(await guardSession())) return;
  await loadPools();

  refreshBtn.onclick = () => loadPools().catch(e => alert(e.message));

  logoutBtn.onclick = async () => {
    await fetchJSON("/api/admin/logout", { method: "POST" });
    window.location.href = "/admin/login.html";
  };
});
