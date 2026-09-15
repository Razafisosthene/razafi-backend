/**
 * RAZAFI Financial Reporting V1
 * S14.9.4 — Controlled annual-close cron runner
 *
 * Intended runtime:
 *   Render Cron Job -> node annual-close-job.js
 *
 * Safety model:
 *   1) Disabled by default.
 *   2) Always performs an explicit global DRY-RUN first.
 *   3) If preflight is not 100% PASS, execution is NOT attempted.
 *   4) Execution requires an explicit env gate.
 *   5) Any failure exits non-zero so Render can emit a cron failure notification.
 *   6) The PostgreSQL S14.9.3 orchestrator remains the canonical atomicity/RBAC layer.
 *
 * Required env:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   FINANCIAL_REPORTING_SUPERADMIN_ID
 *
 * Safety gates:
 *   RAZAFI_ANNUAL_CLOSE_ENABLED=true
 *   RAZAFI_ANNUAL_CLOSE_EXECUTE=true   // required for real FINAL creation
 *
 * Optional controlled override:
 *   RAZAFI_ANNUAL_CLOSE_YEAR=2026      // otherwise previous Madagascar year
 */

import { createClient } from "@supabase/supabase-js";

const JOB_VERSION = "financial-reporting-v1/S14.9.4.1-render-cron";
const MADAGASCAR_TZ = "Indian/Antananarivo";

function envFlag(name, fallback = false) {
  const raw = String(
    process.env[name] ?? (fallback ? "true" : "false")
  ).trim().toLowerCase();

  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`missing_env:${name}`);
  return value;
}

function log(event, data = {}) {
  const payload = {
    ts: new Date().toISOString(),
    job: "razafi_annual_close",
    version: JOB_VERSION,
    event,
    ...data,
  };
  console.log(JSON.stringify(payload));
}

function fail(code, data = {}) {
  const error = new Error(code);
  error.code = code;
  error.data = data;
  throw error;
}

function madagascarYearNow() {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: MADAGASCAR_TZ,
    year: "numeric",
  }).formatToParts(new Date());

  const year = Number(parts.find((p) => p.type === "year")?.value);
  if (!Number.isInteger(year)) {
    fail("madagascar_year_resolution_failed");
  }
  return year;
}

function resolveTargetYear() {
  const override = String(process.env.RAZAFI_ANNUAL_CLOSE_YEAR || "").trim();

  if (override) {
    const year = Number(override);
    if (!Number.isInteger(year) || year < 2020 || year > 2100) {
      fail("invalid_env:RAZAFI_ANNUAL_CLOSE_YEAR", { value: override });
    }
    return { year, source: "env_override" };
  }

  return {
    year: madagascarYearNow() - 1,
    source: "previous_madagascar_year",
  };
}

