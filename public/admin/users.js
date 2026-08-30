// /admin/users.js — S13.9.2A.3 Multi-Pool RBAC
async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, { credentials: "include", ...opts });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: "non_json" }; }
  if (!res.ok) {
    const err = new Error(data?.error || data?.message || "Requête échouée");
    err.data = data;
    throw err;
  }
  return data;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function adminDisplayName(user) {
  const raw = String(user?.email || user?.username || "admin").trim();
  return raw.includes("@") ? raw.split("@")[0] : raw;
}
function poolName(p) { return String(p?.display_name || p?.pool_display_name || p?.pool_name || p?.name || p?.pool_id || p?.id || "Pool").trim(); }
function accessLabel(role) {
  const r = String(role || "").toLowerCase();
  if (r === "owner") return "Propriétaire";
  if (r === "manager") return "Gestionnaire";
  if (r === "viewer") return "Lecture seule";
  if (r === "superadmin") return "Superadmin";
  return "—";
}
function friendlyError(code) {
  const s = String(code || "").trim();
  const map = {
    non_json: "Réponse serveur invalide.", email_invalid: "Email invalide.", pool_access_required: "Attribuez au moins un pool.",
    rbac_role_invalid: "Rôle de pool invalide.", rbac_pool_user_limit_reached: "Limite d’utilisateurs atteinte pour ce pool.",
    rbac_pool_user_manage_forbidden: "Vous ne pouvez pas gérer les utilisateurs de ce pool.", pool_user_manage_forbidden: "Vous ne pouvez pas gérer les utilisateurs de ce pool.",
    rbac_owner_is_canonical: "Le propriétaire est géré depuis la fiche du pool.", cannot_manage_self_access: "Vous ne pouvez pas modifier votre propre accès.",
    cannot_delete_self: "Vous ne pouvez pas retirer votre propre compte.", owner_transfer_required: "Transférez d’abord les pools dont cet utilisateur est propriétaire.",
    superadmin_account_protected: "Le compte Superadmin est protégé.", user_inactive: "Ce compte est désactivé.",
    password_superadmin_only: "Les utilisateurs de pool utilisent Google uniquement.", google_only_account: "Ce compte utilise Google uniquement."
  };
  return map[s] || s || "Erreur inconnue.";
}

const tbody = document.getElementById("tbody");
const elErr = document.getElementById("err");
const scopeHelp = document.getElementById("scopeHelp");
const modal = document.getElementById("modal");
const modalTitle = document.getElementById("modalTitle");
const modalSub = document.getElementById("modalSub");
const modalErr = document.getElementById("modalErr");
const emailInput = document.getElementById("emailInput");
const activeToggle = document.getElementById("activeToggle");
const activeField = document.getElementById("activeField");
const poolRoleList = document.getElementById("poolRoleList");
const refreshBtn = document.getElementById("refreshBtn");
const newBtn = document.getElementById("newBtn");
const logoutBtn = document.getElementById("logoutBtn");
const closeModalBtn = document.getElementById("closeModalBtn");
const closeModalBtn2 = document.getElementById("closeModalBtn2");
const saveBtn = document.getElementById("saveBtn");
const deleteBtn = document.getElementById("deleteBtn");

let me = null;
let users = [];
let manageablePools = [];
let editingUser = null;
let context = {};

function showErr(msg) { elErr.style.display = msg ? "block" : "none"; elErr.textContent = msg ? friendlyError(msg) : ""; }
function showModalErr(msg) { modalErr.style.display = msg ? "block" : "none"; modalErr.textContent = msg ? friendlyError(msg) : ""; }
function isSuper() { return !!me?.is_superadmin; }
function accessMap(user) { return new Map((user?.pool_access || []).map(x => [String(x.pool_id), x])); }
function isCurrentEffectiveUser(user) { return String(user?.id || "") === String(me?.id || ""); }

function renderPoolRoles(user = null) {
  const map = accessMap(user);
  poolRoleList.innerHTML = manageablePools.map(p => {
    const pid = String(p.id);
    const existing = map.get(pid);
    const role = String(existing?.access_role || "");
    const isOwner = role === "owner" || String(p.owner_admin_user_id || "") === String(user?.id || "");
    const cap = Number.isFinite(Number(p.max_user_count)) ? `${Number(p.current_user_count || 0)}/${Number(p.max_user_count)} utilisateurs` : "Limite dynamique";
    return `<div class="rz-pool-role-row" data-pool-row="${esc(pid)}">
      <div><div class="rz-pool-role-name">${esc(poolName(p))}</div><div class="rz-pool-role-cap">${esc(cap)}</div></div>
      ${isOwner
        ? `<div class="rz-owner-lock">Propriétaire · géré depuis Pools</div>`
        : `<select data-pool-role="${esc(pid)}" data-existing-role="${esc(role)}">
            <option value="" ${!role ? "selected" : ""}>Aucun accès</option>
            <option value="manager" ${role === "manager" ? "selected" : ""}>Gestionnaire</option>
            <option value="viewer" ${role === "viewer" ? "selected" : ""}>Lecture seule</option>
          </select>`}
    </div>`;
  }).join("") || `<div class="rz-empty-state">Aucun pool gérable.</div>`;
}

