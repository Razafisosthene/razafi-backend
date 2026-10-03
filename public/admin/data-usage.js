(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const BUSINESS_TZ = "Indian/Antananarivo";
  const THRESHOLD_BYTES = 500_000_000_000n; // 500 GB, decimal
  const state = {
    me: null,
    response: null,
    allPools: [],
    selectedPool: "all",
    selectedMonth: null,
    currentMonth: null,
    minMonth: null,
    historyVisible: Object.create(null),
    yieldPolicyBundle: null,
  };

  async function fetchJSON(url, opts = {}) {
    const res = await fetch(url, { credentials: "include", ...opts });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) {}
    if (!res.ok) {
      const err = new Error(data?.message || data?.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.code = data?.error || null;
      throw err;
    }
    return data;
  }

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  function currentBusinessMonth() {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: BUSINESS_TZ,
      year: "numeric",
      month: "2-digit",
    }).formatToParts(new Date());
    const y = parts.find((p) => p.type === "year")?.value || "";
    const m = parts.find((p) => p.type === "month")?.value || "";
    return /^\d{4}$/.test(y) && /^\d{2}$/.test(m) ? `${y}-${m}` : "";
  }

  function monthDate(monthKey) {
    const m = String(monthKey || "").match(/^(\d{4})-(\d{2})$/);
    return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1, 12, 0, 0)) : null;
  }

  function monthLabel(monthKey) {
    const d = monthDate(monthKey);
    if (!d) return String(monthKey || "");
    return new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" }).format(d);
  }

  function monthName(monthKey) {
    const d = monthDate(monthKey);
    if (!d) return "";
    return new Intl.DateTimeFormat("fr-FR", { month: "long", timeZone: "UTC" }).format(d);
  }

  function dateDayMonth(value) {
    const d = new Date(value);
    if (!Number.isFinite(d.getTime())) return "";
    return new Intl.DateTimeFormat("fr-FR", {
      timeZone: BUSINESS_TZ,
      day: "numeric",
      month: "long",
    }).format(d);
  }

  function dateTimeShort(value) {
    const d = new Date(value);
    if (!Number.isFinite(d.getTime())) return "—";
    return new Intl.DateTimeFormat("fr-FR", {
      timeZone: BUSINESS_TZ,
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
  }

  function safeBigInt(value) {
    try {
      const raw = String(value ?? "0").trim();
      return /^\d+$/.test(raw) ? BigInt(raw) : 0n;
    } catch (_) {
      return 0n;
    }
  }

  function formatDecimal(value, maxDigits = 2) {
    return new Intl.NumberFormat("fr-FR", {
      minimumFractionDigits: 0,
      maximumFractionDigits: maxDigits,
    }).format(value);
  }

  function formatBytes(value) {
    const bytes = safeBigInt(value);
    const n = Number(bytes);
    if (!Number.isFinite(n) || n < 0) return "—";
    if (n >= 1_000_000_000_000) return `${formatDecimal(n / 1_000_000_000_000, 2)} TB`;
    if (n >= 1_000_000_000) return `${formatDecimal(n / 1_000_000_000, 2)} GB`;
    if (n >= 1_000_000) return `${formatDecimal(n / 1_000_000, 1)} MB`;
    if (n >= 1_000) return `${formatDecimal(n / 1_000, 1)} KB`;
    return `${formatDecimal(n, 0)} B`;
  }

  function displayAdminName(me) {
    const raw = String(me?.email || me?.username || "admin").trim();
    return raw.includes("@") ? raw.split("@")[0] : raw;
  }

  function yieldRoleForPool(poolId) {
    if (state.me?.is_superadmin === true) return "superadmin";
    const role = String(state.me?.pool_access?.[String(poolId)] || "").trim().toLowerCase();
    return ["owner", "manager", "viewer"].includes(role) ? role : null;
  }

  function canManageYieldPool(poolId) {
    const role = yieldRoleForPool(poolId);
    return role === "superadmin" || role === "owner";
  }

  function yieldRoleLabel(role) {
    if (role === "superadmin") return "Superadmin";
    if (role === "owner") return "Propriétaire";
    if (role === "manager") return "Manager";
    if (role === "viewer") return "Viewer";
    return "Lecture";
  }

  function yieldClassLabel(value) {
    const key = String(value || "").toLowerCase();
    if (key === "vigilance") return "Vigilance";
    if (key === "protection") return "Protection";
    if (key === "critical") return "Critique";
    return "Normal";
  }

  function yieldCoverageLabel(value) {
    const key = String(value || "").toLowerCase();
    if (key === "complete_cycle") return "Cycle complet";
    if (key === "partial_cycle") return "Cycle partiel";
    return "Pas encore de données";
  }

  function yieldDurationLabel(minutes) {
    const m = Number(minutes);
    if (m === 60) return "1 heure";
    if (m === 1440) return "1 jour";
    if (m === 4320) return "3 jours";
    if (m === 10080) return "7 jours";
    if (m === 43200) return "30 jours";
    if (Number.isFinite(m) && m > 0 && m % 1440 === 0) return `${m / 1440} jours`;
    if (Number.isFinite(m) && m > 0 && m % 60 === 0) return `${m / 60} heures`;
    return `${m || 0} min`;
  }

  function yieldStabilityLabel(minutes) {
    const m = Number(minutes);
    if (m === 60) return "1 heure";
    if (m % 60 === 0) return `${m / 60} heures`;
    return `${m} min`;
  }

  function ensureYieldPolicyModal() {
    let overlay = $("yieldPolicyModal");
    if (overlay) return overlay;

    document.body.insertAdjacentHTML("beforeend", `
      <div id="yieldPolicyModal" class="rz-yield-modal" aria-hidden="true">
        <div class="rz-yield-backdrop" data-yield-close="1"></div>
        <section class="rz-yield-sheet" role="dialog" aria-modal="true" aria-labelledby="yieldPolicyTitle">
          <div class="rz-yield-sheet-head">
            <div>
              <div class="rz-yield-eyebrow">Protection consommation</div>
              <h2 id="yieldPolicyTitle">Protection des forfaits illimités</h2>
            </div>
            <button class="rz-yield-close" type="button" aria-label="Fermer" data-yield-close="1">×</button>
          </div>
          <div id="yieldPolicyContent" class="rz-yield-content">
            <div class="rz-yield-loading">Chargement…</div>
          </div>
        </section>
      </div>
    `);

    overlay = $("yieldPolicyModal");
    overlay.addEventListener("click", (event) => {
      if (event.target.closest("[data-yield-close]")) closeYieldPolicyModal();
      const saveBtn = event.target.closest("[data-yield-save]");
      if (saveBtn) void saveYieldPolicy();
    });

    return overlay;
  }

  function closeYieldPolicyModal() {
    const overlay = $("yieldPolicyModal");
    if (!overlay) return;
    overlay.classList.remove("is-open");
    overlay.setAttribute("aria-hidden", "true");
    document.body.classList.remove("rz-yield-modal-open");
    state.yieldPolicyBundle = null;
  }

  function yieldModalMessage(text, error = false) {
    const el = $("yieldPolicyMsg");
    if (!el) return;
    const msg = String(text || "").trim();
    el.textContent = msg;
    el.classList.toggle("is-visible", !!msg);
    el.classList.toggle("is-error", !!msg && error);
  }

  function renderYieldPolicyModal(bundle) {
    state.yieldPolicyBundle = bundle;
    const content = $("yieldPolicyContent");
    if (!content) return;

    const pool = bundle?.pool || {};
    const policy = bundle?.policy || {};
    const live = bundle?.state || {};
    const mode = bundle?.mode || {};
    const options = bundle?.options || {};
    const features = bundle?.features || {};
    const ppEnabled = features.personalized_plans_enabled === true || pool.personalized_plans_enabled === true;
    const ppConfigAvailable = features.pp_pricing_config_available === true;
    const canManage = bundle?.can_manage === true;
    const activationLocked = mode?.activation_locked !== false;
    const role = String(bundle?.access_role || "");
    const effectiveClass = yieldClassLabel(live?.effective_class);
    const rawClass = yieldClassLabel(live?.raw_class);
    const coverage = yieldCoverageLabel(live?.coverage_status);
    const decisionLabel = live?.decision_ready === true
      ? "Décision automatique prête"
      : "Observation uniquement";

    const speeds = Array.isArray(options.allowed_speeds_mbps)
      ? options.allowed_speeds_mbps.map(Number).filter(Number.isFinite)
      : [];
    if (Number.isFinite(Number(policy.max_unlimited_speed_mbps)) &&
        !speeds.includes(Number(policy.max_unlimited_speed_mbps))) {
      speeds.push(Number(policy.max_unlimited_speed_mbps));
      speeds.sort((a, b) => a - b);
    }

    const durations = Array.isArray(options.duration_options_minutes)
      ? options.duration_options_minutes.map(Number).filter(Number.isFinite)
      : [];
    if (Number.isFinite(Number(policy.max_unlimited_duration_minutes)) &&
        !durations.includes(Number(policy.max_unlimited_duration_minutes))) {
      durations.push(Number(policy.max_unlimited_duration_minutes));
      durations.sort((a, b) => a - b);
    }

    const stabilityOptions = Array.isArray(options.stability_options_minutes)
      ? options.stability_options_minutes.map(Number).filter(Number.isFinite)
      : [60, 180, 360, 720, 1440];

    const disabled = canManage ? "" : "disabled";
    const activationDisabled = (!canManage || activationLocked) ? "disabled" : "";

    content.innerHTML = `
      <div class="rz-yield-pool-name">${esc(pool.display_name || pool.name || "Pool")}</div>
      <div class="rz-yield-pool-meta">${esc(yieldRoleLabel(role))} · Politique actuelle · Révision ${esc(policy.policy_revision || 1)}</div>

      <div class="rz-yield-mode">
        <div>
          <strong>${mode.shadow_mode === true ? "Mode observation" : "Mode actif"}</strong>
          <span>${mode.shadow_mode === true
            ? "RAZAFI calcule la protection, mais ne modifie encore ni la disponibilité des Plans Standards ni les conditions PP Illimité."
            : "Les règles de protection peuvent agir sur les offres illimitées selon les droits de la pool."}</span>
        </div>
        <span class="rz-yield-mode-pill">${mode.shadow_mode === true ? "SHADOW" : "ACTIF"}</span>
      </div>

      <div class="rz-yield-state-grid">
        <div class="rz-yield-state-card"><span>Classe effective</span><strong>${esc(effectiveClass)}</strong></div>
        <div class="rz-yield-state-card"><span>Signal brut</span><strong>${esc(rawClass)}</strong></div>
        <div class="rz-yield-state-card"><span>Couverture</span><strong>${esc(coverage)}</strong></div>
        <div class="rz-yield-state-card"><span>Automatisation</span><strong>${esc(decisionLabel)}</strong></div>
      </div>

      <div id="yieldPolicyMsg" class="rz-yield-msg" role="status" aria-live="polite"></div>

      <div class="rz-yield-form">
        <div class="rz-yield-switch-row">
          <div>
            <label for="yieldEnabled">Protection automatique</label>
            <p>${activationLocked
              ? "Activation verrouillée jusqu’à la validation de la phase Enforcement."
              : "Active les règles automatiques approuvées pour cette pool."}</p>
          </div>
          <label class="rz-yield-switch">
            <input id="yieldEnabled" type="checkbox" ${policy.enabled === true ? "checked" : ""} ${activationDisabled}>
            <span></span>
          </label>
        </div>

        <div class="rz-yield-section">
          <div class="rz-yield-section-head">
            <div>
              <strong>Protection de la pool</strong>
              <span>Commune aux Plans Standards Illimités, avec ou sans Plan Personnalisé.</span>
            </div>
          </div>

          <div class="rz-yield-fields">
            <label class="rz-yield-field">
              <span>Budget du cycle</span>
              <div class="rz-yield-input-unit">
                <input id="yieldBudgetGb" type="number" inputmode="numeric" min="1" max="1000000" step="1" value="${esc(policy.cycle_budget_gb ?? "")}" ${disabled}>
                <b>GB</b>
              </div>
              <small>Ex. 1 000 GB = 1 TB.</small>
            </label>

            <label class="rz-yield-field">
              <span>Réserve protégée</span>
              <div class="rz-yield-input-unit">
                <input id="yieldReservePct" type="number" inputmode="decimal" min="0" max="50" step="0.5" value="${esc(policy.reserve_pct ?? 15)}" ${disabled}>
                <b>%</b>
              </div>
              <small>Part du budget conservée en sécurité.</small>
            </label>

            <label class="rz-yield-field">
              <span>Début du cycle</span>
              <select id="yieldCycleDay" ${disabled}>
                ${Array.from({ length: 31 }, (_, i) => i + 1).map((day) => `<option value="${day}" ${Number(policy.cycle_start_day) === day ? "selected" : ""}>Jour ${day}</option>`).join("")}
              </select>
              <small>RAZAFI adapte automatiquement les mois plus courts.</small>
            </label>

            <label class="rz-yield-field">
              <span>Retour à une classe inférieure</span>
              <select id="yieldStability" ${disabled}>
                ${stabilityOptions.map((minutes) => `<option value="${esc(minutes)}" ${Number(policy.downgrade_stability_minutes) === minutes ? "selected" : ""}>${esc(yieldStabilityLabel(minutes))}</option>`).join("")}
              </select>
              <small>Évite les variations trop fréquentes de protection.</small>
            </label>
          </div>
        </div>

        ${ppEnabled ? `
          <div class="rz-yield-section">
            <div class="rz-yield-section-head">
              <div>
                <strong>Plan Personnalisé — Illimité</strong>
                <span>Ces limites s’ajoutent à la protection commune de la pool.</span>
              </div>
              <span class="rz-yield-feature-badge">PP actif</span>
            </div>

            ${ppConfigAvailable ? `
              <div class="rz-yield-fields">
                <label class="rz-yield-field">
                  <span>Débit max PP Illimité</span>
                  <select id="yieldMaxSpeed" ${disabled}>
                    ${speeds.map((speed) => `<option value="${esc(speed)}" ${Number(policy.max_unlimited_speed_mbps) === speed ? "selected" : ""}>${esc(formatDecimal(speed, 1))} Mbps</option>`).join("")}
                  </select>
                  <small>Plafond Owner, avant règles de protection.</small>
                </label>

                <label class="rz-yield-field">
                  <span>Durée max PP Illimité</span>
                  <select id="yieldMaxDuration" ${disabled}>
                    ${durations.map((minutes) => `<option value="${esc(minutes)}" ${Number(policy.max_unlimited_duration_minutes) === minutes ? "selected" : ""}>${esc(yieldDurationLabel(minutes))}</option>`).join("")}
                  </select>
                  <small>Limite normale définie pour cette pool.</small>
                </label>
              </div>
            ` : `
              <div class="rz-yield-feature-note is-warning">
                PP est actif pour cette pool, mais la configuration tarifaire commune n’est pas disponible. Les paramètres PP restent verrouillés ; la protection commune de la pool peut toujours être enregistrée.
              </div>
            `}
          </div>
        ` : `
          <div class="rz-yield-feature-note">
            <strong>Plan Personnalisé non actif.</strong>
            <span>La protection reste valable pour les Plans Standards Illimités. Aucun paramètre PP n’est requis pour cette pool.</span>
          </div>
        `}

        ${!canManage ? `<div class="rz-yield-readonly">Lecture seule : seul le propriétaire de la pool ou le Superadmin peut modifier cette politique.</div>` : ""}

        <div class="rz-yield-actions">
          <button class="filter-btn" type="button" data-yield-close="1">Fermer</button>
          ${canManage ? `<button class="filter-btn primary" type="button" data-yield-save="1">Enregistrer</button>` : ""}
        </div>
      </div>
    `;
  }

  async function openYieldPolicy(poolId) {
    const id = String(poolId || "").trim();
    if (!id) return;

    const overlay = ensureYieldPolicyModal();
    overlay.classList.add("is-open");
    overlay.setAttribute("aria-hidden", "false");
    document.body.classList.add("rz-yield-modal-open");
    $("yieldPolicyContent").innerHTML = `<div class="rz-yield-loading">Chargement de la politique…</div>`;

    try {
      const bundle = await fetchJSON(`/api/admin/yield-policy?pool_id=${encodeURIComponent(id)}`);
      renderYieldPolicyModal(bundle);
    } catch (err) {
      if (err.status === 401) {
        window.location.href = "/admin/login.html";
        return;
      }
      $("yieldPolicyContent").innerHTML = `
        <div class="rz-yield-error">Impossible de charger la politique de protection pour cette pool.</div>
        <div class="rz-yield-actions"><button class="filter-btn" type="button" data-yield-close="1">Fermer</button></div>
      `;
    }
  }

  async function saveYieldPolicy() {
    const bundle = state.yieldPolicyBundle;
    const poolId = String(bundle?.pool?.id || "").trim();
    if (!poolId || bundle?.can_manage !== true) return;

    const saveBtn = document.querySelector("[data-yield-save]");
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = "Enregistrement…";
    }
    yieldModalMessage("");

    try {
      const payload = {
        policy_revision: Number(bundle.policy?.policy_revision),
        cycle_budget_gb: Number($("yieldBudgetGb")?.value),
        reserve_pct: Number($("yieldReservePct")?.value),
        cycle_start_day: Number($("yieldCycleDay")?.value),
        downgrade_stability_minutes: Number($("yieldStability")?.value),
      };

      const ppEnabled = bundle?.features?.personalized_plans_enabled === true || bundle?.pool?.personalized_plans_enabled === true;
      const ppConfigAvailable = bundle?.features?.pp_pricing_config_available === true;
      if (ppEnabled && ppConfigAvailable && $("yieldMaxSpeed") && $("yieldMaxDuration")) {
        payload.max_unlimited_speed_mbps = Number($("yieldMaxSpeed").value);
        payload.max_unlimited_duration_minutes = Number($("yieldMaxDuration").value);
      }

      if (bundle?.mode?.activation_locked === false) {
        payload.enabled = $("yieldEnabled")?.checked === true;
      }

      const updated = await fetchJSON(`/api/admin/yield-policy/${encodeURIComponent(poolId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      renderYieldPolicyModal(updated);
      yieldModalMessage(updated?.changed === false
        ? "Aucune modification à enregistrer."
        : "Politique enregistrée. L’état Yield a été recalculé.");
    } catch (err) {
      if (err.status === 401) {
        window.location.href = "/admin/login.html";
        return;
      }
      if (err.status === 409 && err.code === "yield_policy_revision_conflict") {
        yieldModalMessage("La politique a changé depuis son ouverture. Fermez puis rouvrez cette fenêtre avant de modifier.", true);
      } else if (err.status === 403) {
        yieldModalMessage("Vous n’êtes pas autorisé à modifier cette politique.", true);
      } else if (err.status === 409 && err.code === "yield_pp_settings_not_applicable") {
        yieldModalMessage("Le Plan Personnalisé n’est pas actif pour cette pool. Les paramètres PP ne peuvent pas être modifiés.", true);
      } else {
        yieldModalMessage("Impossible d’enregistrer la politique. Vérifiez les valeurs et réessayez.", true);
      }
    } finally {
      const currentSaveBtn = document.querySelector("[data-yield-save]");
      if (currentSaveBtn) {
        currentSaveBtn.disabled = false;
        currentSaveBtn.textContent = "Enregistrer";
      }
    }
  }

  function showMessage(text, error = false) {
    const el = $("msg");
    if (!el) return;
    const msg = String(text || "").trim();
    el.textContent = msg;
    el.classList.toggle("is-visible", !!msg);
    el.classList.toggle("is-error", !!msg && error);
  }

  function setBusy(busy) {
    const btn = $("refreshBtn");
    if (!btn) return;
    btn.disabled = !!busy;
    btn.textContent = busy ? "Actualisation…" : "Actualiser";
  }

  function poolName(pool) {
    return String(pool?.pool_display_name || pool?.pool_name || "Pool").trim() || "Pool";
  }

  function periodSentence(pool, response) {
    const selectedMonth = response?.selected_month || state.selectedMonth || "";
    const current = response?.is_current_month === true;
    const complete = pool?.coverage_complete_from_month_start === true;
    const month = monthName(selectedMonth);
    const first = dateDayMonth(pool?.period_first_observed_at || pool?.first_tracking_at);

    if (current && complete) return `utilisés depuis le 1er ${month}`;
    if (current && first) return `suivis depuis le ${first}`;
    if (!current && complete) return `utilisés en ${monthLabel(selectedMonth)}`;
    if (first) return `suivis à partir du ${first}`;
    return `aucune donnée pour ${monthLabel(selectedMonth)}`;
  }

  function coverageNote(pool, response) {
    if (!pool || Number(pool.sample_count || 0) === 0) return "";
    if (pool.coverage_complete_from_month_start === true) return "";
    if (response?.is_current_month === true) return "Suivi commencé en cours de mois";
    return "Historique partiel pour ce mois";
  }

  function monitoringStatus(pool) {
    const samples = Number(pool?.sample_count || 0);
    if (!samples || !pool?.last_observed_at) return { label: "En attente", cls: "waiting" };
    const ageMs = Date.now() - Date.parse(pool.last_observed_at);
    if (Number.isFinite(ageMs) && ageMs > 30 * 60 * 1000) {
      return { label: "Dernier relevé ancien", cls: "waiting" };
    }
    return { label: "Suivi actif", cls: "active" };
  }

  function usageLevel(totalRaw) {
    const total = safeBigInt(totalRaw);
    if (total >= 500_000_000_000n) {
      return { label: "Élevée", cls: "high", note: "500 GB ou plus suivis ce mois" };
    }
    if (total >= 250_000_000_000n) {
      return { label: "Modérée", cls: "medium", note: "Entre 250 GB et 500 GB suivis ce mois" };
    }
    return { label: "Faible", cls: "low", note: "Moins de 250 GB suivis ce mois" };
  }

  function percentOf(partRaw, totalRaw) {
    const part = safeBigInt(partRaw);
    const total = safeBigInt(totalRaw);
    if (total <= 0n) return 0;
    const pct = Number(part * 10_000n / total) / 100;
    return Math.max(0, Math.min(100, pct));
  }

  function attributionPeriodSentence(pool) {
    const a = pool?.attribution || {};
    const first = dateDayMonth(a.first_tracking_at);
    const last = dateTimeShort(a.last_complete_at);
    if (!a.ready) return "Répartition en cours d’initialisation";
    if (first && last !== "—") return `réconciliée depuis le ${first} · dernier calcul ${last}`;
    if (first) return `réconciliée depuis le ${first}`;
    return "répartition disponible sur la période suivie";
  }

  function attributionContentHtml(pool) {
    const a = pool?.attribution || {};
    if (!a.ready) {
      return `
        <section class="rz-du-attribution">
          <div class="rz-du-attribution-note">
            Initialisation en cours. Les compteurs existants servent d’abord de baseline afin de ne pas attribuer artificiellement du trafic passé.
          </div>
        </section>
      `;
    }

    const reconciled = safeBigInt(a.reconciled_wan_bytes);
    const authenticated = safeBigInt(a.authenticated_bytes);
    const freeAccess = safeBigInt(a.free_access_bytes);
    const other = safeBigInt(a.other_bytes);
    const excess = safeBigInt(a.excess_bytes);
    const authPct = percentOf(authenticated, reconciled);
    const freePct = percentOf(freeAccess, reconciled);
    const otherPct = percentOf(other, reconciled);
    const coverageText = `${formatBytes(reconciled)} de trafic WAN ${attributionPeriodSentence(pool)}`;

    return `
      <section class="rz-du-attribution">
        <div class="rz-du-section-head">
          <div class="rz-du-section-sub">${esc(coverageText)}</div>
          ${a.latest_status === "partial" ? `<span class="rz-du-quality waiting">Mise à jour en cours</span>` : `<span class="rz-du-quality">Réconciliée</span>`}
        </div>
        <div class="rz-du-attribution-grid">
          <div class="rz-du-attribution-item">
            <div class="rz-du-attribution-label">Clients authentifiés RAZAFI</div>
            <div class="rz-du-attribution-value">${esc(formatBytes(authenticated))}</div>
            <div class="rz-du-attribution-pct">${esc(formatDecimal(authPct, 1))} %</div>
          </div>
          <div class="rz-du-attribution-item">
            <div class="rz-du-attribution-label">Accès gratuit</div>
            <div class="rz-du-attribution-value">${esc(formatBytes(freeAccess))}</div>
            <div class="rz-du-attribution-pct">${esc(formatDecimal(freePct, 1))} %</div>
          </div>
          <div class="rz-du-attribution-item">
            <div class="rz-du-attribution-label">Autres / non attribué</div>
            <div class="rz-du-attribution-value">${esc(formatBytes(other))}</div>
            <div class="rz-du-attribution-pct">${esc(formatDecimal(otherPct, 1))} %</div>
          </div>
        </div>
        <div class="rz-du-attribution-bar" aria-label="Répartition du trafic réconcilié">
          <span class="auth" style="width:${authPct}%"></span>
          <span class="free" style="width:${freePct}%"></span>
          <span class="other" style="width:${otherPct}%"></span>
        </div>
        ${excess > 0n ? `
          <div class="rz-du-attribution-warn">
            Écart temporaire de synchronisation : ${esc(formatBytes(excess))}. RAZAFI conserve le WAN comme référence et ne crée jamais de valeur « Autres » négative.
          </div>
        ` : ""}
      </section>
    `;
  }

  function nextThresholdInfo(totalRaw) {
    const total = safeBigInt(totalRaw);
    const bandIndex = total / THRESHOLD_BYTES;
    const bandStart = bandIndex * THRESHOLD_BYTES;
    const next = (bandIndex + 1n) * THRESHOLD_BYTES;
    const within = total - bandStart;
    const pct = Number(within * 10_000n / THRESHOLD_BYTES) / 100;
    return { next, pct: Math.max(0, Math.min(100, pct)) };
  }

  function shiftMonth(monthKey, delta) {
    const d = monthDate(monthKey);
    if (!d || !Number.isInteger(delta)) return monthKey;
    d.setUTCMonth(d.getUTCMonth() + delta);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
  }

  function monthCompactLabel(monthKey) {
    const d = monthDate(monthKey);
    if (!d) return "—";
    return new Intl.DateTimeFormat("fr-FR", { month: "long", timeZone: "UTC" }).format(d);
  }

  function monthKeyFromDate(value) {
    const d = new Date(value);
    if (!Number.isFinite(d.getTime())) return null;
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: BUSINESS_TZ,
      year: "numeric",
      month: "2-digit",
    }).formatToParts(d);
    const y = parts.find((p) => p.type === "year")?.value || "";
    const m = parts.find((p) => p.type === "month")?.value || "";
    return /^\d{4}$/.test(y) && /^\d{2}$/.test(m) ? `${y}-${m}` : null;
  }

  function canNavigateMonth(delta) {
    const target = shiftMonth(state.selectedMonth, delta);
    if (!/^\d{4}-\d{2}$/.test(target)) return false;
    if (state.currentMonth && target > state.currentMonth) return false;
    if (state.minMonth && target < state.minMonth) return false;
    return target !== state.selectedMonth;
  }

  function renderMonthNav() {
    const nav = $("monthNav");
    if (!nav) return;
    const prev = shiftMonth(state.selectedMonth, -1);
    const next = shiftMonth(state.selectedMonth, 1);
    const prevDisabled = !canNavigateMonth(-1);
    const nextDisabled = !canNavigateMonth(1);

    nav.innerHTML = `
      <button class="rz-du-month-side prev" type="button" data-month-step="-1" ${prevDisabled ? "disabled" : ""} aria-label="Mois précédent">
        <span class="rz-du-month-arrow">‹</span><span>${esc(monthCompactLabel(prev))}</span>
      </button>
      <div class="rz-du-month-current">
        <span>Mois sélectionné</span>
        <strong>${esc(monthLabel(state.selectedMonth))}</strong>
      </div>
      <button class="rz-du-month-side next" type="button" data-month-step="1" ${nextDisabled ? "disabled" : ""} aria-label="Mois suivant">
        <span>${esc(monthCompactLabel(next))}</span><span class="rz-du-month-arrow">›</span>
      </button>
    `;
  }

  function dailyBars(pool) {
    const days = Array.isArray(pool?.daily) ? pool.daily : [];
    if (!days.length) {
      return `<div class="rz-du-bars-empty">Aucune consommation quotidienne enregistrée pour ce mois.</div>`;
    }

    const values = days.map((row) => safeBigInt(row?.total_bytes));
    let max = 1n;
    for (const value of values) if (value > max) max = value;
    const todayKey = new Intl.DateTimeFormat("en-CA", {
      timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit"
    }).format(new Date());

    return `
      <div class="rz-du-bars-wrap">
        <div class="rz-du-bars" role="img" aria-label="Consommation quotidienne WAN pour ${esc(monthLabel(state.selectedMonth))}">
          ${days.map((row, i) => {
            const v = values[i];
            const pct = Number(v * 10000n / max) / 100;
            const h = v > 0n ? Math.max(3, Math.min(100, pct)) : 1.2;
            const isToday = String(row?.date || "") === todayKey;
            return `
              <div class="rz-du-bar-slot">
                <div class="rz-du-bar ${isToday ? "today" : ""}" style="height:${h}%" title="${esc(row?.date || "")} · ${esc(formatBytes(v))}"></div>
              </div>
            `;
          }).join("")}
        </div>
        <div class="rz-du-bars-axis">
          <span>${esc(days[0]?.date ? days[0].date.slice(8, 10) : "")}</span>
          <span>${esc(days[days.length - 1]?.date ? days[days.length - 1].date.slice(8, 10) : "")}</span>
        </div>
      </div>
    `;
  }

  function metricHtml(label, value) {
    return `
      <div class="rz-du-quick-metric">
        <span>${esc(label)}</span>
        <strong>${esc(value)}</strong>
      </div>
    `;
  }

  function poolOverviewCard(pool, response) {
    const status = monitoringStatus(pool);
    const level = usageLevel(pool?.total_bytes);
    const projection = pool?.projection_ready ? formatBytes(pool.projection_bytes) : "Après 24 h";
    return `
      <button class="rz-du-pool-card" type="button" data-pool-open="${esc(pool.pool_id || "")}">
        <div class="rz-du-pool-card-top">
          <div class="rz-du-pool-card-name">${esc(poolName(pool))}</div>
          <div class="rz-du-pool-card-arrow">›</div>
        </div>
        <div class="rz-du-pool-card-usage">${esc(formatBytes(pool?.total_bytes))}</div>
        <div class="rz-du-pool-card-period">${esc(periodSentence(pool, response))}</div>
        <div class="rz-du-pool-card-meta">
          <span class="rz-du-chip ${status.cls === "active" ? "active" : ""}">${esc(status.label)}</span>
          <span class="rz-du-chip ${esc(level.cls)}">Consommation ${esc(level.label.toLowerCase())}</span>
          <span class="rz-du-pool-card-projection">Projection : ${esc(projection)}</span>
        </div>
      </button>
    `;
  }

  function renderOverview(response) {
    const total = formatBytes(response?.total_all_pools_bytes);
    return `
      <section class="rz-du-overview">
        <div class="rz-du-overview-head">
          <div>
            <div class="rz-du-overview-title">Pools disponibles</div>
            <div class="rz-du-overview-sub">Choisissez une pool pour afficher son récapitulatif et ses détails.</div>
          </div>
          <div class="rz-du-overview-total">
            <span>Total des pools · ${esc(monthLabel(state.selectedMonth))}</span>
            <strong>${esc(total)}</strong>
          </div>
        </div>
        <div class="rz-du-pool-picker">
          ${state.allPools.map((pool) => poolOverviewCard(pool, response)).join("")}
        </div>
      </section>
    `;
  }

  function qualityContentHtml(pool, response) {
    const cNote = coverageNote(pool, response);
    const resets = Number(pool?.counter_reset_count || 0);
    return `
      <div class="rz-du-info-grid">
        <div class="rz-du-info-item"><span>Source</span><strong>WAN MikroTik</strong></div>
        <div class="rz-du-info-item"><span>Dernier relevé</span><strong>${esc(dateTimeShort(pool?.last_observed_at))}</strong></div>
        <div class="rz-du-info-item"><span>Couverture</span><strong>${esc(cNote || "Mois suivi depuis le début")}</strong></div>
        <div class="rz-du-info-item"><span>Échantillons</span><strong>${esc(String(Number(pool?.sample_count || 0)))}</strong></div>
      </div>
      ${resets > 0 ? `
        <div class="rz-du-reset">
          ${esc(String(resets))} redémarrage ou remise à zéro de compteur détecté(e) sur cette période. RAZAFI a poursuivi le suivi avec les deltas valides.
        </div>
      ` : ""}
    `;
  }

  function projectionContentHtml(pool) {
    const threshold = nextThresholdInfo(pool?.total_bytes);
    const thresholdValue = formatBytes(threshold.next);
    const averageNote = pool?.average_ready
      ? "Moyenne calculée sur la période réellement suivie."
      : "La moyenne apparaît après 24 h de données fiables.";
    const projectionNote = pool?.projection_ready
      ? "Projection calculée à partir du rythme observé sur la période suivie."
      : "La projection reste masquée jusqu’à disposer d’au moins 24 h de données fiables.";

    return `
      <div class="rz-du-threshold">
        <div class="rz-du-threshold-row">
          <span>Progression vers ${esc(thresholdValue)}</span>
          <span>${esc(formatDecimal(threshold.pct, 1))} % du palier actuel</span>
        </div>
        <div class="rz-du-progress" aria-hidden="true"><span style="width:${threshold.pct}%"></span></div>
      </div>
      <div class="rz-du-info-grid">
        <div class="rz-du-info-item"><span>Moyenne</span><strong>${esc(averageNote)}</strong></div>
        <div class="rz-du-info-item"><span>Projection</span><strong>${esc(projectionNote)}</strong></div>
      </div>
    `;
  }

  function protectionContentHtml(pool) {
    return `
      <div class="rz-du-protection-row">
        <p>Consultez ou ajustez la protection automatique, le budget du cycle, la réserve et les limites applicables à cette pool.</p>
        <button class="rz-du-yield-btn" type="button" data-yield-policy="${esc(pool.pool_id || "")}">
          ${canManageYieldPool(pool.pool_id) ? "Configurer la protection" : "Voir la protection"}
        </button>
      </div>
    `;
  }

  function historyKey(poolId) {
    return `${state.selectedMonth || ""}:${String(poolId || "")}`;
  }

  function historyVisibleCount(poolId) {
    const key = historyKey(poolId);
    const current = Number(state.historyVisible[key] || 7);
    return Number.isInteger(current) && current > 0 ? current : 7;
  }

  function historyRowsHtml(pool, visibleCount = 7) {
    const days = Array.isArray(pool?.daily) ? pool.daily : [];
    if (!days.length) return `<div class="rz-du-empty">Aucune consommation quotidienne enregistrée pour ce mois.</div>`;

    let max = 1n;
    for (const row of days) {
      const v = safeBigInt(row?.total_bytes);
      if (v > max) max = v;
    }

    const count = Math.min(days.length, Math.max(1, Number(visibleCount || 7)));
    const visible = days.slice(-count).reverse();
    return visible.map((row) => {
      const v = safeBigInt(row?.total_bytes);
      const pct = Number(v * 10_000n / max) / 100;
      const d = new Date(`${row.date}T12:00:00Z`);
      const label = Number.isFinite(d.getTime())
        ? new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short", timeZone: "UTC" }).format(d)
        : row.date;
      return `
        <div class="rz-du-day">
          <div class="rz-du-day-date">${esc(label)}</div>
          <div class="rz-du-day-bar" aria-hidden="true"><span style="width:${Math.max(1, Math.min(100, pct))}%"></span></div>
          <div class="rz-du-day-value">${esc(formatBytes(v))}</div>
        </div>
      `;
    }).join("");
  }

  function historyBlockHtml(pool) {
    const totalDays = Array.isArray(pool?.daily) ? pool.daily.length : 0;
    const visible = Math.min(totalDays, historyVisibleCount(pool.pool_id));
    return `
      <div class="rz-du-history-v2" data-history-block="${esc(pool.pool_id || "")}">
        <div data-history-rows>${historyRowsHtml(pool, visible)}</div>
        ${totalDays > visible ? `
          <div class="rz-du-history-tools">
            <span class="rz-du-history-caption">${esc(String(visible))} jour(s) affiché(s) sur ${esc(String(totalDays))}</span>
            <button class="rz-du-history-more" type="button" data-history-more="${esc(pool.pool_id || "")}">Afficher 7 jours précédents</button>
          </div>
        ` : totalDays ? `
          <div class="rz-du-history-tools"><span class="rz-du-history-caption">Tout le mois est affiché.</span></div>
        ` : ""}
      </div>
    `;
  }

  function renderPoolDetail(pool, response) {
    const status = monitoringStatus(pool);
    const level = usageLevel(pool?.total_bytes);
    const total = safeBigInt(pool?.total_bytes);
    const threshold = nextThresholdInfo(total);
    const hasSamples = Number(pool?.sample_count || 0) > 0;
    const averageValue = pool?.average_ready ? formatBytes(pool.average_daily_bytes) : "Après 24 h";
    const projectionValue = pool?.projection_ready ? formatBytes(pool.projection_bytes) : "Après 24 h";
    const thresholdValue = formatBytes(threshold.next);
    const cNote = coverageNote(pool, response);
    const showBack = state.allPools.length > 1;

    return `
      <section class="rz-du-detail" data-detail-view="1">
        <div class="rz-du-detail-head">
          <div>
            ${showBack ? `<button class="rz-du-back" type="button" data-back-pools="1">‹ Toutes les pools</button>` : ""}
            <div class="rz-du-detail-title">${esc(poolName(pool))}</div>
            <div class="rz-du-detail-meta">Source principale : WAN MikroTik · Dernier relevé ${esc(dateTimeShort(pool.last_observed_at))}</div>
          </div>
          <div class="rz-du-detail-statuses">
            <span class="rz-du-chip ${status.cls === "active" ? "active" : ""}">${esc(status.label)}</span>
            <span class="rz-du-chip ${esc(level.cls)}">Consommation ${esc(level.label.toLowerCase())}</span>
          </div>
        </div>

        <article class="rz-du-card rz-du-summary-card">
          <div class="rz-du-summary-top">
            <div>
              <div class="rz-du-summary-value">${esc(formatBytes(total))}</div>
              <div class="rz-du-summary-period">${esc(periodSentence(pool, response))}</div>
              ${cNote ? `<div class="rz-du-summary-note">${esc(cNote)}</div>` : ""}
            </div>
          </div>

          ${hasSamples ? dailyBars(pool) : `<div class="rz-du-bars-empty">Aucune donnée WAN disponible pour cette pool sur le mois sélectionné.</div>`}

          ${hasSamples ? `
            <div class="rz-du-quick-metrics">
              ${metricHtml("Moyenne / jour", averageValue)}
              ${metricHtml("Projection fin de mois", projectionValue)}
              ${metricHtml("Prochain palier", thresholdValue)}
            </div>
          ` : ""}
        </article>

        ${hasSamples ? `
          <div class="rz-du-accordion-stack">
            <details class="rz-du-accordion">
              <summary>Répartition de la consommation</summary>
              <div class="rz-du-accordion-body">${attributionContentHtml(pool)}</div>
            </details>

            <details class="rz-du-accordion">
              <summary>Projection et paliers</summary>
              <div class="rz-du-accordion-body">${projectionContentHtml(pool)}</div>
            </details>

            <details class="rz-du-accordion">
              <summary>Protection des forfaits illimités</summary>
              <div class="rz-du-accordion-body">${protectionContentHtml(pool)}</div>
            </details>

            <details class="rz-du-accordion">
              <summary>Qualité du suivi</summary>
              <div class="rz-du-accordion-body">${qualityContentHtml(pool, response)}</div>
            </details>

            <details class="rz-du-accordion">
              <summary>Historique quotidien · ${esc(monthLabel(response.selected_month))}</summary>
              <div class="rz-du-accordion-body">${historyBlockHtml(pool)}</div>
            </details>
          </div>
        ` : ""}
      </section>
    `;
  }

  function selectedPoolObject() {
    return state.allPools.find((p) => String(p.pool_id) === String(state.selectedPool)) || null;
  }

  function render() {
    const content = $("dataUsageContent");
    const response = state.response || {};
    renderMonthNav();

    if (!state.allPools.length) {
      content.innerHTML = `<section class="rz-du-card rz-du-empty">Aucune pool disponible pour cette sélection.</section>`;
      return;
    }

    if (state.allPools.length === 1) {
      state.selectedPool = String(state.allPools[0].pool_id || "");
    }

    if (state.selectedPool === "all" && state.allPools.length > 1) {
      content.innerHTML = renderOverview(response);
      return;
    }

    const pool = selectedPoolObject();
    if (!pool) {
      state.selectedPool = state.allPools.length === 1 ? String(state.allPools[0].pool_id || "") : "all";
      render();
      return;
    }
    content.innerHTML = renderPoolDetail(pool, response);
  }

  function syncMonthBounds(response) {
    state.currentMonth = response?.current_month || currentBusinessMonth();
    state.minMonth = response?.global_first_tracking_at
      ? monthKeyFromDate(response.global_first_tracking_at)
      : null;
  }

  async function navigateMonth(delta) {
    if (!canNavigateMonth(delta)) return;
    state.selectedMonth = shiftMonth(state.selectedMonth, delta);
    await loadData();
  }

  function updateHistoryBlock(poolId) {
    const pool = state.allPools.find((p) => String(p.pool_id) === String(poolId));
    const block = document.querySelector(`[data-history-block="${CSS.escape(String(poolId))}"]`);
    if (!pool || !block) return;
    const totalDays = Array.isArray(pool.daily) ? pool.daily.length : 0;
    const visible = Math.min(totalDays, historyVisibleCount(poolId));
    const rows = block.querySelector("[data-history-rows]");
    if (rows) rows.innerHTML = historyRowsHtml(pool, visible);
    const tools = block.querySelector(".rz-du-history-tools");
    if (tools) {
      tools.innerHTML = totalDays > visible
        ? `<span class="rz-du-history-caption">${esc(String(visible))} jour(s) affiché(s) sur ${esc(String(totalDays))}</span><button class="rz-du-history-more" type="button" data-history-more="${esc(poolId)}">Afficher 7 jours précédents</button>`
        : `<span class="rz-du-history-caption">Tout le mois est affiché.</span>`;
    }
  }

  async function loadData() {
    const month = state.selectedMonth || currentBusinessMonth();
    if (!month) return;

    setBusy(true);
    showMessage("");

    try {
      const data = await fetchJSON(`/api/admin/data-usage?month=${encodeURIComponent(month)}`);
      state.response = data;
      state.allPools = Array.isArray(data?.pools) ? data.pools : [];
      state.selectedMonth = data?.selected_month || month;
      syncMonthBounds(data);

      const selectedExists = state.allPools.some((p) => String(p.pool_id) === String(state.selectedPool));
      if (state.allPools.length === 1) {
        state.selectedPool = String(state.allPools[0].pool_id || "");
      } else if (state.selectedPool !== "all" && !selectedExists) {
        state.selectedPool = "all";
      }

      render();
    } catch (err) {
      if (err.status === 401) {
        window.location.href = "/admin/login.html";
        return;
      }
      if (err.status === 403) {
        showMessage("Vous n’avez pas accès à la consommation des données pour cette session.", true);
      } else {
        showMessage("Impossible de charger la consommation des données. Réessayez.", true);
      }
      const content = $("dataUsageContent");
      if (content) content.innerHTML = `<section class="rz-du-card rz-du-empty">Données indisponibles.</section>`;
    } finally {
      setBusy(false);
    }
  }

  async function guardSession() {
    try {
      const me = await fetchJSON("/api/admin/me");
      state.me = me;

      const meEl = $("me");
      meEl.innerHTML = `Connecté :<strong>${esc(displayAdminName(me))}</strong>`;

      if (me?.permissions?.data_usage_view !== true) {
        showMessage("Vous n’avez pas accès à la consommation des données pour cette session.", true);
        $("dataUsageContent").innerHTML = `<section class="rz-du-card rz-du-empty">Accès non autorisé.</section>`;
        return false;
      }
      return true;
    } catch (err) {
      window.location.href = "/admin/login.html";
      return false;
    }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    state.selectedMonth = currentBusinessMonth();

    $("refreshBtn")?.addEventListener("click", loadData);

    $("monthNav")?.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-month-step]");
      if (!btn || btn.disabled) return;
      const delta = Number(btn.getAttribute("data-month-step"));
      if (delta === -1 || delta === 1) void navigateMonth(delta);
    });

    $("dataUsageContent")?.addEventListener("click", (event) => {
      const poolBtn = event.target.closest("[data-pool-open]");
      if (poolBtn) {
        state.selectedPool = String(poolBtn.getAttribute("data-pool-open") || "all");
        render();
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }

      if (event.target.closest("[data-back-pools]")) {
        state.selectedPool = "all";
        render();
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }

      const yieldBtn = event.target.closest("[data-yield-policy]");
      if (yieldBtn) {
        void openYieldPolicy(yieldBtn.getAttribute("data-yield-policy"));
        return;
      }

      const moreBtn = event.target.closest("[data-history-more]");
      if (moreBtn) {
        const poolId = String(moreBtn.getAttribute("data-history-more") || "");
        if (!poolId) return;
        const key = historyKey(poolId);
        state.historyVisible[key] = historyVisibleCount(poolId) + 7;
        updateHistoryBlock(poolId);
      }
    });

    let touchStartX = null;
    let touchStartY = null;
    const content = $("dataUsageContent");
    content?.addEventListener("touchstart", (event) => {
      const t = event.touches?.[0];
      if (!t) return;
      touchStartX = t.clientX;
      touchStartY = t.clientY;
    }, { passive: true });
    content?.addEventListener("touchend", (event) => {
      if (touchStartX === null || touchStartY === null) return;
      const t = event.changedTouches?.[0];
      if (!t) return;
      const dx = t.clientX - touchStartX;
      const dy = t.clientY - touchStartY;
      touchStartX = null;
      touchStartY = null;
      if (Math.abs(dx) < 60 || Math.abs(dx) <= Math.abs(dy) * 1.25) return;
      void navigateMonth(dx < 0 ? 1 : -1);
    }, { passive: true });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeYieldPolicyModal();
    });

    const allowed = await guardSession();
    if (!allowed) return;
    await loadData();
  });
})();
