// /admin/users.js
async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, { credentials: "include", ...opts });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: "non_json" }; }
  if (!res.ok) throw new Error(data?.error || data?.message || "Requête échouée");
  return data;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"\']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function uniq(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const s = String(x ?? "").trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function adminDisplayName(user) {
  const raw = String(user?.email || user?.username || "admin").trim();
  return raw.includes("@") ? raw.split("@")[0] : raw;
}

function roleLabel(role) {
  const r = String(role || "pool_readonly").toLowerCase();
  if (r === "superadmin") return "Superadmin";
  if (r === "pool_readonly") return "Lecture seule";
  return role || "Lecture seule";
}

function friendlyError(code) {
  const s = String(code || "").trim();
  const map = {
    non_json: "Réponse serveur invalide.",
    email_invalid: "Email invalide.",
    password_too_short: "Le mot de passe doit contenir au moins 6 caractères.",
    pool_required: "Sélectionnez au moins un pool.",
    redirected: "Redirection…",
  };
  return map[s] || s || "Erreur inconnue.";
}

const elErr = document.getElementById("err");
const tbody = document.getElementById("tbody");

const modal = document.getElementById("modal");
const modalTitle = document.getElementById("modalTitle");
const modalSub = document.getElementById("modalSub");
const modalErr = document.getElementById("modalErr");

const emailInput = document.getElementById("emailInput");
const passwordInput = document.getElementById("passwordInput");
const poolsSelect = document.getElementById("poolsSelect");
const activeToggle = document.getElementById("activeToggle");

const refreshBtn = document.getElementById("refreshBtn");
const newBtn = document.getElementById("newBtn");
const logoutBtn = document.getElementById("logoutBtn");
const closeModalBtn = document.getElementById("closeModalBtn");
const closeModalBtn2 = document.getElementById("closeModalBtn2");
const saveBtn = document.getElementById("saveBtn");
const deleteBtn = document.getElementById("deleteBtn");

let me = null;
let allPools = [];
let editingId = null;

function showErr(msg) {
  elErr.style.display = msg ? "block" : "none";
  elErr.textContent = msg ? friendlyError(msg) : "";
}

function showModalErr(msg) {
  modalErr.style.display = msg ? "block" : "none";
  modalErr.textContent = msg ? friendlyError(msg) : "";
}

function openModal(mode, user) {
  showModalErr("");
  modal.style.display = "block";
  deleteBtn.style.display = mode === "edit" ? "" : "none";

  if (mode === "new") {
    editingId = null;
    modalTitle.textContent = "Nouvel utilisateur";
    modalSub.textContent = "Utilisateur avec accès limité aux pools sélectionnés.";
    emailInput.value = "";
    passwordInput.value = "";
    passwordInput.placeholder = "6 caractères minimum";
    activeToggle.checked = true;
    for (const opt of poolsSelect.options) opt.selected = false;
  } else {
    editingId = user.id;
    modalTitle.textContent = "Modifier utilisateur";
    modalSub.textContent = user.role === "superadmin" ? "Superadmin" : "Utilisateur avec accès limité aux pools sélectionnés.";
    emailInput.value = user.email || "";
    passwordInput.value = "";
    passwordInput.placeholder = "Laisser vide pour garder l’actuel";
    activeToggle.checked = user.is_active !== false;

    const assigned = new Set((user.pools || []).map(p => String(p.pool_id || p.id || "").trim()).filter(Boolean));
    for (const opt of poolsSelect.options) {
      opt.selected = assigned.has(String(opt.value));
    }
  }
}

function closeModal() {
  modal.style.display = "none";
  editingId = null;
}

function selectedPools() {
  const ids = [];
  for (const opt of poolsSelect.options) {
    if (opt.selected) ids.push(opt.value);
  }
  return uniq(ids);
}

async function requireSuperadmin() {
  try {
    me = await fetchJSON("/api/admin/me");
    document.getElementById("me").innerHTML = `Connecté :<strong>${esc(adminDisplayName(me))}</strong>`;
    const isSuper = !!me.is_superadmin || String(me.role || "").toLowerCase() === "superadmin";
    if (!isSuper) {
      window.location.href = "/admin/";
      throw new Error("redirected");
    }
  } catch {
    window.location.href = "/admin/login.html";
    throw new Error("redirected");
  }
}