function int(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function assertPreflightPass(result, year) {
  const summary = result?.summary || {};

  if (result?.ok !== true) {
    fail("annual_close_preflight_not_ok", { year, result });
  }

  if (result?.executed !== false) {
    fail("annual_close_preflight_unexpected_execution", { year, result });
  }

  if (result?.preflight_passed !== true) {
    fail("annual_close_preflight_blocked", {
      year,
      reason: result?.reason || null,
      summary,
      errors: Array.isArray(result?.errors) ? result.errors : [],
    });
  }

  if (result?.eligible_for_finalization !== true) {
    fail("annual_close_preflight_not_eligible", {
      year,
      reason: result?.reason || null,
      summary,
    });
  }

  if (int(summary.scope_count) <= 0) {
    fail("annual_close_preflight_no_scopes", { year, summary });
  }

  if (int(summary.error_count) !== 0 || int(summary.blocked_scope_count) !== 0) {
    fail("annual_close_preflight_not_clean", { year, summary });
  }

  return summary;
}

function assertExecutionPass(result, year) {
  const summary = result?.summary || {};

  if (result?.ok !== true) {
    fail("annual_close_execution_not_ok", { year, result });
  }

  if (result?.executed !== true) {
    fail("annual_close_execution_not_executed", { year, result });
  }

  if (result?.preflight_passed !== true) {
    fail("annual_close_execution_preflight_not_passed", { year, result });
  }

  const scopeCount = int(summary.scope_count);
  const createdCount = int(summary.execution_created_count);
  const reusedCount = int(summary.execution_reused_existing_count);

  if (scopeCount <= 0) {
    fail("annual_close_execution_no_scopes", { year, summary });
  }

  if (createdCount + reusedCount !== scopeCount) {
    fail("annual_close_execution_scope_mismatch", {
      year,
      scope_count: scopeCount,
      execution_created_count: createdCount,
      execution_reused_existing_count: reusedCount,
    });
  }

  return summary;
}

function compactScopeEvidence(result) {
  const rows = Array.isArray(result?.execution_results)
    ? result.execution_results
    : [];

  return rows.map((row) => {
    const execution = row?.execution || {};
    const scope = row?.scope || {};

    return {
      scope_key: row?.scope_key || null,
      report_type: scope?.report_type || execution?.report_type || null,
      owner_admin_user_id: scope?.owner_admin_user_id || null,
      pool_id: scope?.pool_id || null,
      pool_name: scope?.pool_name || null,
      report_number: execution?.report_number || null,
      report_revision:
        execution?.report_revision ??
        execution?.would_create_revision ??
        null,
      snapshot_created: execution?.snapshot_created === true,
      reused_existing: execution?.reused_existing === true,
      checksum: execution?.checksum || null,
    };
  });
}

async function run() {
  const enabled = envFlag("RAZAFI_ANNUAL_CLOSE_ENABLED", false);
  const executeEnabled = envFlag("RAZAFI_ANNUAL_CLOSE_EXECUTE", false);
  const renderServiceType = String(process.env.RENDER_SERVICE_TYPE || "").trim();

  if (!enabled) {
    log("disabled", {
      message: "RAZAFI_ANNUAL_CLOSE_ENABLED is not true; no RPC call was made.",
      render_service_type: renderServiceType || null,
    });
    return;
  }

  const supabaseUrl = requiredEnv("SUPABASE_URL");
  const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const actorId = requiredEnv("FINANCIAL_REPORTING_SUPERADMIN_ID");
  const target = resolveTargetYear();

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  log("start", {
    report_year: target.year,
    year_source: target.source,
    execute_enabled: executeEnabled,
    render_service_type: renderServiceType || null,
  });

  // ------------------------------------------------------------------------
  // Phase 1 — explicit read-only global preflight.
  // ------------------------------------------------------------------------
  const { data: dryRun, error: dryRunError } = await supabase.rpc(
    "fn_financial_reporting_v1_annual_close",
    {
      p_actor: actorId,
      p_year: target.year,
      p_execute: false,
    }
  );

  if (dryRunError) {
    fail("annual_close_preflight_rpc_failed", {
      year: target.year,
      message: dryRunError.message || null,
      code: dryRunError.code || null,
      details: dryRunError.details || null,
    });
  }

  const preflightSummary = assertPreflightPass(dryRun, target.year);

  log("preflight_pass", {
    report_year: target.year,
    summary: preflightSummary,
  });

  // Safety default: a deployed cron job can remain in dry-run mode until
  // explicit production approval flips RAZAFI_ANNUAL_CLOSE_EXECUTE=true.
  if (!executeEnabled) {
    log("dry_run_only_complete", {
      report_year: target.year,
      message:
        "Preflight passed. Execution gate is OFF; no FINAL snapshot was requested.",
    });
    return;
  }

  // ------------------------------------------------------------------------
  // Phase 2 — controlled atomic execution.
  // The SQL orchestrator performs its own second complete preflight before
  // creating any snapshot, so this external preflight is additional evidence,
  // not the sole safety boundary.
  // ------------------------------------------------------------------------
  const { data: execution, error: executionError } = await supabase.rpc(
    "fn_financial_reporting_v1_annual_close",
    {
      p_actor: actorId,
      p_year: target.year,
      p_execute: true,
    }
  );

  if (executionError) {
    fail("annual_close_execution_rpc_failed", {
      year: target.year,
      message: executionError.message || null,
      code: executionError.code || null,
      details: executionError.details || null,
    });
  }

  const executionSummary = assertExecutionPass(execution, target.year);

  log("execution_pass", {
    report_year: target.year,
    summary: executionSummary,
    reports: compactScopeEvidence(execution),
  });

  log("complete", {
    report_year: target.year,
    created: int(executionSummary.execution_created_count),
    reused: int(executionSummary.execution_reused_existing_count),
    scope_count: int(executionSummary.scope_count),
  });
}

run().catch((error) => {
  const code = String(error?.code || error?.message || "annual_close_job_failed");

  log("failed", {
    code,
    message: String(error?.message || error || "annual_close_job_failed"),
    data: error?.data || null,
  });

  // Non-zero exit is intentional. Render supports notifications for failed
  // Cron Job executions, so a blocked/failed close remains visible to Ops.
  process.exitCode = 1;
});
