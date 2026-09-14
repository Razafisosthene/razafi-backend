import PDFDocument from "pdfkit";
import { fileURLToPath } from "node:url";

const COLORS = {
  ink: "#101828",
  muted: "#667085",
  line: "#D0D5DD",
  soft: "#F2F4F7",
  brand: "#155EEF",
  ok: "#067647",
  warn: "#B54708",
  warnSoft: "#FFFAEB",
  infoSoft: "#EFF8FF",
};

const RAZAFI_LOGO_PATH = fileURLToPath(
  new URL("./public/admin/assets/img/pdf/RAZAFI.png", import.meta.url),
);
const PDF_FONT_REGULAR_PATH = fileURLToPath(
  new URL("./public/admin/assets/fonts/pdf/DejaVuSans.ttf", import.meta.url),
);
const PDF_FONT_BOLD_PATH = fileURLToPath(
  new URL("./public/admin/assets/fonts/pdf/DejaVuSans-Bold.ttf", import.meta.url),
);

const PAGE = {
  left: 48,
  right: 547,
  width: 499,
  contentTop: 118,
  contentBottom: 720,
};

const safe = (value, fallback = "-") => String(value ?? "").trim() || fallback;
const num = (value) => Number(value) || 0;
const amount = (value) =>
  `${Math.round(num(value)).toLocaleString("fr-FR").replace(/[\u00A0\u202F]/g, " ")} Ar`;

const dateFR = (value) => {
  if (!value) return "-";
  const raw = String(value);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(`${raw}T12:00:00Z`)
    : new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Indian/Antananarivo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
};

const dateTimeFR = (value) => {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Indian/Antananarivo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
};

const monthFR = (value) => {
  if (!value) return "-";
  const raw = String(value);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(`${raw}T12:00:00Z`)
    : new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  const text = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Indian/Antananarivo",
    month: "short",
    year: "numeric",
  }).format(d);
  return text.charAt(0).toUpperCase() + text.slice(1).replace(".", "");
};