async function loadPools() {
  const r = await fetchJSON("/api/admin/pools?limit=500&offset=0");
  allPools = (r.pools || r.items || []).map(p => ({
    id: String(p.id || p.pool_id || "").trim(),
    name: p.name || p.pool_name || p.id || ""
  })).filter(p => p.id);

  poolsSelect.innerHTML = allPools.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("\n");
}

function render(items) {
  if (!items.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="rz-empty-state">Aucun utilisateur.</td></tr>`;
    return;
  }

  tbody.innerHTML = items.map(u => {
    const pools = (u.pools || []).map(p => esc(p.pool_name || p.pool_id || "")).join(", ") || "—";
    const role = esc(roleLabel(u.role));
    const active = u.is_active !== false;
    const statusHtml = active
      ? `<span class="rz-status-pill ok">Actif</span>`
      : `<span class="rz-status-pill off">Désactivé</span>`;
    const canEdit = (String(u.role || "").toLowerCase() !== "superadmin");
    return `
      <tr>
        <td><div class="rz-user-email">${esc(u.email || "—")}</div></td>
        <td>${role}</td>
        <td>${statusHtml}</td>
        <td><div class="rz-user-pools">${pools}</div></td>
        <td style="text-align:right;">
          <button data-edit="${esc(u.id)}" type="button" class="filter-btn" style="width:auto;" ${canEdit ? "" : "disabled"}>Modifier</button>
        </td>
      </tr>
    `;
  }).join("");
}

async function loadUsers() {
  showErr("");
  tbody.innerHTML = `<tr><td colspan="5" class="rz-empty-state">Chargement…</td></tr>`;
  const r = await fetchJSON("/api/admin/users");
  const items = r.items || [];
  render(items);

  [...document.querySelectorAll("button[data-edit]")].forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-edit");
      const user = (items || []).find(x => String(x.id) === String(id));
      if (!user) return;
      openModal("edit", user);
    });
  });
}

async function onSave() {
  showModalErr("");
  const email = String(emailInput.value || "").trim().toLowerCase();
  const password = String(passwordInput.value || "");
  const pool_ids = selectedPools();
  const is_active = !!activeToggle.checked;

  if (!email || !email.includes("@")) return showModalErr("email_invalid");
  if (!editingId && (!password || password.length < 6)) return showModalErr("password_too_short");
  if (!pool_ids.length) return showModalErr("pool_required");

  saveBtn.disabled = true;
  saveBtn.textContent = "Enregistrement…";
  try {
    if (!editingId) {
      await fetchJSON("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, pool_ids })
      });
    } else {
      await fetchJSON("/api/admin/users/" + encodeURIComponent(editingId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: password || undefined, is_active })
      });

      await fetchJSON("/api/admin/users/" + encodeURIComponent(editingId) + "/pools", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pool_ids })
      });
    }

    closeModal();
    await loadUsers();
  } catch (e) {
    showModalErr(e.message);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Enregistrer";
  }
}

async function onDelete() {
  showModalErr("");
  if (!editingId) return;
  const confirmText = prompt("Tapez DELETE pour confirmer la suppression :");
  if (confirmText !== "DELETE") return;

  deleteBtn.disabled = true;
  deleteBtn.textContent = "Suppression…";
  try {
    await fetchJSON("/api/admin/users/" + encodeURIComponent(editingId), { method: "DELETE" });
    closeModal();
    await loadUsers();
  } catch (e) {
    showModalErr(e.message);
  } finally {
    deleteBtn.disabled = false;
    deleteBtn.textContent = "Supprimer";
  }
}

async function logout() {
  try {
    await fetchJSON("/api/admin/logout", { method: "POST" });
  } catch (_) {}
  window.location.href = "/admin/login.html";
}

async function boot() {
  await requireSuperadmin();
  await loadPools();
  await loadUsers();

  refreshBtn.addEventListener("click", () => loadUsers().catch(e => showErr(e.message)));
  newBtn.addEventListener("click", () => openModal("new"));
  logoutBtn.addEventListener("click", logout);

  closeModalBtn.addEventListener("click", closeModal);
  closeModalBtn2.addEventListener("click", closeModal);
  saveBtn.addEventListener("click", onSave);
  deleteBtn.addEventListener("click", onDelete);

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.style.display !== "none") closeModal();
  });
}

boot().catch(e => showErr(e.message));
