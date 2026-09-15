/**
 * RAZAFI Financial Reporting V1
 * S14.9.5C — durable FINAL annual-report Owner email worker
 *
 * This module intentionally owns only notification delivery.
 * Annual close / FINAL snapshot creation remains in S14.9.3 / S14.9.4.
 *
 * Safety:
 *   - master flag OFF by default
 *   - real SMTP send flag OFF by default
 *   - queue is populated only from immutable Owner FINAL snapshots
 *   - recipient comes from S14.9.5B queue (historical Owner identity)
 *   - no Manager / Viewer lookup
 *   - no PDF attachment; link goes to authenticated Annual Reports page
 *   - deterministic Message-ID per notification job
 *   - durable claim / sent / retry / dead state stays in PostgreSQL
 */

import nodemailer from "nodemailer";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

const VERSION = "financial-reporting-v1/S14.9.5C-owner-final-email-worker";
const REPORTS_URL =
  String(
    process.env.FINANCIAL_REPORTING_ANNUAL_REPORTS_URL ||
      "https://portal.razafistore.com/admin/annual-reports.html"
  ).trim();

function flag(name, fallback = false) {
  const raw = String(
    process.env[name] ?? (fallback ? "true" : "false")
  )
    .trim()
    .toLowerCase();

  return ["1", "true", "yes", "on"].includes(raw);
}

function boundedInt(name, fallback, min, max) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

const ENABLED = flag(
  "FINANCIAL_REPORTING_FINAL_OWNER_NOTIFICATIONS_ENABLED",
  false
);

const EMAIL_ENABLED = flag(
  "FINANCIAL_REPORTING_FINAL_OWNER_EMAIL_ENABLED",
  false
);

const INTERVAL_MS = boundedInt(
  "FINANCIAL_REPORTING_FINAL_OWNER_NOTIFICATION_INTERVAL_MS",
  5 * 60 * 1000,
  30 * 1000,
  24 * 60 * 60 * 1000
);

const BATCH_SIZE = boundedInt(
  "FINANCIAL_REPORTING_FINAL_OWNER_NOTIFICATION_BATCH_SIZE",
  10,
  1,
  50
);

const SUPERADMIN_ID = String(
  process.env.FINANCIAL_REPORTING_SUPERADMIN_ID || ""
).trim();

const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_ROLE_KEY = String(
  process.env.SUPABASE_SERVICE_ROLE_KEY || ""
).trim();

const SMTP_HOST = String(process.env.SMTP_HOST || "").trim();
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = String(process.env.SMTP_USER || "").trim();
const SMTP_PASS = String(process.env.SMTP_PASS || "").trim();
const MAIL_FROM = String(process.env.MAIL_FROM || SMTP_USER || "").trim();

const WORKER_ID = [
  "annual-final-owner-email",
  String(process.env.RENDER_INSTANCE_ID || "").trim() ||
    String(process.pid),
  crypto.randomUUID().slice(0, 8),
]
  .filter(Boolean)
  .join("-");

let running = false;
let timer = null;
let startupTimer = null;

function log(event, data = {}) {
  console.info(
    "[FINANCIAL REPORTING S14.9.5C]",
    JSON.stringify({
      ts: new Date().toISOString(),
      version: VERSION,
      event,
      ...data,
    })
  );
}

function warn(event, data = {}) {
  console.warn(
    "[FINANCIAL REPORTING S14.9.5C]",
    JSON.stringify({
      ts: new Date().toISOString(),
      version: VERSION,
      event,
      ...data,
    })
  );
}

function requireConfig() {
  if (!SUPABASE_URL) throw new Error("supabase_url_missing");
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("supabase_service_role_key_missing");
  }
  if (!SUPERADMIN_ID) {
    throw new Error("financial_reporting_superadmin_id_missing");
  }
}

