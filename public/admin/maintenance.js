async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, { credentials: "include", ...opts });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error("Le serveur a répondu avec un format invalide."); }
  if (!res.ok) throw new Error(data?.error || data?.message || data?.details || "Requête impossible.");
  return data;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value = value / 1024;
    idx += 1;
  }
  const decimals = value >= 100 || idx === 0 ? 0 : (value >= 10 ? 1 : 2);
  return `${value.toFixed(decimals)} ${units[idx]}`;
}

function setError(message) {
  const el = document.getElementById("error");
  if (el) el.textContent = message || "";
}

function setResult(message) {
  const el = document.getElementById("result");
  if (!el) return;
  el.style.display = message ? "block" : "none";
  el.textContent = message || "";
}

function setBusy(btn, busy, text) {
  if (!btn) return;
  if (busy) {
    btn.dataset.oldText = btn.textContent || "";
    btn.disabled = true;
    btn.textContent = text || "Patientez…";
  } else {
    btn.disabled = false;
    if (btn.dataset.oldText) btn.textContent = btn.dataset.oldText;
  }
}

async function loadCurrentAdmin() {
  const meEl = document.getElementById("me");
  try {
    const admin = await fetchJSON("/api/admin/me");
    const email = admin?.email || admin?.username || "admin";
    if (meEl) meEl.textContent = email;
    return admin;
  } catch (e) {
    if (meEl) meEl.textContent = "Session indisponible";
    throw e;
  }
}

async function loadUsage() {
  const usageBig = document.getElementById("usageBig");
  const usageSub = document.getElementById("usageSub");
  const usageBar = document.getElementById("usageBar");
  const rows = document.getElementById("tablesRows");

  const data = await fetchJSON("/api/admin/maintenance/usage");
  const used = Number(data.used_bytes || 0);
  const limit = Number(data.limit_bytes || 0);
  const percent = limit > 0 ? (used / limit) * 100 : Number(data.percent || 0);
  const safePercent = Math.max(0, Math.min(100, percent));

  if (usageBig) usageBig.textContent = `Used: ${formatBytes(used)}`;
  if (usageSub) usageSub.textContent = `Limit: ${formatBytes(limit)} · ${percent.toFixed(2)}%`;
  if (usageBar) usageBar.style.width = `${safePercent}%`;

  const tables = Array.isArray(data.tables) ? data.tables.slice() : [];
  tables.sort((a, b) => Number(b.total_bytes || 0) - Number(a.total_bytes || 0));

  if (rows) {
    const top = tables.slice(0, 20);
    rows.innerHTML = top.length
      ? top.map((t) => `
          <tr>
            <td>${esc(t.table_name)}</td>
            <td>${esc(t.total_size || formatBytes(t.total_bytes))}</td>
          </tr>
        `).join("")
      : `<tr><td colspan="2">Aucune table trouvée.</td></tr>`;
  }
}

function renderPreview(items) {
  const list = document.getElementById("previewList");
  if (!list) return;

  if (!Array.isArray(items) || !items.length) {
    list.innerHTML = `<div class="rz-maintenance-muted">Aucune option de nettoyage disponible.</div>`;
    return;
  }

  list.innerHTML = items.map((item) => {
    const disabled = item.error ? "disabled" : "";
    const checked = !item.error && Number(item.count || 0) > 0 ? "checked" : "";
    const meta = item.error
      ? `Erreur: ${item.error}`
      : `${Number(item.count || 0).toLocaleString()} ligne(s) · table ${item.table} · avant ${new Date(item.cutoff_iso).toLocaleString("fr-FR")}`;

    return `
      <label class="rz-maintenance-option">
        <input type="checkbox" data-cleanup-key="${esc(item.key)}" ${checked} ${disabled} />
        <span class="rz-maintenance-option-main">
          <span class="rz-maintenance-option-label">${esc(item.label)}</span>
          <span class="rz-maintenance-option-meta">${esc(meta)}</span>
        </span>
      </label>
    `;
  }).join("");
}

async function loadPreview() {
  const data = await fetchJSON("/api/admin/maintenance/preview");
  renderPreview(data.items || []);
}

function selectedCleanupKeys() {
  return Array.from(document.querySelectorAll("[data-cleanup-key]:checked"))
    .map((el) => String(el.getAttribute("data-cleanup-key") || "").trim())
    .filter(Boolean);
}

async function runCleanup() {
  setError("");
  setResult("");

  const keys = selectedCleanupKeys();
  if (!keys.length) {
    setError("Sélectionne au moins une option à nettoyer.");
    return;
  }

  const confirmation = String(document.getElementById("confirmInput")?.value || "").trim();
  if (confirmation !== "NETTOYER") {
    setError("Tape exactement NETTOYER pour confirmer.");
    return;
  }

  const data = await fetchJSON("/api/admin/maintenance/cleanup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keys, confirmation }),
  });

  const lines = [];
  lines.push(`Nettoyage terminé.`);
  lines.push(`Total supprimé : ${Number(data.total_deleted || 0).toLocaleString()} ligne(s)`);
  lines.push("");

  for (const r of data.results || []) {
    lines.push(`${r.error ? "⚠️" : "✅"} ${r.label}: ${Number(r.deleted || 0).toLocaleString()} supprimée(s)${r.error ? ` — ${r.error}` : ""}`);
  }

  setResult(lines.join("\n"));
  await loadPreview();
  await loadUsage();
}

document.addEventListener("DOMContentLoaded", async () => {
  const refreshUsageBtn = document.getElementById("refreshUsageBtn");
  const previewBtn = document.getElementById("previewBtn");
  const cleanupBtn = document.getElementById("cleanupBtn");

  refreshUsageBtn?.addEventListener("click", async () => {
    try {
      setError("");
      setBusy(refreshUsageBtn, true, "Actualisation…");
      await loadUsage();
    } catch (e) {
      setError(e.message || "Impossible de charger l'utilisation DB.");
    } finally {
      setBusy(refreshUsageBtn, false);
    }
  });

  previewBtn?.addEventListener("click", async () => {
    try {
      setError("");
      setBusy(previewBtn, true, "Analyse…");
      await loadPreview();
    } catch (e) {
      setError(e.message || "Prévisualisation impossible.");
    } finally {
      setBusy(previewBtn, false);
    }
  });

  cleanupBtn?.addEventListener("click", async () => {
    try {
      setBusy(cleanupBtn, true, "Nettoyage…");
      await runCleanup();
    } catch (e) {
      setError(e.message || "Nettoyage impossible.");
    } finally {
      setBusy(cleanupBtn, false);
    }
  });

  try {
    await loadCurrentAdmin();
    await loadUsage();
    await loadPreview();
  } catch (e) {
    setError(e.message || "Maintenance DB indisponible.");
  }
});
