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
        : "Politique enregistrée. Le moteur Shadow a été recalculé.");
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
    if (response?.is_current_month === true) {
      return "Suivi commencé en cours de mois";
    }
    return "Historique partiel pour ce mois";
  }

  function monitoringStatus(pool) {
    const samples = Number(pool?.sample_count || 0);
    if (!samples || !pool?.last_observed_at) return { label: "En attente", cls: "waiting" };
    const ageMs = Date.now() - Date.parse(pool.last_observed_at);
    if (Number.isFinite(ageMs) && ageMs > 30 * 60 * 1000) {
      return { label: "Dernier relevé ancien", cls: "waiting" };
    }
    return { label: "Suivi actif", cls: "" };
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

  function attributionHtml(pool) {
    const a = pool?.attribution || {};
    if (!a.ready) {
      return `
        <section class="rz-du-attribution">
          <div class="rz-du-section-title">Répartition de la consommation</div>
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
          <div>
            <div class="rz-du-section-title">Répartition de la consommation</div>
            <div class="rz-du-section-sub">${esc(coverageText)}</div>
          </div>
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
            <div class="rz-du-attribution-label">Autres non attribué</div>
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

  function dailyChart(pool) {
    const days = Array.isArray(pool?.daily) ? pool.daily : [];
    if (days.length < 2) {
      return `<div class="rz-du-chart-empty">La courbe apparaîtra après au moins deux journées mesurées.</div>`;
    }

    const values = days.map((row) => Number(safeBigInt(row?.total_bytes)));
    const max = Math.max(1, ...values.filter(Number.isFinite));
    const width = 720;
    const height = 180;
    const left = 12;
    const right = 12;
    const top = 14;
    const bottom = 30;
    const plotW = width - left - right;
    const plotH = height - top - bottom;

    const points = values.map((value, i) => {
      const x = days.length === 1 ? left : left + (plotW * i / (days.length - 1));
      const safe = Number.isFinite(value) && value >= 0 ? value : 0;
      const y = top + plotH - (safe / max) * plotH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");

    const firstLabel = days[0]?.date ? days[0].date.slice(8, 10) : "";
    const lastLabel = days[days.length - 1]?.date ? days[days.length - 1].date.slice(8, 10) : "";

    return `
      <div class="rz-du-chart-wrap">
        <svg class="rz-du-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Courbe quotidienne de consommation WAN">
          <line x1="${left}" y1="${top + plotH}" x2="${width - right}" y2="${top + plotH}" class="axis"></line>
          <polyline points="${points}" class="line"></polyline>
          ${values.map((value, i) => {
            const p = points.split(" ")[i].split(",");
            return `<circle cx="${p[0]}" cy="${p[1]}" r="4" class="dot"><title>${esc(days[i]?.date || "")} · ${esc(formatBytes(safeBigInt(days[i]?.total_bytes)))}</title></circle>`;
          }).join("")}
          <text x="${left}" y="${height - 7}" class="label">${esc(firstLabel)}</text>
          <text x="${width - right}" y="${height - 7}" text-anchor="end" class="label">${esc(lastLabel)}</text>
        </svg>
      </div>
    `;
  }

  function nextThresholdInfo(totalRaw) {
    const total = safeBigInt(totalRaw);
    const bandIndex = total / THRESHOLD_BYTES;
    const bandStart = bandIndex * THRESHOLD_BYTES;
    const next = (bandIndex + 1n) * THRESHOLD_BYTES;
    const within = total - bandStart;
    const pct = Number(within * 10_000n / THRESHOLD_BYTES) / 100;
    return {
      next,
      pct: Math.max(0, Math.min(100, pct)),
    };
  }

  function dailyRows(pool) {
    const days = Array.isArray(pool?.daily) ? pool.daily : [];
    if (!days.length) {
      return `<div class="rz-du-empty">Aucune consommation quotidienne enregistrée pour ce mois.</div>`;
    }

    let max = 0n;
    for (const row of days) {
      const v = safeBigInt(row?.total_bytes);
      if (v > max) max = v;
    }
    if (max <= 0n) max = 1n;

    return days.map((row) => {
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

  function metricHtml(label, value, note = "") {
    return `
      <div class="rz-du-metric">
        <div class="rz-du-metric-label">${esc(label)}</div>
        <div class="rz-du-metric-value">${esc(value)}</div>
        ${note ? `<div class="rz-du-metric-note">${esc(note)}</div>` : ""}
      </div>
    `;
  }

  function renderPool(pool, response) {
    const status = monitoringStatus(pool);
    const total = safeBigInt(pool?.total_bytes);
    const threshold = nextThresholdInfo(total);
    const level = usageLevel(total);
    const hasSamples = Number(pool?.sample_count || 0) > 0;

    const averageValue = pool?.average_ready
      ? formatBytes(pool.average_daily_bytes)
      : "Après 24 h";
    const averageNote = pool?.average_ready
      ? "Moyenne sur la période réellement suivie"
      : "Données insuffisantes pour une moyenne fiable";

    const projectionValue = pool?.projection_ready
      ? formatBytes(pool.projection_bytes)
      : "Après 24 h";
    const projectionNote = pool?.projection_ready
      ? "Estimation à partir du rythme observé"
      : "Projection volontairement masquée pour l’instant";

    const thresholdValue = formatBytes(threshold.next);
    const cNote = coverageNote(pool, response);

    return `
      <article class="rz-du-card rz-du-pool" data-pool-id="${esc(pool.pool_id || "")}">
        <div class="rz-du-pool-head">
          <div>
            <div class="rz-du-pool-name">${esc(poolName(pool))}</div>
            <div class="rz-du-pool-sub">Source principale : WAN MikroTik · Dernier relevé ${esc(dateTimeShort(pool.last_observed_at))}</div>
          </div>
          <div class="rz-du-pool-actions">
            <span class="rz-du-status ${esc(status.cls)}">${esc(status.label)}</span>
            <button
              class="rz-du-yield-btn"
              type="button"
              data-yield-policy="${esc(pool.pool_id || "")}"
            >
              ${canManageYieldPool(pool.pool_id) ? "Configurer la protection" : "Voir la protection"}
            </button>
          </div>
        </div>

        <div class="rz-du-hero">
          <div class="rz-du-value">${esc(formatBytes(total))}</div>
          <div class="rz-du-period">${esc(periodSentence(pool, response))}</div>
          <div class="rz-du-level ${esc(level.cls)}" title="${esc(level.note)}">
            Niveau de consommation : ${esc(level.label)}
          </div>
          ${cNote ? `<div class="rz-du-coverage">${esc(cNote)}</div>` : ""}
        </div>

        ${hasSamples ? `
          <div class="rz-du-metrics">
            ${metricHtml("Moyenne / jour", averageValue, averageNote)}
            ${metricHtml("Projection fin de mois", projectionValue, projectionNote)}
            ${metricHtml("Prochain palier RAZAFI", thresholdValue, "Paliers de suivi tous les 500 GB")}
          </div>

          <div class="rz-du-threshold">
            <div class="rz-du-threshold-row">
              <span>Progression vers ${esc(thresholdValue)}</span>
              <span>${esc(formatDecimal(threshold.pct, 1))} % du palier actuel</span>
            </div>
            <div class="rz-du-progress" aria-hidden="true">
              <span style="width:${threshold.pct}%"></span>
            </div>
          </div>

          ${Number(pool.counter_reset_count || 0) > 0 ? `
            <div class="rz-du-reset">
              ${esc(String(pool.counter_reset_count))} redémarrage ou remise à zéro de compteur détecté(e) sur cette période.
              RAZAFI a poursuivi le suivi avec les deltas valides.
            </div>
          ` : ""}

          ${attributionHtml(pool)}

          <details class="rz-du-history">
            <summary>Historique quotidien · ${esc(monthLabel(response.selected_month))}</summary>
            <div class="rz-du-history-body">
              ${dailyChart(pool)}
              ${dailyRows(pool)}
            </div>
          </details>
        ` : `
          <div class="rz-du-empty">Aucune donnée WAN disponible pour cette pool sur le mois sélectionné.</div>
        `}
      </article>
    `;
  }

  function visiblePools() {
    if (state.selectedPool === "all") return state.allPools.slice();
    return state.allPools.filter((p) => String(p.pool_id) === String(state.selectedPool));
  }

  function render() {
    const response = state.response || {};
    const list = $("poolList");
    const pools = visiblePools();

    if (!pools.length) {
      list.innerHTML = `<section class="rz-du-card rz-du-empty">Aucune pool disponible pour cette sélection.</section>`;
    } else {
      list.innerHTML = pools.map((p) => renderPool(p, response)).join("");
    }

    const global = $("globalSummary");
    const globalTotal = $("globalTotal");
    const globalNote = $("globalNote");
    const showGlobal = state.selectedPool === "all" && state.allPools.length > 1;

    global.classList.toggle("is-visible", showGlobal);
    if (showGlobal) {
      globalTotal.textContent = formatBytes(response.total_all_pools_bytes);
      globalNote.textContent = response.is_current_month
        ? "Vue consolidée. Les cartes ci-dessous restent la référence pour suivre chaque pool individuellement."
        : `Total consolidé pour ${monthLabel(response.selected_month)}.`;
    }
  }

  function syncPoolFilter() {
    const select = $("poolFilter");
    const previous = state.selectedPool;
    select.innerHTML = `<option value="all">Tous les pools</option>` +
      state.allPools.map((p) => `<option value="${esc(p.pool_id)}">${esc(poolName(p))}</option>`).join("");

    if (previous !== "all" && state.allPools.some((p) => String(p.pool_id) === String(previous))) {
      select.value = previous;
    } else {
      state.selectedPool = "all";
      select.value = "all";
    }
  }

  function syncMonthBounds(response) {
    const picker = $("monthPicker");
    const current = response?.current_month || currentBusinessMonth();
    if (current) picker.max = current;

    if (response?.global_first_tracking_at) {
      const d = new Date(response.global_first_tracking_at);
      if (Number.isFinite(d.getTime())) {
        const parts = new Intl.DateTimeFormat("en-CA", {
          timeZone: BUSINESS_TZ,
          year: "numeric",
          month: "2-digit",
        }).formatToParts(d);
        const y = parts.find((p) => p.type === "year")?.value || "";
        const m = parts.find((p) => p.type === "month")?.value || "";
        if (/^\d{4}$/.test(y) && /^\d{2}$/.test(m)) picker.min = `${y}-${m}`;
      }
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
      $("monthPicker").value = state.selectedMonth;

      syncMonthBounds(data);
      syncPoolFilter();
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
      $("poolList").innerHTML = `<section class="rz-du-card rz-du-empty">Données indisponibles.</section>`;
      $("globalSummary").classList.remove("is-visible");
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
        $("poolList").innerHTML = `<section class="rz-du-card rz-du-empty">Accès non autorisé.</section>`;
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
    $("monthPicker").value = state.selectedMonth;

    $("refreshBtn").addEventListener("click", loadData);
    $("poolList").addEventListener("click", (event) => {
      const btn = event.target.closest("[data-yield-policy]");
      if (!btn) return;
      void openYieldPolicy(btn.getAttribute("data-yield-policy"));
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeYieldPolicyModal();
    });

    $("monthPicker").addEventListener("change", () => {
      const value = String($("monthPicker").value || "").trim();
      if (!/^\d{4}-\d{2}$/.test(value)) return;
      state.selectedMonth = value;
      state.selectedPool = "all";
      loadData();
    });
    $("poolFilter").addEventListener("change", () => {
      state.selectedPool = String($("poolFilter").value || "all");
      render();
    });

    const allowed = await guardSession();
    if (!allowed) return;
    await loadData();
  });
})();