const monthKey = (value) => {
  const raw = String(value || "");
  const match = raw.match(/^(\d{4})-(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 12 + Number(match[2]) - 1;
};

const monthFromKey = (key) => {
  if (!Number.isFinite(key)) return "-";
  const year = Math.floor(key / 12);
  const month = (key % 12) + 1;
  return monthFR(`${year}-${String(month).padStart(2, "0")}-01`);
};

const regimeLabel = (value) =>
  ({
    legacy: "Historique",
    commission: "Commission",
    subscription: "Abonnement",
  })[value] || safe(value);

const razafiAmountLabel = (payload) =>
  payload?.document?.scope_type === "platform" ? "REVENU RAZAFI" : "FRAIS RAZAFI";

function typography(doc, font = "Helvetica", size = 10) {
  return doc.font(font).fontSize(size).fillOpacity(1);
}

function baseDocument(payload) {
  const d = payload?.document || {};
  const doc = new PDFDocument({
    size: "A4",
    margin: 48,
    bufferPages: true,
    info: {
      Title: `${safe(d.title, "Rapport annuel RAZAFI")} ${safe(d.year, "")}`.trim(),
      Author: "RAZAFI - RAZAFINDRAMASY Sosthène",
      Subject: "Rapport annuel d’activité et de revenus RAZAFI",
      Creator: "RAZAFI Financial Reporting v1 S14.7.3C.2",
    },
  });

  doc.registerFont("Helvetica", PDF_FONT_REGULAR_PATH);
  doc.registerFont("Helvetica-Bold", PDF_FONT_BOLD_PATH);
  return doc;
}

function drawLogo(doc, compact = false) {
  if (compact) {
    doc.image(RAZAFI_LOGO_PATH, 48, 34, { fit: [92, 31], align: "left", valign: "center" });
    return;
  }
  doc.image(RAZAFI_LOGO_PATH, 48, 39, { fit: [132, 45], align: "left", valign: "center" });
  typography(doc, "Helvetica", 8.2)
    .fillColor(COLORS.muted)
    .text("La plateforme WiFi intelligente", 48, 78, { width: 190, lineGap: 0 });
}

function drawFirstPageHeader(doc, payload) {
  const d = payload.document || {};
  drawLogo(doc, false);

  typography(doc, "Helvetica-Bold", 15.5)
    .fillColor(COLORS.brand)
    .text(safe(d.title, "Rapport annuel"), 255, 41, {
      width: 292,
      align: "right",
      lineGap: 1,
    });

  typography(doc, "Helvetica-Bold", 9.5)
    .fillColor(COLORS.ink)
    .text(`Exercice ${safe(d.year)}`, 330, 82, { width: 217, align: "right", lineGap: 0 });

  doc.moveTo(PAGE.left, 105).lineTo(PAGE.right, 105).lineWidth(1).strokeColor(COLORS.line).stroke();
  doc.y = PAGE.contentTop;
}

function drawContinuationHeader(doc, payload) {
  const d = payload.document || {};
  drawLogo(doc, true);
  typography(doc, "Helvetica-Bold", 9)
    .fillColor(COLORS.ink)
    .text(`${safe(d.title, "Rapport annuel")} · ${safe(d.year)}`, 170, 42, {
      width: 377,
      align: "right",
      lineGap: 0,
    });
  doc.moveTo(PAGE.left, 75).lineTo(PAGE.right, 75).lineWidth(1).strokeColor(COLORS.line).stroke();
  doc.y = 92;
}

function addPage(doc, payload) {
  doc.addPage();
  drawContinuationHeader(doc, payload);
}

function ensureSpace(doc, payload, height) {
  if (doc.y + height > PAGE.contentBottom) addPage(doc, payload);
}

function sectionTitle(doc, payload, title, subtitle = null) {
  ensureSpace(doc, payload, subtitle ? 58 : 40);
  typography(doc, "Helvetica-Bold", 12.5).fillColor(COLORS.ink).text(title, PAGE.left, doc.y, {
    width: PAGE.width,
    lineGap: 0,
  });
  doc.y += 21;
  if (subtitle) {
    typography(doc, "Helvetica", 8.7).fillColor(COLORS.muted).text(subtitle, PAGE.left, doc.y, {
      width: PAGE.width,
      lineGap: 2,
    });
    doc.y += doc.heightOfString(subtitle, { width: PAGE.width, lineGap: 2 }) + 9;
  } else {
    doc.y += 8;
  }
}

function metaBox(doc, payload) {
  const d = payload.document || {};
  const rows = [];

  if (d.scope_type === "owner_consolidated") rows.push(["Portée", "Consolidé propriétaire"]);
  if (d.scope_type === "owner_pool") rows.push(["Portée", `Pool · ${safe(d.pool_name)}`]);
  if (d.scope_type === "platform") rows.push(["Portée", "Plateforme RAZAFI"]);

  if (d.owner_email) rows.push(["Propriétaire", d.owner_email]);
  rows.push(["Période", `${dateFR(d.period_start)} au ${dateFR(d.period_end)}`]);
  rows.push(["Données arrêtées au", dateTimeFR(d.data_cutoff_at)]);
  if (d.report_number) rows.push(["N° rapport", d.report_number]);
  if (d.revision) rows.push(["Révision", `R${String(d.revision).padStart(3, "0")}`]);

  const pairs = Math.ceil(rows.length / 2);
  const height = 20 + pairs * 48;
  doc.roundedRect(PAGE.left, doc.y, PAGE.width, height, 12).fill(COLORS.soft);
  let y = doc.y + 14;
  rows.forEach(([label, value], index) => {
    const left = index % 2 === 0;
    const x = left ? 64 : 310;
    const rowY = y + Math.floor(index / 2) * 48;
    const width = 220;
    typography(doc, "Helvetica", 8.2).fillColor(COLORS.muted).text(label.toUpperCase(), x, rowY, {
      width,
      lineGap: 0,
    });
    typography(doc, "Helvetica-Bold", 9.7).fillColor(COLORS.ink).text(safe(value), x, rowY + 13, {
      width,
      lineGap: 0,
    });
  });

  doc.y += height + 12;
}

function drawProvisionalBanner(doc, payload) {
  if (payload?.document?.mode !== "provisional") return;
  ensureSpace(doc, payload, 48);
  const y = doc.y;
  doc.roundedRect(PAGE.left, y, PAGE.width, 40, 10).fill(COLORS.warnSoft);
  typography(doc, "Helvetica-Bold", 9.6)
    .fillColor(COLORS.warn)
    .text("PROVISOIRE", 64, y + 9, { width: 85, lineGap: 0 });
  typography(doc, "Helvetica", 8.8)
    .fillColor(COLORS.ink)
    .text("Les données peuvent évoluer jusqu’à la clôture de l’exercice.", 150, y + 9, {
      width: 380,
      lineGap: 1,
    });
  doc.y = y + 52;
}

function metricCard(doc, x, y, width, label, value, note = null) {
  const h = note ? 90 : 76;
  doc.roundedRect(x, y, width, h, 12).fill(COLORS.soft);
  typography(doc, "Helvetica", 8.2).fillColor(COLORS.muted).text(label.toUpperCase(), x + 14, y + 13, {
    width: width - 28,
    lineGap: 0,
  });
  typography(doc, "Helvetica-Bold", 16).fillColor(COLORS.ink).text(value, x + 14, y + 33, {
    width: width - 28,
    lineGap: 0,
  });
  if (note) {
    typography(doc, "Helvetica", 7.7).fillColor(COLORS.muted).text(note, x + 14, y + 60, {
      width: width - 28,
      lineGap: 1,
    });
  }
  return h;
}

function renderOwnerSummary(doc, payload) {
  const s = payload?.body?.owner_summary || {};
  sectionTitle(doc, payload, "Synthèse financière");

  // S14.7.3C.2 — Owner clarification:
  // show the sales-linked RAZAFI subtotal, paid subscription and documented
  // RAZAFI total separately so an Owner cannot read the subscription twice.
  //
  // This is presentation-only: every component comes from the canonical
  // document payload. No historical split or business rule is reconstructed.
  const subscriptionPaid = num(s.subscription_fee_paid_ar);
  const subscriptionBilled = num(s.subscription_fee_billed_ar);
  const hasExplicitSalesLinkedComponents =
    Object.prototype.hasOwnProperty.call(s, "legacy_razafi_share_documented_ar") ||
    Object.prototype.hasOwnProperty.call(s, "canonical_commission_revenue_ar");
  const explicitSalesLinkedFees =
    num(s.legacy_razafi_share_documented_ar) +
    num(s.canonical_commission_revenue_ar);
  const salesLinkedFees = hasExplicitSalesLinkedComponents
    ? explicitSalesLinkedFees
    : Math.max(0, num(s.razafi_fees_documented_ar) - subscriptionPaid);
  const hasSubscription = subscriptionPaid > 0 || subscriptionBilled > 0;

  ensureSpace(doc, payload, hasSubscription ? 282 : 192);

  const gap = 11;
  const w = (PAGE.width - gap) / 2;
  const y = doc.y;

  metricCard(
    doc,
    PAGE.left,
    y,
    w,
    "Ventes WiFi reportables",
    amount(s.wifi_sales_reportable_ar),
  );
  metricCard(
    doc,
    PAGE.left + w + gap,
    y,
    w,
    "Frais RAZAFI liés aux ventes",
    amount(salesLinkedFees),
    "Hors abonnement RAZAFI.",
  );

  if (hasSubscription) {
    metricCard(
      doc,
      PAGE.left,
      y + 101,
      w,
      "Abonnement RAZAFI payé",
      amount(subscriptionPaid),
      subscriptionBilled !== subscriptionPaid
        ? `Facturé : ${amount(subscriptionBilled)}`
        : "Inclus dans le total RAZAFI documenté.",
    );
    metricCard(
      doc,
      PAGE.left + w + gap,
      y + 101,
      w,
      "Total RAZAFI documenté",
      amount(s.razafi_fees_documented_ar),
      "Frais liés aux ventes + abonnement payé.",
    );
  }

  const lastRowY = hasSubscription ? y + 202 : y + 101;
  metricCard(
    doc,
    PAGE.left,
    lastRowY,
    w,
    "Part propriétaire documentée",
    amount(s.owner_sales_share_documented_ar),
    "Part issue des ventes documentées ; l’historique non ventilé reste exclu.",
  );
  metricCard(
    doc,
    PAGE.left + w + gap,
    lastRowY,
    w,
    "Historique sans ventilation certifiable",
    amount(s.historical_unallocated_sales_ar),
    "Inclus dans les ventes, mais aucune commission historique n’est extrapolée.",
  );

  doc.y = hasSubscription ? y + 304 : y + 203;
}

function renderPlatformSummary(doc, payload) {
  const s = payload?.body?.platform_summary || {};
  sectionTitle(doc, payload, "Synthèse des revenus RAZAFI");
  ensureSpace(doc, payload, 192);

  const gap = 11;
  const w = (PAGE.width - gap) / 2;
  const y = doc.y;
  metricCard(doc, PAGE.left, y, w, "Revenu RAZAFI documenté", amount(s.razafi_revenue_documented_ar));
  metricCard(doc, PAGE.left + w + gap, y, w, "Ventes WiFi reportables", amount(s.total_wifi_sales_reportable_ar), "Volume d’activité traité, distinct du revenu RAZAFI.");
  metricCard(doc, PAGE.left, y + 87, w, "Commissions canoniques", amount(s.canonical_commission_revenue_ar));
  metricCard(doc, PAGE.left + w + gap, y + 87, w, "Abonnements payés", amount(s.subscription_fee_paid_ar));
  doc.y = y + 190;

  ensureSpace(doc, payload, 52);
  const decompositionY = doc.y;
  doc.roundedRect(PAGE.left, decompositionY, PAGE.width, 42, 10).fill(COLORS.infoSoft);
  typography(doc, "Helvetica-Bold", 8.5).fillColor(COLORS.ink).text("COMPOSITION DU REVENU DOCUMENTÉ", 64, decompositionY + 9, { width: 190 });
  typography(doc, "Helvetica", 8.3)
    .fillColor(COLORS.ink)
    .text(
      `Historique : ${amount(s.legacy_razafi_share_documented_ar)} · Commission : ${amount(s.canonical_commission_revenue_ar)} · Abonnement : ${amount(s.subscription_fee_paid_ar)}`,
      245,
      decompositionY + 9,
      { width: 285, align: "right", lineGap: 0 },
    );
  doc.y = decompositionY + 54;

  ensureSpace(doc, payload, 54);
  const yy = doc.y;
  doc.roundedRect(PAGE.left, yy, PAGE.width, 44, 10).fill(COLORS.warnSoft);
  typography(doc, "Helvetica-Bold", 8.8).fillColor(COLORS.warn).text("HISTORIQUE NON VENTILÉ", 64, yy + 9, { width: 170 });
  typography(doc, "Helvetica", 8.8)
    .fillColor(COLORS.ink)
    .text(`${amount(s.legacy_unallocated_sales_ar)} de ventes restent hors du revenu RAZAFI documenté.`, 230, yy + 9, {
      width: 300,
      align: "right",
    });
  doc.y = yy + 56;
}

function renderPoolSummaries(doc, payload) {
  const rows = Array.isArray(payload?.body?.pool_summaries) ? payload.body.pool_summaries : [];
  if (!rows.length) return;

  sectionTitle(doc, payload, "Détail par pool");
  rows.forEach((r) => {
    ensureSpace(doc, payload, 108);
    const y = doc.y;
    doc.roundedRect(PAGE.left, y, PAGE.width, 92, 12).strokeColor(COLORS.line).lineWidth(1).stroke();
    typography(doc, "Helvetica-Bold", 10.5).fillColor(COLORS.ink).text(safe(r.pool_name), 64, y + 13, { width: 225 });
    typography(doc, "Helvetica", 8).fillColor(COLORS.muted).text(safe(r.radius_nas_id), 64, y + 30, { width: 225 });

    typography(doc, "Helvetica", 7.8).fillColor(COLORS.muted).text("VENTES", 304, y + 13, { width: 95, align: "right" });
    typography(doc, "Helvetica-Bold", 10).fillColor(COLORS.ink).text(amount(r.wifi_sales_reportable_ar), 304, y + 28, { width: 95, align: "right" });
    typography(doc, "Helvetica", 7.8).fillColor(COLORS.muted).text(razafiAmountLabel(payload), 415, y + 13, { width: 115, align: "right" });
    typography(doc, "Helvetica-Bold", 10).fillColor(COLORS.ink).text(amount(r.razafi_revenue_documented_ar), 415, y + 28, { width: 115, align: "right" });

    const line2 = [
      `Transactions : ${Math.round(num(r.transaction_count))}`,
      `Part propriétaire documentée : ${amount(r.owner_sales_share_documented_ar)}`,
      `Historique non ventilé : ${amount(r.historical_unallocated_sales_ar)}`,
    ].join("   ·   ");
    typography(doc, "Helvetica", 8.2).fillColor(COLORS.muted).text(line2, 64, y + 58, { width: 466, lineGap: 0 });
    doc.y = y + 106;
  });
}

function drawTableHeader(doc, columns) {
  const y = doc.y;
  doc.rect(PAGE.left, y, PAGE.width, 26).fill(COLORS.soft);
  columns.forEach((c) => {
    typography(doc, "Helvetica-Bold", 7.3).fillColor(COLORS.muted).text(c.label, c.x, y + 8, {
      width: c.width,
      align: c.align || "left",
      lineGap: 0,
    });
  });
  doc.y = y + 26;
}

function renderMonthlyTable(doc, payload) {
  const rows = Array.isArray(payload?.body?.monthly_detail) ? payload.body.monthly_detail : [];
  if (!rows.length) return;

  sectionTitle(
    doc,
    payload,
    "Détail mensuel",
    "Les montants historiques sans ventilation certifiable restent inclus dans les ventes, sans reconstitution de commission.",
  );

  const columns = [
    { label: "MOIS", x: 54, width: 58 },
    { label: "POOL", x: 116, width: 100 },
    { label: "MODÈLE", x: 220, width: 64 },
    { label: "VENTES", x: 288, width: 77, align: "right" },
    { label: razafiAmountLabel(payload), x: 369, width: 82, align: "right" },
    { label: "NON VENTILÉ", x: 455, width: 84, align: "right" },
  ];

  ensureSpace(doc, payload, 56);
  drawTableHeader(doc, columns);

  rows.forEach((r, index) => {
    if (doc.y + 31 > PAGE.contentBottom) {
      addPage(doc, payload);
      sectionTitle(doc, payload, "Détail mensuel — suite");
      drawTableHeader(doc, columns);
    }

    const y = doc.y;
    if (index % 2 === 1) doc.rect(PAGE.left, y, PAGE.width, 30).fill("#FCFCFD");

    const values = [
      monthFR(r.month),
      safe(r.pool_name),
      regimeLabel(r.regime),
      amount(r.wifi_sales_reportable_ar),
      amount(num(r.razafi_variable_fee_documented_ar) + num(r.subscription_fee_paid_ar)),
      amount(r.historical_unallocated_sales_ar),
    ];

    columns.forEach((c, i) => {
      typography(doc, i === 3 ? "Helvetica-Bold" : "Helvetica", 7.8)
        .fillColor(COLORS.ink)
        .text(values[i], c.x, y + 9, {
          width: c.width,
          align: c.align || "left",
          lineGap: 0,
          ellipsis: true,
        });
    });

    doc.moveTo(PAGE.left, y + 30).lineTo(PAGE.right, y + 30).lineWidth(0.5).strokeColor(COLORS.line).stroke();
    doc.y = y + 30;
  });

  doc.y += 12;
}

function buildModelHistory(rows) {
  const sorted = [...rows]
    .filter((r) => r?.pool_name && r?.month)
    .sort((a, b) => {
      const poolCmp = String(a.pool_name).localeCompare(String(b.pool_name), "fr");
      if (poolCmp !== 0) return poolCmp;
      return (monthKey(a.month) ?? 0) - (monthKey(b.month) ?? 0);
    });

  const groups = [];
  for (const row of sorted) {
    const key = monthKey(row.month);
    if (key === null) continue;
    const last = groups[groups.length - 1];
    if (
      last &&
      last.pool_name === row.pool_name &&
      last.regime === row.regime &&
      last.endKey + 1 === key
    ) {
      last.endKey = key;
      continue;
    }
    groups.push({
      pool_name: row.pool_name,
      regime: row.regime,
      startKey: key,
      endKey: key,
    });
  }
  return groups;
}

function renderModelHistory(doc, payload) {
  const monthly = Array.isArray(payload?.body?.monthly_detail) ? payload.body.monthly_detail : [];
  const groups = buildModelHistory(monthly);
  if (!groups.length) return;

  // S14.7.3C.1: keep this compact section together when it can fit on one
  // continuation page, and reserve enough room for the reading notes below it.
  // This prevents a short model-history block from being split awkwardly over
  // two pages after a long monthly table.
  const continuationCapacity = PAGE.contentBottom - 92;
  const historyHeight = 40 + groups.length * 28 + 8;
  const notesReserve = 150;
  if (
    historyHeight <= continuationCapacity &&
    doc.y + historyHeight + notesReserve > PAGE.contentBottom
  ) {
    addPage(doc, payload);
  }

  sectionTitle(doc, payload, "Historique des modèles économiques");
  groups.forEach((g) => {
    ensureSpace(doc, payload, 34);
    const y = doc.y;
    typography(doc, "Helvetica-Bold", 8.8).fillColor(COLORS.ink).text(safe(g.pool_name), PAGE.left, y, { width: 180 });
    typography(doc, "Helvetica", 8.5).fillColor(COLORS.ink).text(regimeLabel(g.regime), 240, y, { width: 100 });

    // Use a plain ASCII separator for maximum renderer/font portability.
    const period = g.startKey === g.endKey
      ? monthFromKey(g.startKey)
      : `${monthFromKey(g.startKey)} - ${monthFromKey(g.endKey)}`;

    typography(doc, "Helvetica", 8.5).fillColor(COLORS.muted).text(period, 350, y, { width: 197, align: "right" });
    doc.moveTo(PAGE.left, y + 20).lineTo(PAGE.right, y + 20).lineWidth(0.5).strokeColor(COLORS.line).stroke();
    doc.y = y + 28;
  });
  doc.y += 8;
}

function renderNotes(doc, payload) {
  sectionTitle(doc, payload, "Notes de lecture");
  const provisional = payload?.document?.mode === "provisional";
  const notes = [
    "Les ventes historiques sans ventilation certifiable sont conservées dans les ventes reportables mais ne génèrent aucune commission supposée.",
    "Les frais d’abonnement sont distincts des commissions sur ventes et sont présentés séparément lorsqu’ils existent.",
    provisional
      ? `Ce rapport est provisoire et reflète les données disponibles au ${dateTimeFR(payload?.document?.data_cutoff_at)}.`
      : "Ce rapport final est fondé sur un snapshot annuel immuable. Toute correction ultérieure doit faire l’objet d’une nouvelle révision.",
  ];

  notes.forEach((note) => {
    ensureSpace(doc, payload, 34);
    const y = doc.y;
    doc.circle(54, y + 5, 2).fill(COLORS.brand);
    typography(doc, "Helvetica", 8.5).fillColor(COLORS.muted).text(note, 64, y, {
      width: 475,
      lineGap: 2,
    });
    doc.y += doc.heightOfString(note, { width: 475, lineGap: 2 }) + 10;
  });
}

function compactLegalParts(data = {}) {
  const parts = [];
  if (data.brand_name) parts.push(data.brand_name);
  if (data.legal_name) parts.push(data.legal_name);
  if (data.nif) parts.push(`NIF ${data.nif}`);
  if (data.stat) parts.push(`STAT ${data.stat}`);
  if (data.rcs) parts.push(`RCS ${data.rcs}`);
  if (data.legal_address) parts.push(data.legal_address);
  if (data.country && !String(data.legal_address || "").includes(data.country)) parts.push(data.country);
  if (data.phone) parts.push(data.phone);
  if (data.email) parts.push(data.email);
  if (data.website) parts.push(data.website);
  return parts;
}

function renderFooterOnPage(doc, payload, pageIndex, pageCount) {
  const d = payload.document || {};
  const issuer = payload?.footer?.issuer || {};
  const owner = payload?.footer?.owner || {};
  const issuerText = compactLegalParts(issuer).join(" · ");
  const ownerText = compactLegalParts(owner).join(" · ");

  const y = 738;
  doc.moveTo(PAGE.left, y - 8).lineTo(PAGE.right, y - 8).lineWidth(0.7).strokeColor(COLORS.line).stroke();

  typography(doc, "Helvetica", 6.8).fillColor(COLORS.muted);
  const issuerH = Math.min(17, doc.heightOfString(issuerText, { width: PAGE.width, align: "center", lineGap: 0 }));
  doc.text(issuerText, PAGE.left, y, {
    width: PAGE.width,
    height: 17,
    align: "center",
    lineGap: 0,
  });

  let lineY = y + issuerH + 2;
  if (ownerText) {
    const ownerLine = `Propriétaire · ${ownerText}`;
    typography(doc, "Helvetica", 6.6).fillColor(COLORS.muted);
    const ownerH = Math.min(17, doc.heightOfString(ownerLine, { width: PAGE.width, align: "center", lineGap: 0 }));
    doc.text(ownerLine, PAGE.left, lineY, {
      width: PAGE.width,
      height: 17,
      align: "center",
      lineGap: 0,
    });
    lineY += ownerH + 2;
  }

  const reportRef = d.report_number ? `${d.report_number}${d.revision ? ` · R${String(d.revision).padStart(3, "0")}` : ""}` : `Exercice ${safe(d.year)}`;
  typography(doc, "Helvetica", 6.6)
    .fillColor(COLORS.muted)
    .text(`${reportRef} · Page ${pageIndex + 1}/${pageCount}`, PAGE.left, lineY, {
      width: PAGE.width,
      align: "center",
      lineGap: 0,
    });
}

function renderWatermarkOnPage(doc, payload) {
  if (payload?.document?.mode !== "provisional") return;
  doc.save();
  typography(doc, "Helvetica-Bold", 46)
    .fillColor(COLORS.warn)
    .fillOpacity(0.055)
    .rotate(-28, { origin: [300, 430] })
    .text("PROVISOIRE", 85, 400, { width: 430, align: "center", lineGap: 0 });
  doc.restore();
}

function finalizeBufferedPages(doc, payload) {
  const range = doc.bufferedPageRange();
  const pageCount = range.count;
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    renderWatermarkOnPage(doc, payload);
    renderFooterOnPage(doc, payload, i - range.start, pageCount);
  }
}

function renderReport(doc, payload) {
  drawFirstPageHeader(doc, payload);
  metaBox(doc, payload);
  drawProvisionalBanner(doc, payload);

  if (payload?.document?.scope_type === "platform") renderPlatformSummary(doc, payload);
  else renderOwnerSummary(doc, payload);

  renderPoolSummaries(doc, payload);
  renderMonthlyTable(doc, payload);
  renderModelHistory(doc, payload);
  renderNotes(doc, payload);
  finalizeBufferedPages(doc, payload);
}

/**
 * Create a professional annual financial report PDF from the canonical
 * fn_financial_reporting_v1_document_payload() JSON payload.
 *
 * The renderer performs no financial calculations and no RBAC decisions.
 */
export function createFinancialAnnualReportPdf(payload) {
  if (!payload || payload.ok !== true || !payload.document || !payload.body) {
    throw new Error("financial_report_payload_invalid");
  }

  const doc = baseDocument(payload);
  renderReport(doc, payload);
  return doc;
}
