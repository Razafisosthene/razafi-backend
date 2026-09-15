/**
 * RAZAFI Financial Reporting V1
 * S14.9.5D — controlled SMTP UAT for FINAL annual Owner notification
 *
 * Sends exactly ONE clearly marked test email through the real SMTP transport.
 * It does not call Supabase, does not touch FINAL snapshots, and does not
 * create/claim/update notification queue jobs.
 *
 * Required:
 *   FINANCIAL_REPORTING_FINAL_OWNER_EMAIL_UAT_ENABLED=true
 *   FINANCIAL_REPORTING_FINAL_OWNER_EMAIL_UAT_CONFIRM=SEND_ONE_TEST_EMAIL
 *   FINANCIAL_REPORTING_FINAL_OWNER_EMAIL_UAT_TO=<explicit test address>
 *
 * Production delivery MUST remain disabled:
 *   FINANCIAL_REPORTING_FINAL_OWNER_EMAIL_ENABLED=false
 */

import nodemailer from "nodemailer";
import crypto from "node:crypto";
import { renderAnnualFinalOwnerEmail } from "./annual-final-report-notifications.js";

const VERSION = "financial-reporting-v1/S14.9.5D-controlled-smtp-uat";

function env(name) {
  return String(process.env[name] || "").trim();
}

function flag(name, fallback = false) {
  const raw = String(
    process.env[name] ?? (fallback ? "true" : "false")
  ).trim().toLowerCase();

  return ["1", "true", "yes", "on"].includes(raw);
}

function fail(code, data = {}) {
  console.error(
    "[FINANCIAL REPORTING S14.9.5D]",
    JSON.stringify({
      ts: new Date().toISOString(),
      version: VERSION,
      event: "failed",
      code,
      ...data,
    })
  );
  process.exit(1);
}

function log(event, data = {}) {
  console.log(
    "[FINANCIAL REPORTING S14.9.5D]",
    JSON.stringify({
      ts: new Date().toISOString(),
      version: VERSION,
      event,
      ...data,
    })
  );
}

function maskEmail(value) {
  const email = String(value || "").trim();
  const at = email.indexOf("@");

  if (at <= 1) return "***";

  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const shown = local.slice(0, Math.min(2, local.length));

  return `${shown}${"*".repeat(Math.max(3, local.length - shown.length))}@${domain}`;
}

function assertSimpleEmail(value) {
  const email = String(value || "").trim();

  if (
    !email ||
    email.length > 254 ||
    /\s/.test(email) ||
    !/^[^@]+@[^@]+\.[^@]+$/.test(email)
  ) {
    fail("uat_recipient_invalid");
  }

  return email;
}

function injectTestBanner(html) {
  const banner = `
  <div style="max-width:620px;margin:18px auto 0;padding:0 18px;">
    <div style="background:#fff7ed;border:1px solid #fdba74;color:#9a3412;border-radius:14px;padding:12px 15px;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;line-height:1.45;">
      TEST SMTP RAZAFI — Ceci est un test technique. Aucun rapport FINAL réel n’a été créé ni modifié.
    </div>
  </div>`;

  return html.replace(/(<body[^>]*>)/i, `$1${banner}`);
}

async function main() {
  const uatEnabled = flag(
    "FINANCIAL_REPORTING_FINAL_OWNER_EMAIL_UAT_ENABLED",
    false
  );

  const productionEmailEnabled = flag(
    "FINANCIAL_REPORTING_FINAL_OWNER_EMAIL_ENABLED",
    false
  );

  const confirm = env(
    "FINANCIAL_REPORTING_FINAL_OWNER_EMAIL_UAT_CONFIRM"
  );

  if (!uatEnabled) {
    fail("uat_not_enabled");
  }

  if (productionEmailEnabled) {
    fail("production_email_must_remain_disabled_for_uat");
  }

  if (confirm !== "SEND_ONE_TEST_EMAIL") {
    fail("uat_confirmation_missing_or_invalid");
  }

  const recipient = assertSimpleEmail(
    env("FINANCIAL_REPORTING_FINAL_OWNER_EMAIL_UAT_TO")
  );

  const smtpHost = env("SMTP_HOST");
  const smtpPort = Number(env("SMTP_PORT") || 587);
  const smtpUser = env("SMTP_USER");
  const smtpPass = env("SMTP_PASS");
  const mailFrom = env("MAIL_FROM") || smtpUser;

  if (!smtpHost) fail("smtp_host_missing");
  if (!Number.isFinite(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
    fail("smtp_port_invalid");
  }
  if (!smtpUser) fail("smtp_user_missing");
  if (!smtpPass) fail("smtp_pass_missing");
  if (!mailFrom) fail("mail_from_missing");

  const reportYearRaw =
    env("FINANCIAL_REPORTING_FINAL_OWNER_EMAIL_UAT_YEAR") ||
    String(new Date().getUTCFullYear());

  const reportYear = Number(reportYearRaw);

  if (
    !Number.isInteger(reportYear) ||
    reportYear < 2020 ||
    reportYear > 2100
  ) {
    fail("uat_report_year_invalid", {
      supplied: reportYearRaw,
    });
  }

  const testJob = {
    report_year: reportYear,
    items: [
      {
        snapshot_id: null,
        report_type: "owner_pool",
        report_number: null,
        report_revision: 1,
        pool_id: null,
        pool_name: "TEST SMTP — aucune donnée réelle",
      },
    ],
  };

  const rendered = renderAnnualFinalOwnerEmail(testJob);

  const subject = `[TEST RAZAFI] ${rendered.subject}`;
  const text = [
    "TEST SMTP RAZAFI — Ceci est un test technique.",
    "Aucun rapport FINAL réel n’a été créé ni modifié.",
    "",
    rendered.text,
  ].join("\n");
  const html = injectTestBanner(rendered.html);

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: {
      user: smtpUser,
      pass: smtpPass,
    },
  });

  log("preflight_pass", {
    recipient: maskEmail(recipient),
    report_year: reportYear,
    production_email_enabled: productionEmailEnabled,
    queue_access: false,
    supabase_access: false,
    has_attachment: false,
    has_cc: false,
    has_bcc: false,
  });

  const result = await transporter.sendMail({
    from: mailFrom,
    to: recipient,
    subject,
    text,
    html,
    messageId: `<annual-final-uat-${crypto.randomUUID()}@razafistore.com>`,
    headers: {
      "X-RAZAFI-Notification-Type": "annual-final-owner-report-uat",
      "X-RAZAFI-UAT": "S14.9.5D",
    },
  });

  log("send_success", {
    recipient: maskEmail(recipient),
    report_year: reportYear,
    message_id: String(result?.messageId || ""),
    accepted_count: Array.isArray(result?.accepted)
      ? result.accepted.length
      : null,
    rejected_count: Array.isArray(result?.rejected)
      ? result.rejected.length
      : null,
  });

  log("uat_complete", {
    sent_exactly_one_message: true,
    queue_untouched: true,
    snapshots_untouched: true,
    production_email_enabled: false,
  });
}

main().catch((error) => {
  fail("unexpected_error", {
    error: String(error?.message || error),
  });
});