function openModal(mode, user = null) {
  showModalErr("");
  editingUser = mode === "edit" ? user : null;
  modal.style.display = "block";
  modalTitle.textContent = mode === "new" ? "Nouvel utilisateur" : "Modifier utilisateur";
  modalSub.textContent = mode === "new"
    ? (isSuper() ? "Préautorisez un compte Google. Pour un futur propriétaire, l’attribution se fait ensuite dans Pools." : "Ajoutez un collaborateur à un ou plusieurs de vos pools.")
    : "Les rôles Gestionnaire / Lecture seule sont définis séparément pour chaque pool.";
  emailInput.value = user?.email || "";
  emailInput.disabled = mode === "edit" && !isSuper();
  activeToggle.checked = user?.is_active !== false;
  activeField.style.display = isSuper() && mode === "edit" ? "" : "none";
  deleteBtn.style.display = mode === "edit" && String(user?.role || "").toLowerCase() !== "superadmin" && !isCurrentEffectiveUser(user) ? "" : "none";
  deleteBtn.textContent = isSuper() ? "Désactiver" : "Retirer de mes pools";
  renderPoolRoles(user);
}
function closeModal() { modal.style.display = "none"; editingUser = null; }

function desiredPoolAccess() {
  return [...document.querySelectorAll("select[data-pool-role]")]
    .map(sel => ({ pool_id: sel.dataset.poolRole, access_role: String(sel.value || "") }))
    .filter(x => x.pool_id && ["manager","viewer"].includes(x.access_role));
}

function summarizeAccess(user) {
  if (String(user.role || "").toLowerCase() === "superadmin") return `<span class="rz-role-chip owner">Superadmin plateforme</span>`;
  const rows = user.pool_access || [];
  if (!rows.length) return `<span class="rz-role-chip viewer">Préautorisé · aucun pool</span>`;
  const unique = [...new Set(rows.map(x => String(x.access_role || "")))];
  return unique.map(r => `<span class="rz-role-chip ${esc(r)}">${esc(accessLabel(r))}</span>`).join("");
}

function render(items) {
  if (!items.length) { tbody.innerHTML = `<tr><td colspan="6" class="rz-empty-state">Aucun utilisateur.</td></tr>`; return; }
  tbody.innerHTML = items.map(u => {
    const active = u.is_active !== false;
    const access = (u.pool_access || []).map(x => `<div><span class="rz-role-chip ${esc(x.access_role)}">${esc(accessLabel(x.access_role))}</span>${esc(poolName(x))}</div>`).join("") || "—";
    const auth = String(u.role || "").toLowerCase() === "superadmin" ? "Mot de passe Superadmin" : (u.google_bound ? "Google lié" : "Google · 1re connexion en attente");
    const canEdit = String(u.role || "").toLowerCase() !== "superadmin";
    return `<tr>
      <td><div class="rz-user-email">${esc(u.email || "—")}</div><div class="rz-user-meta">${esc(u.id || "")}</div></td>
      <td>${summarizeAccess(u)}</td>
      <td><span class="rz-status-pill ${active ? "ok" : "off"}">${active ? "Actif" : "Désactivé"}</span></td>
      <td>${esc(auth)}</td>
      <td><div class="rz-user-pools">${access}</div></td>
      <td><div class="rz-actions-cell">
        ${isSuper() && u.can_impersonate ? `<button data-impersonate="${esc(u.id)}" type="button" class="filter-btn">Tester comme</button>` : ""}
        <button data-edit="${esc(u.id)}" type="button" class="filter-btn" ${canEdit ? "" : "disabled"}>Modifier</button>
      </div></td>
    </tr>`;
  }).join("");

  document.querySelectorAll("button[data-edit]").forEach(btn => btn.addEventListener("click", () => {
    const u = users.find(x => String(x.id) === String(btn.dataset.edit)); if (u) openModal("edit", u);
  }));
  document.querySelectorAll("button[data-impersonate]").forEach(btn => btn.addEventListener("click", async () => {
    if (!confirm("Ouvrir RAZAFI comme cet utilisateur pendant 30 minutes ?")) return;
    btn.disabled = true;
    try {
      await fetchJSON("/api/admin/impersonation/start", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ user_id: btn.dataset.impersonate }) });
      window.location.href = "/admin/";
    } catch (e) { showErr(e.message); btn.disabled = false; }
  }));
}

