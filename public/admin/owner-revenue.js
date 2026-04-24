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
      s === "paid" ? "badge-paid" :
      s === "cancelled" ? "badge-cancelled" :
      "badge-draft";

    const label =
      s === "paid" ? "payé" :
      s === "cancelled" ? "annulé" :
      "à payer";

    return `<span class="badge ${cls}">${label}</span>`;
  }

  function showError(msg) {
    els.errorBox.style.display = "block";
    els.errorBox.textContent = msg;
  }

  function clearError() {
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

    els.ownerIdentity.textContent = owner.email
      ? `Connecté comme ${owner.email}`
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
      els.payoutRows.innerHTML = `<tr><td colspan="7" class="empty-state">Aucun payout pour ce propriétaire.</td></tr>`;
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
              ? `<a class="btn btn-receipt" href="${esc(receiptUrl)}" target="_blank" rel="noopener">Reçu PDF</a>`
              : "—"}
          </td>
        </tr>
      `;
    }).join("");
  }

  async function loadOwnerRevenue() {
    clearError();
    els.refreshBtn.disabled = true;
    els.refreshBtn.textContent = "Chargement...";

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
      showError(`Impossible de charger les revenus propriétaire: ${e.message || e}`);
      els.payoutRows.innerHTML = `<tr><td colspan="7" class="empty-state">Erreur de chargement.</td></tr>`;
    } finally {
      els.refreshBtn.disabled = false;
      els.refreshBtn.textContent = "Refresh";
    }
  }

  els.refreshBtn?.addEventListener("click", loadOwnerRevenue);
  loadOwnerRevenue();
})();
