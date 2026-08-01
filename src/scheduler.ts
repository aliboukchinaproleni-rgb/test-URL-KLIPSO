import { config } from './config.js';
import { db, getSetting, purgeOldChecks } from './db.js';
import { inspectCertificate, runCheck } from './checker.js';
import type { CheckOutcome, Endpoint } from './types.js';

const inFlightHosts = new Set<string>();
let inFlightCount = 0;
let timer: NodeJS.Timeout | null = null;
let lastPurgeDay = '';

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Intervalle effectif : plancher de sécurité + espacement si panne durable. */
function effectiveInterval(endpoint: Endpoint, consecutiveFailures: number): number {
  const base = Math.max(endpoint.interval_seconds, config.minIntervalSeconds);
  if (consecutiveFailures < config.backoffAfterFailures) return base;
  const factor = 2 ** Math.min(consecutiveFailures - config.backoffAfterFailures + 1, 4);
  return Math.min(base * factor, config.backoffMaxIntervalSeconds);
}

function withJitter(seconds: number): number {
  const spread = seconds * config.jitterRatio;
  return Math.max(1, Math.round(seconds + (Math.random() * 2 - 1) * spread));
}

export function ensureStateRows(): void {
  db.prepare(
    `INSERT INTO endpoint_state (endpoint_id, next_check_at)
     SELECT e.id, datetime('now')
     FROM endpoints e
     LEFT JOIN endpoint_state s ON s.endpoint_id = e.id
     WHERE s.endpoint_id IS NULL`,
  ).run();
}

const selectDue = db.prepare(`
  SELECT e.*
  FROM endpoints e
  JOIN endpoint_state s ON s.endpoint_id = e.id
  WHERE e.enabled = 1 AND s.next_check_at <= datetime('now')
  ORDER BY CASE e.priority WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END, s.next_check_at
  LIMIT 200
`);

const recordCheck = db.transaction(
  (endpoint: Endpoint, outcome: CheckOutcome, cert: { expiresAt: string } | null) => {
    const previous = db
      .prepare('SELECT status, consecutive_failures FROM endpoint_state WHERE endpoint_id = ?')
      .get(endpoint.id) as { status: string; consecutive_failures: number } | undefined;

    const failed = outcome.status === 'down';
    const failures = failed ? (previous?.consecutive_failures ?? 0) + 1 : 0;
    // Un incident réseau ponctuel ne doit pas passer un projet en rouge :
    // on ne confirme la panne qu'après plusieurs échecs de suite.
    const status = failed
      ? failures >= config.failureThreshold
        ? 'down'
        : 'degraded'
      : outcome.status;

    db.prepare(
      `INSERT INTO checks (endpoint_id, checked_at, status, http_status, response_ms, error, cert_days_left)
       VALUES (?, datetime('now'), ?, ?, ?, ?, ?)`,
    ).run(
      endpoint.id,
      outcome.status,
      outcome.httpStatus,
      outcome.responseMs,
      outcome.error,
      outcome.certDaysLeft,
    );

    const nextSeconds = withJitter(effectiveInterval(endpoint, failures));
    db.prepare(
      `UPDATE endpoint_state SET
         status = ?,
         consecutive_failures = ?,
         last_checked_at = datetime('now'),
         last_ok_at = CASE WHEN ? = 1 THEN datetime('now') ELSE last_ok_at END,
         last_response_ms = ?,
         last_http_status = ?,
         last_error = ?,
         next_check_at = datetime('now', ?),
         cert_expires_at = COALESCE(?, cert_expires_at),
         cert_checked_at = COALESCE(?, cert_checked_at)
       WHERE endpoint_id = ?`,
    ).run(
      status,
      failures,
      failed ? 0 : 1,
      outcome.responseMs,
      outcome.httpStatus,
      outcome.error,
      `+${nextSeconds} seconds`,
      cert ? cert.expiresAt : null,
      cert ? new Date().toISOString() : null,
      endpoint.id,
    );

    db.prepare(
      `INSERT INTO daily_stats (endpoint_id, day, total_checks, failed_checks, slow_checks, sum_ms, max_ms)
       VALUES (?, date('now'), 1, ?, ?, ?, ?)
       ON CONFLICT(endpoint_id, day) DO UPDATE SET
         total_checks  = total_checks + 1,
         failed_checks = failed_checks + excluded.failed_checks,
         slow_checks   = slow_checks + excluded.slow_checks,
         sum_ms        = sum_ms + excluded.sum_ms,
         max_ms        = MAX(max_ms, excluded.max_ms)`,
    ).run(
      endpoint.id,
      failed ? 1 : 0,
      outcome.status === 'slow' ? 1 : 0,
      outcome.responseMs ?? 0,
      outcome.responseMs ?? 0,
    );

    const openIncident = db
      .prepare(
        'SELECT id FROM incidents WHERE endpoint_id = ? AND resolved_at IS NULL ORDER BY id DESC LIMIT 1',
      )
      .get(endpoint.id) as { id: number } | undefined;

    if (status === 'down' && !openIncident) {
      db.prepare(
        `INSERT INTO incidents (endpoint_id, started_at, cause) VALUES (?, datetime('now'), ?)`,
      ).run(endpoint.id, outcome.error);
    } else if (!failed && openIncident) {
      db.prepare(`UPDATE incidents SET resolved_at = datetime('now') WHERE id = ?`).run(
        openIncident.id,
      );
    }
  },
);

async function processEndpoint(endpoint: Endpoint): Promise<void> {
  const host = hostOf(endpoint.url);
  inFlightHosts.add(host);
  inFlightCount += 1;
  try {
    const outcome = await runCheck(endpoint);

    const certState = db
      .prepare('SELECT cert_checked_at FROM endpoint_state WHERE endpoint_id = ?')
      .get(endpoint.id) as { cert_checked_at: string | null } | undefined;
    const certStale =
      !certState?.cert_checked_at ||
      Date.now() - new Date(certState.cert_checked_at).getTime() > 86_400_000;

    let cert: { expiresAt: string; daysLeft: number } | null = null;
    if (certStale) {
      cert = await inspectCertificate(endpoint.url);
      if (cert) outcome.certDaysLeft = cert.daysLeft;
    }

    recordCheck(endpoint, outcome, cert);
  } catch (err) {
    console.error(`[monitor] échec du traitement de l'URL ${endpoint.id}`, err);
    db.prepare(
      `UPDATE endpoint_state SET next_check_at = datetime('now', '+60 seconds') WHERE endpoint_id = ?`,
    ).run(endpoint.id);
  } finally {
    inFlightHosts.delete(host);
    inFlightCount -= 1;
  }
}

function tick(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== lastPurgeDay) {
    lastPurgeDay = today;
    purgeOldChecks();
  }

  if (getSetting('monitoring_paused', '0') === '1') return;

  const due = selectDue.all() as Endpoint[];
  for (const endpoint of due) {
    if (inFlightCount >= config.maxConcurrentChecks) break;
    if (inFlightHosts.has(hostOf(endpoint.url))) continue;
    void processEndpoint(endpoint);
  }
}

export function startScheduler(): void {
  ensureStateRows();
  timer = setInterval(tick, config.tickMs);
  timer.unref();
  tick();
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Force le prochain passage du planificateur sur une URL (bouton « Tester »). */
export async function checkNow(endpointId: number): Promise<void> {
  const endpoint = db.prepare('SELECT * FROM endpoints WHERE id = ?').get(endpointId) as
    | Endpoint
    | undefined;
  if (!endpoint) throw new Error('URL introuvable');
  await processEndpoint(endpoint);
}
