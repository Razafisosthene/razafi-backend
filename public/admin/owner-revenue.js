(() => {
  const $ = (id) => document.getElementById(id);

  const els = {
    ownerIdentity: $("ownerIdentity"),
    errorBox: $("errorBox"),
    totalOwner: $("totalOwner"),
    totalPaid: $("totalPaid"),
    totalUnpaid: $("totalUnpaid"),
    payoutCount: $("payoutCount"),
    payoutRows: $("payoutRows"),
    refreshBtn: $("refreshBtn"),
  };

  function esc(v) {
    return String(v ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function displayNameFromEmail(email) {
    const raw = String(email || "").trim();
    if (!raw) return "";
    return raw.includes("@") ? raw.split("@")[0] : raw;
  }

  function money(v) {
    const n = Number(v || 0);
    if (!Number.isFinite(n)) return "0 Ar";
    return `${Math.round(n).toLocaleString("fr-FR")} Ar`;
  }

  function fmtDate(v) {
    if (!v) return "—";
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString("fr-FR");
  }

  function badge(status) {
    const s = String(status || "draft").toLowerCase();
    const cls =
      s === "paid" ? "owner-badge-paid" :
      s === "cancelled" ? "owner-badge-cancelled" :
      "owner-badge-draft";

    const label =
      s === "paid" ? "Payé" :
      s === "cancelled" ? "Annulé" :
      "À payer";

    return `<span class="owner-badge ${cls}">${label}</span>`;
  }

  function showError(msg) {
    if (!els.errorBox) return;
    els.errorBox.style.display = "block";
    els.errorBox.textContent = msg;
  }

  function clearError() {
    if (!els.errorBox) return;
    els.errorBox.style.display = "none";
    els.errorBox.textContent = "";
  }

  function normalizePayload(data) {
    const summary = data.summary || data.totals || {};
    const payouts = Array.isArray(data.payouts) ? data.payouts : (Array.isArray(data.items) ? data.items : []);
    return { summary, payouts };
  }

  function render(data) {
    const owner = data.owner || {};
    const { summary, payouts } = normalizePayload(data);

    const displayName = displayNameFromEmail(owner.email);
    els.ownerIdentity.innerHTML = displayName
      ? `Connecté :<strong>${esc(displayName)}</strong>`
      : "Connecté";

    const totalOwner = summary.total_owner_ar ?? summary.total_earned ?? summary.owner_total_ar ?? 0;
    const totalPaid = summary.total_paid_ar ?? summary.paid ?? 0;
    const totalUnpaid = summary.total_unpaid_ar ?? summary.unpaid ?? 0;
    const payoutCount = summary.payout_count ?? summary.total ?? payouts.length ?? 0;

    els.totalOwner.textContent = money(totalOwner);
    els.totalPaid.textContent = money(totalPaid);
    els.totalUnpaid.textContent = money(totalUnpaid);
    els.payoutCount.textContent = String(payoutCount);

    if (!payouts.length) {
      els.payoutRows.innerHTML = `<tr><td colspan="7" class="owner-empty-state">Aucun payout pour ce propriétaire.</td></tr>`;
      return;
    }

    els.payoutRows.innerHTML = payouts.map((p) => {
      const id = p.id || p.payout_id || "";
      const receiptNumber = p.receipt_number || "";
      const receiptUrl = p.receipt_url || (id ? `/api/admin/revenue/payouts/${encodeURIComponent(id)}/receipt` : "");
      const canReceipt = String(p.status || "").toLowerCase() === "paid" && receiptNumber && receiptUrl;

      return `
        <tr>
          <td>${esc(fmtDate(p.paid_at || p.created_at))}</td>
          <td>${esc(p.pool_name || p.pool?.name || "—")}</td>
          <td><strong>${esc(money(p.gross_total_ar))}</strong></td>
          <td><strong>${esc(money(p.owner_total_ar))}</strong></td>
          <td>${badge(p.status)}</td>
          <td>${receiptNumber ? esc(receiptNumber) : "—"}</td>
          <td>
            ${canReceipt
              ? `<a class="filter-btn primary owner-receipt-link" href="${esc(receiptUrl)}" target="_blank" rel="noopener">Reçu PDF</a>`
              : "—"}
          </td>
        </tr>
      `;
    }).join("");
  }

  async function loadOwnerRevenue() {
    clearError();
    if (els.refreshBtn) {
      els.refreshBtn.disabled = true;
      els.refreshBtn.textContent = "Chargement…";
    }

    try {
      const res = await fetch("/api/owner/revenue", {
        method: "GET",
        credentials: "include",
        headers: { "Accept": "application/json" },
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok || data.ok === false) {
        throw new Error(data.error || `Erreur ${res.status}`);
      }

      render(data);
    } catch (e) {
      showError(`Impossible de charger les revenus propriétaire : ${e.message || e}`);
      els.payoutRows.innerHTML = `<tr><td colspan="7" class="owner-empty-state">Erreur de chargement.</td></tr>`;
    } finally {
      if (els.refreshBtn) {
        els.refreshBtn.disabled = false;
        els.refreshBtn.textContent = "Actualiser";
      }
    }
  }

  els.refreshBtn?.addEventListener("click", loadOwnerRevenue);
  loadOwnerRevenue();
})();