function createSupabase() {
  requireConfig();
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function createMailer() {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !MAIL_FROM) {
    return null;
  }

  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeItem(item) {
  return {
    snapshot_id: String(item?.snapshot_id || "").trim() || null,
    report_type: String(item?.report_type || "").trim() || null,
    report_number: String(item?.report_number || "").trim() || null,
    report_revision: Number(item?.report_revision || 0) || null,
    pool_id: String(item?.pool_id || "").trim() || null,
    pool_name: String(item?.pool_name || "").trim() || null,
  };
}

function reportLabel(item) {
  const row = normalizeItem(item);

  if (row.report_type === "owner_consolidated") {
    return "Rapport consolidé — Tous mes pools";
  }

  if (row.report_type === "owner_pool") {
    return row.pool_name
      ? `Rapport par pool — ${row.pool_name}`
      : "Rapport annuel par pool";
  }

  return "Rapport annuel";
}

export function renderAnnualFinalOwnerEmail(job) {
  const year = Number(job?.report_year);
  if (!Number.isInteger(year) || year < 2020 || year > 2100) {
    throw new Error("notification_report_year_invalid");
  }

  const items = Array.isArray(job?.items)
    ? job.items.map(normalizeItem)
    : [];

  if (!items.length) {
    throw new Error("notification_report_items_missing");
  }

  const subject = `Votre rapport annuel FINAL ${year} est disponible`;

  const reportLines = items.map((item) => {
    const number = item.report_number
      ? ` — ${item.report_number}`
      : "";
    return `• ${reportLabel(item)}${number}`;
  });

  const text = [
    "Bonjour,",
    "",
    `Votre rapport annuel FINAL ${year} est maintenant disponible dans votre espace RAZAFI.`,
    "",
    ...(items.length > 1
      ? ["Rapports disponibles :", ...reportLines, ""]
      : []),
    "Vous pouvez le consulter et télécharger le PDF depuis la rubrique « Rapports annuels » :",
    REPORTS_URL,
    "",
    "Ce rapport FINAL est issu d’un snapshot annuel immuable. Toute correction ultérieure apparaîtra sous forme d’une nouvelle révision.",
    "",
    "RAZAFI",
  ].join("\n");

  const listHtml =
    items.length > 1
      ? `
        <div style="margin:22px 0 6px;font-weight:700;color:#111827;">Rapports disponibles</div>
        <ul style="margin:8px 0 22px;padding-left:22px;color:#374151;line-height:1.65;">
          ${items
            .map((item) => {
              const number = item.report_number
                ? ` — ${escapeHtml(item.report_number)}`
                : "";
              return `<li>${escapeHtml(reportLabel(item))}${number}</li>`;
            })
            .join("")}
        </ul>`
      : "";

  const html = `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f5f7fb;font-family:Arial,Helvetica,sans-serif;color:#111827;">
  <div style="max-width:620px;margin:0 auto;padding:32px 18px;">
    <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:22px;padding:30px;box-shadow:0 10px 30px rgba(15,23,42,.06);">
      <div style="font-size:13px;font-weight:800;letter-spacing:.08em;color:#2563eb;margin-bottom:12px;">RAZAFI</div>
      <h1 style="font-size:25px;line-height:1.2;margin:0 0 18px;color:#111827;">
        Votre rapport annuel FINAL ${escapeHtml(year)}
      </h1>
      <p style="font-size:16px;line-height:1.6;margin:0;color:#374151;">
        Votre rapport annuel FINAL est maintenant disponible dans votre espace RAZAFI.
      </p>

      ${listHtml}

      <div style="margin:26px 0;">
        <a href="${escapeHtml(REPORTS_URL)}"
           style="display:inline-block;background:#1677ff;color:#ffffff;text-decoration:none;font-weight:700;padding:14px 20px;border-radius:12px;">
          Voir mes rapports annuels
        </a>
      </div>

      <p style="font-size:13px;line-height:1.6;margin:0;color:#6b7280;">
        Ce rapport FINAL est issu d’un snapshot annuel immuable.
        Toute correction ultérieure apparaîtra sous forme d’une nouvelle révision.
      </p>
    </div>

    <div style="font-size:12px;color:#9ca3af;text-align:center;padding:18px 6px 0;">
      RAZAFI · Notification automatique
    </div>
  </div>
</body>
</html>`;

  return {
    subject,
    text,
    html,
  };
}

async function discoverOwnerFinalYears(supabase) {
  const { data, error } = await supabase
    .from("annual_financial_report_snapshots")
    .select("report_year,report_type")
    .in("report_type", ["owner_consolidated", "owner_pool"])
    .order("report_year", { ascending: true })
    .limit(5000);

  if (error) throw error;

  return Array.from(
    new Set(
      (data || [])
        .map((row) => Number(row?.report_year))
        .filter(
          (year) =>
            Number.isInteger(year) &&
            year >= 2020 &&
            year <= 2100
        )
    )
  ).sort((a, b) => a - b);
}

async function enqueueAvailableFinalOwnerReports(supabase) {
  const years = await discoverOwnerFinalYears(supabase);
  const results = [];

  for (const year of years) {
    const { data, error } = await supabase.rpc(
      "fn_financial_reporting_v1_enqueue_final_owner_notifications",
      {
        p_actor: SUPERADMIN_ID,
        p_year: year,
      }
    );

    if (error) {
      throw new Error(
        `enqueue_final_owner_notifications_failed:${year}:${String(
          error?.message || error
        ).split("\n")[0]}`
      );
    }

    results.push({
      report_year: year,
      ok: data?.ok === true,
      owner_count: Number(data?.owner_count || 0),
      enqueued_count: Number(data?.enqueued_count || 0),
      reused_count: Number(data?.reused_count || 0),
      incomplete_owner_count: Number(
        data?.incomplete_owner_count || 0
      ),
      missing_email_count: Number(
        data?.missing_email_count || 0
      ),
    });
  }

  return results;
}

async function claimJobs(supabase) {
  const { data, error } = await supabase.rpc(
    "fn_financial_reporting_v1_claim_final_owner_notifications",
    {
      p_worker: WORKER_ID,
      p_limit: BATCH_SIZE,
    }
  );

  if (error) throw error;

  return Array.isArray(data?.jobs) ? data.jobs : [];
}

async function markSent(
  supabase,
  notificationId,
  providerMessageId
) {
  const { data, error } = await supabase.rpc(
    "fn_financial_reporting_v1_mark_final_owner_notification_sent",
    {
      p_notification_id: notificationId,
      p_worker: WORKER_ID,
      p_message_id: providerMessageId || null,
    }
  );

  if (error) throw error;
  return data;
}

async function markFailed(
  supabase,
  notificationId,
  errorMessage
) {
  const { data, error } = await supabase.rpc(
    "fn_financial_reporting_v1_mark_final_owner_notification_failed",
    {
      p_notification_id: notificationId,
      p_worker: WORKER_ID,
      p_error: String(errorMessage || "unknown_error").slice(
        0,
        4000
      ),
    }
  );

  if (error) throw error;
  return data;
}

async function sendJob(mailer, job) {
  if (!mailer) throw new Error("smtp_not_configured");

  const to = String(job?.recipient_email || "").trim();
  if (!to) throw new Error("recipient_missing");

  const notificationId = String(
    job?.notification_id || ""
  ).trim();

  if (!notificationId) {
    throw new Error("notification_id_missing");
  }

  const rendered = renderAnnualFinalOwnerEmail(job);

  const token = crypto
    .createHash("sha256")
    .update(notificationId)
    .digest("hex")
    .slice(0, 32);

  const deterministicMessageId =
    `<annual-final-${token}@razafistore.com>`;

  const result = await mailer.sendMail({
    from: MAIL_FROM,
    to,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    messageId: deterministicMessageId,
    headers: {
      "X-RAZAFI-Notification-Type":
        "annual-final-owner-report",
      "X-RAZAFI-Notification-ID": notificationId,
    },
  });

  return String(
    result?.messageId || deterministicMessageId
  );
}

export async function reconcileAnnualFinalReportNotifications(
  reason = "manual"
) {
  if (!ENABLED) {
    return {
      ok: true,
      skipped: "disabled",
    };
  }

  if (running) {
    return {
      ok: true,
      skipped: "already_running",
    };
  }

  running = true;

  try {
    const supabase = createSupabase();

    const enqueueResults =
      await enqueueAvailableFinalOwnerReports(supabase);

    log("enqueue_pass", {
      reason,
      years: enqueueResults,
      email_enabled: EMAIL_ENABLED,
    });

    // UAT/default mode: persist/dedupe queue seeds if eligible snapshots exist,
    // but NEVER claim a job while real SMTP delivery is disabled.
    if (!EMAIL_ENABLED) {
      log("email_send_disabled", {
        reason,
        message:
          "Queue reconciliation completed; no notification job was claimed or sent.",
      });

      return {
        ok: true,
        reason,
        email_enabled: false,
        enqueue_results: enqueueResults,
        claimed: 0,
        sent: 0,
        failed: 0,
      };
    }

    const mailer = createMailer();
    if (!mailer) {
      throw new Error("smtp_not_configured");
    }

    const jobs = await claimJobs(supabase);

    let sent = 0;
    let failed = 0;

    for (const job of jobs) {
      const notificationId = String(
        job?.notification_id || ""
      ).trim();

      try {
        const providerMessageId = await sendJob(
          mailer,
          job
        );

        await markSent(
          supabase,
          notificationId,
          providerMessageId
        );

        sent += 1;

        log("sent", {
          reason,
          notification_id: notificationId,
          report_year: Number(job?.report_year || 0),
          report_count: Number(job?.report_count || 0),
        });
      } catch (error) {
        failed += 1;

        const message = String(
          error?.message || error || "send_failed"
        );

        try {
          await markFailed(
            supabase,
            notificationId,
            message
          );
        } catch (markError) {
          warn("mark_failed_error", {
            reason,
            notification_id: notificationId || null,
            error: String(
              markError?.message || markError
            ),
          });
        }

        warn("send_failed", {
          reason,
          notification_id: notificationId || null,
          report_year: Number(job?.report_year || 0),
          error: message,
        });
      }
    }

    if (jobs.length) {
      log("batch_complete", {
        reason,
        claimed: jobs.length,
        sent,
        failed,
      });
    }

    return {
      ok: failed === 0,
      reason,
      email_enabled: true,
      enqueue_results: enqueueResults,
      claimed: jobs.length,
      sent,
      failed,
    };
  } finally {
    running = false;
  }
}

export function startAnnualFinalReportNotifications() {
  if (!ENABLED) {
    log("disabled", {
      email_enabled: EMAIL_ENABLED,
    });
    return {
      started: false,
      reason: "disabled",
    };
  }

  if (timer || startupTimer) {
    return {
      started: false,
      reason: "already_started",
    };
  }

  log("enabled", {
    worker_id: WORKER_ID,
    email_enabled: EMAIL_ENABLED,
    interval_ms: INTERVAL_MS,
    batch_size: BATCH_SIZE,
    reports_url: REPORTS_URL,
  });

  startupTimer = setTimeout(() => {
    startupTimer = null;

    void reconcileAnnualFinalReportNotifications(
      "startup"
    ).catch((error) => {
      warn("startup_failed", {
        error: String(error?.message || error),
      });
    });
  }, 8000);

  try {
    startupTimer.unref?.();
  } catch (_) {}

  timer = setInterval(() => {
    void reconcileAnnualFinalReportNotifications(
      "interval"
    ).catch((error) => {
      warn("interval_failed", {
        error: String(error?.message || error),
      });
    });
  }, INTERVAL_MS);

  try {
    timer.unref?.();
  } catch (_) {}

  return {
    started: true,
    worker_id: WORKER_ID,
    email_enabled: EMAIL_ENABLED,
    interval_ms: INTERVAL_MS,
    batch_size: BATCH_SIZE,
  };
}
