// /admin/users.js
async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, { credentials: "include", ...opts });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: "non_json" }; }
  if (!res.ok) throw new Error(data?.error || data?.message || "Request failed");
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
  elErr.textContent = msg || "";
}

function showModalErr(msg) {
  modalErr.style.display = msg ? "block" : "none";
  modalErr.textContent = msg || "";
}

function openModal(mode, user) {
  showModalErr("");
  modal.style.display = "block";
  deleteBtn.style.display = mode === "edit" ? "" : "none";

  if (mode === "new") {
    editingId = null;
    modalTitle.textContent = "New User";
    modalSub.textContent = "Pool read-only user";
    emailInput.value = "";
    passwordInput.value = "";
    activeToggle.checked = true;
    // empty selection
    for (const opt of poolsSelect.options) opt.selected = false;
  } else {
    editingId = user.id;
    modalTitle.textContent = "Edit User";
    modalSub.textContent = user.role === "superadmin" ? "Superadmin" : "Pool read-only user";
    emailInput.value = user.email || "";
    passwordInput.value = "";
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
    document.getElementById("me").textContent = "Connected as " + (me.email || "admin");
    const isSuper = !!me.is_superadmin || String(me.role || "").toLowerCase() === "superadmin";
    if (!isSuper) {
      // server also blocks /admin/users.html, but keep UX clean
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
    tbody.innerHTML = `<tr><td colspan="5" style="padding:12px; opacity:.75;">No users.</td></tr>`;
    return;
  }

  tbody.innerHTML = items.map(u => {
    const pools = (u.pools || []).map(p => esc(p.pool_name || p.pool_id || "")).join(", ") || "—";
    const role = esc(u.role || "pool_readonly");
    const status = u.is_active === false ? "Disabled" : "Active";
    const statusHtml = u.is_active === false ? `<span class="badge danger">${status}</span>` : `<span class="badge success">${status}</span>`;
    const canEdit = (String(u.role || "").toLowerCase() !== "superadmin"); // keep 1 superadmin simple
    return `
      <tr>
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${esc(u.email || "—")}</td>
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${role}</td>
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${statusHtml}</td>
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08);">${pools}</td>
        <td style="padding:10px; border-bottom: 1px solid rgba(0,0,0,.08); text-align:right;">
          <button data-edit="${esc(u.id)}" type="button" ${canEdit ? "" : "disabled"}>Edit</button>
        </td>
      </tr>
    `;
  }).join("");
}

async function loadUsers() {
  showErr("");
  tbody.innerHTML = `<tr><td colspan="5" style="padding:12px; opacity:.75;">Loading...</td></tr>`;
  const r = await fetchJSON("/api/admin/users");
  const items = r.items || [];
  render(items);

  // bind edit buttons
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
  saveBtn.textContent = "Saving...";
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
    saveBtn.textContent = "Save";
  }
}

async function onDelete() {
  showModalErr("");
  if (!editingId) return;
  const confirmText = prompt("Type DELETE to confirm deletion:");
  if (confirmText !== "DELETE") return;

  deleteBtn.disabled = true;
  deleteBtn.textContent = "Deleting...";
  try {
    await fetchJSON("/api/admin/users/" + encodeURIComponent(editingId), { method: "DELETE" });
    closeModal();
    await loadUsers();
  } catch (e) {
    showModalErr(e.message);
  } finally {
    deleteBtn.disabled = false;
    deleteBtn.textContent = "Delete";
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