async function loadMe() {
  me = await fetchJSON("/api/admin/me");
  if (me?.permissions?.users_manage !== true) { window.location.href = "/admin/"; throw new Error("redirected"); }
  document.getElementById("me").innerHTML = `Connecté :<strong>${esc(adminDisplayName(me))}</strong>`;
}

async function loadUsers() {
  showErr(""); tbody.innerHTML = `<tr><td colspan="6" class="rz-empty-state">Chargement…</td></tr>`;
  const r = await fetchJSON("/api/admin/users");
  users = r.items || []; manageablePools = r.manageable_pools || []; context = r.context || {};
  scopeHelp.textContent = isSuper()
    ? "Superadmin : créez/préautorisez les comptes. Le propriétaire canonique d’un pool est attribué uniquement depuis Pools. Les collaborateurs utilisent Google uniquement."
    : "Propriétaire : vous pouvez ajouter jusqu’à la limite dynamique de chaque pool. Le propriétaire est inclus dans cette limite. Les collaborateurs utilisent Google uniquement.";
  render(users);
}

async function applyAccessChanges(user) {
  const current = accessMap(user);
  const selects = [...document.querySelectorAll("select[data-pool-role]")];
  for (const sel of selects) {
    const poolId = String(sel.dataset.poolRole || "");
    const desired = String(sel.value || "");
    const before = String(current.get(poolId)?.access_role || "");
    if (desired === before) continue;
    if (desired) {
      await fetchJSON(`/api/admin/users/${encodeURIComponent(user.id)}/pool-access/${encodeURIComponent(poolId)}`, {
        method:"PUT", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ access_role: desired })
      });
    } else if (before && before !== "owner") {
      await fetchJSON(`/api/admin/users/${encodeURIComponent(user.id)}/pool-access/${encodeURIComponent(poolId)}`, { method:"DELETE" });
    }
  }
}

async function onSave() {
  showModalErr("");
  const email = String(emailInput.value || "").trim().toLowerCase();
  if (!email || !email.includes("@")) return showModalErr("email_invalid");
  saveBtn.disabled = true; saveBtn.textContent = "Enregistrement…";
  try {
    if (!editingUser) {
      const pool_access = desiredPoolAccess();
      const r = await fetchJSON("/api/admin/users", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ email, pool_access }) });
      // POST already applies the selected roles atomically per pool via DB RPC.
      if (!r?.user?.id) throw new Error("user_create_failed");
    } else {
      if (isSuper()) {
        const patch = {};
        if (email !== String(editingUser.email || "").toLowerCase()) patch.email = email;
        if (!!activeToggle.checked !== (editingUser.is_active !== false)) patch.is_active = !!activeToggle.checked;
        if (Object.keys(patch).length) {
          await fetchJSON(`/api/admin/users/${encodeURIComponent(editingUser.id)}`, { method:"PATCH", headers:{"Content-Type":"application/json"}, body:JSON.stringify(patch) });
        }
      }
      await applyAccessChanges(editingUser);
    }
    closeModal(); await loadUsers();
  } catch (e) { showModalErr(e.message); }
  finally { saveBtn.disabled = false; saveBtn.textContent = "Enregistrer"; }
}

async function onDelete() {
  if (!editingUser) return;
  const wording = isSuper()
    ? "Désactiver ce compte ? Les historiques seront conservés."
    : "Retirer cet utilisateur de tous les pools que vous possédez ?";
  if (!confirm(wording)) return;
  deleteBtn.disabled = true;
  try {
    await fetchJSON(`/api/admin/users/${encodeURIComponent(editingUser.id)}`, { method:"DELETE" });
    closeModal(); await loadUsers();
  } catch (e) { showModalErr(e.message); }
  finally { deleteBtn.disabled = false; deleteBtn.textContent = isSuper() ? "Désactiver" : "Retirer de mes pools"; }
}

async function logout() { try { await fetchJSON("/api/admin/logout", { method:"POST" }); } catch (_) {} window.location.href = "/admin/login.html"; }

async function boot() {
  await loadMe(); await loadUsers();
  refreshBtn.addEventListener("click", () => loadUsers().catch(e => showErr(e.message)));
  newBtn.addEventListener("click", () => openModal("new")); logoutBtn.addEventListener("click", logout);
  closeModalBtn.addEventListener("click", closeModal); closeModalBtn2.addEventListener("click", closeModal);
  saveBtn.addEventListener("click", onSave); deleteBtn.addEventListener("click", onDelete);
  window.addEventListener("keydown", e => { if (e.key === "Escape" && modal.style.display !== "none") closeModal(); });
}
boot().catch(e => { if (e.message !== "redirected") showErr(e.message); });
