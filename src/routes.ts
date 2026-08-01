import type { FastifyInstance } from 'fastify';
import { config, DEFAULT_INTERVAL_BY_PRIORITY } from './config.js';
import { db, getSetting, setSetting } from './db.js';
import { checkNow, ensureStateRows } from './scheduler.js';
import type { Endpoint, Priority } from './types.js';

class BadRequest extends Error {}

function str(value: unknown, field: string, { required = false, max = 2000 } = {}): string | null {
  if (value === undefined || value === null || value === '') {
    if (required) throw new BadRequest(`Le champ « ${field} » est obligatoire.`);
    return null;
  }
  if (typeof value !== 'string') throw new BadRequest(`Le champ « ${field} » doit être un texte.`);
  const trimmed = value.trim();
  if (required && trimmed === '') throw new BadRequest(`Le champ « ${field} » est obligatoire.`);
  if (trimmed.length > max) throw new BadRequest(`Le champ « ${field} » est trop long.`);
  return trimmed === '' ? null : trimmed;
}

function num(value: unknown, field: string, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new BadRequest(`Le champ « ${field} » doit être un nombre.`);
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[], fallback: T): T {
  if (value === undefined || value === null || value === '') return fallback;
  if (!allowed.includes(value as T)) {
    throw new BadRequest(`Le champ « ${field} » doit valoir : ${allowed.join(', ')}.`);
  }
  return value as T;
}

function validUrl(value: unknown): string {
  const raw = str(value, 'url', { required: true, max: 2048 })!;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new BadRequest("L'URL n'est pas valide. Exemple attendu : https://exemple.fr/admin");
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BadRequest('Seules les URL http:// et https:// peuvent être surveillées.');
  }
  return parsed.toString();
}

/** Le mot de passe d'authentification ne ressort jamais de l'API. */
function publicEndpoint<T extends { auth_pass?: string | null }>(row: T) {
  const { auth_pass, ...rest } = row;
  return { ...rest, has_auth_password: Boolean(auth_pass) };
}

const SEVERITY_ORDER = `CASE s.status
    WHEN 'down' THEN 0 WHEN 'degraded' THEN 1 WHEN 'slow' THEN 2
    WHEN 'unknown' THEN 3 WHEN 'ok' THEN 4 ELSE 5 END`;

const PRIORITY_ORDER = `CASE e.priority WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END`;

function endpointBody(body: Record<string, unknown>, existing?: Endpoint) {
  const priority = oneOf<Priority>(body.priority, 'priorité', ['P1', 'P2', 'P3'], existing?.priority ?? 'P2');
  const defaultInterval = DEFAULT_INTERVAL_BY_PRIORITY[priority] ?? 300;
  return {
    kind: oneOf(body.kind, 'type', ['front', 'back'] as const, existing?.kind ?? 'front'),
    label: str(body.label, 'libellé', { max: 200 }),
    url: validUrl(body.url),
    priority,
    method: oneOf(body.method, 'méthode', ['GET', 'HEAD'] as const, existing?.method ?? 'GET'),
    interval_seconds: num(
      body.interval_seconds,
      'intervalle',
      config.minIntervalSeconds,
      86_400,
      existing?.interval_seconds ?? defaultInterval,
    ),
    timeout_ms: num(body.timeout_ms, 'timeout', 1000, 60_000, existing?.timeout_ms ?? 10_000),
    slow_ms: num(body.slow_ms, 'seuil de lenteur', 200, 60_000, existing?.slow_ms ?? 3000),
    expected_status: num(body.expected_status, 'statut attendu', 100, 599, existing?.expected_status ?? 200),
    keyword_expect: str(body.keyword_expect, 'texte attendu', { max: 500 }),
    keyword_forbid: str(body.keyword_forbid, "texte d'erreur", { max: 500 }),
    auth_user: str(body.auth_user, 'identifiant', { max: 200 }),
    enabled: body.enabled === undefined ? (existing?.enabled ?? 1) : body.enabled ? 1 : 0,
  };
}

export function registerRoutes(app: FastifyInstance): void {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof BadRequest) return reply.status(400).send({ error: error.message });
    app.log.error(error);
    return reply.status(500).send({ error: 'Erreur interne du serveur.' });
  });

  app.get('/api/dashboard', async () => {
    const rows = db
      .prepare(
        `SELECT e.id, e.project_id, e.kind, e.label, e.url, e.priority, e.enabled,
                e.interval_seconds, e.slow_ms, e.timeout_ms,
                p.name AS project_name, p.client, p.owner,
                CASE WHEN e.enabled = 0 THEN 'paused' ELSE s.status END AS status,
                s.consecutive_failures, s.last_checked_at, s.last_ok_at,
                s.last_response_ms, s.last_http_status, s.last_error,
                s.next_check_at, s.cert_expires_at
         FROM endpoints e
         JOIN projects p ON p.id = e.project_id
         LEFT JOIN endpoint_state s ON s.endpoint_id = e.id
         ORDER BY ${SEVERITY_ORDER}, ${PRIORITY_ORDER}, p.name, e.kind`,
      )
      .all() as Array<Record<string, unknown> & { id: number }>;

    const uptime = db
      .prepare(
        `SELECT endpoint_id,
                SUM(total_checks) AS total,
                SUM(failed_checks) AS failed,
                CASE WHEN SUM(total_checks) > 0 THEN SUM(sum_ms) / SUM(total_checks) END AS avg_ms
         FROM daily_stats
         WHERE day >= date('now', '-7 days')
         GROUP BY endpoint_id`,
      )
      .all() as Array<{ endpoint_id: number; total: number; failed: number; avg_ms: number | null }>;
    const uptimeById = new Map(uptime.map((row) => [row.endpoint_id, row]));

    const endpoints = rows.map((row) => {
      const stats = uptimeById.get(row.id);
      return {
        ...row,
        status: row.status ?? 'unknown',
        uptime_7d: stats && stats.total > 0 ? (1 - stats.failed / stats.total) * 100 : null,
        avg_ms_7d: stats?.avg_ms ?? null,
      };
    });

    const counts = { ok: 0, slow: 0, degraded: 0, down: 0, paused: 0, unknown: 0 };
    for (const endpoint of endpoints) {
      const key = endpoint.status as keyof typeof counts;
      if (key in counts) counts[key] += 1;
    }

    return {
      endpoints,
      counts,
      paused: getSetting('monitoring_paused', '0') === '1',
      generated_at: new Date().toISOString(),
    };
  });

  app.get('/api/projects', async () => {
    return db
      .prepare(
        `SELECT p.*, COUNT(e.id) AS endpoint_count
         FROM projects p LEFT JOIN endpoints e ON e.project_id = p.id
         GROUP BY p.id ORDER BY p.name`,
      )
      .all();
  });

  app.post('/api/projects', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const info = db
      .prepare('INSERT INTO projects (name, client, owner, notes) VALUES (?, ?, ?, ?)')
      .run(
        str(body.name, 'nom du projet', { required: true, max: 200 }),
        str(body.client, 'client', { max: 200 }),
        str(body.owner, 'chef de projet', { max: 200 }),
        str(body.notes, 'notes', { max: 2000 }),
      );
    return reply
      .status(201)
      .send(db.prepare('SELECT * FROM projects WHERE id = ?').get(info.lastInsertRowid));
  });

  app.put<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const info = db
      .prepare('UPDATE projects SET name = ?, client = ?, owner = ?, notes = ? WHERE id = ?')
      .run(
        str(body.name, 'nom du projet', { required: true, max: 200 }),
        str(body.client, 'client', { max: 200 }),
        str(body.owner, 'chef de projet', { max: 200 }),
        str(body.notes, 'notes', { max: 2000 }),
        request.params.id,
      );
    if (info.changes === 0) return reply.status(404).send({ error: 'Projet introuvable.' });
    return db.prepare('SELECT * FROM projects WHERE id = ?').get(request.params.id);
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    const info = db.prepare('DELETE FROM projects WHERE id = ?').run(request.params.id);
    if (info.changes === 0) return reply.status(404).send({ error: 'Projet introuvable.' });
    return reply.status(204).send();
  });

  app.get<{ Querystring: { project_id?: string } }>('/api/endpoints', async (request) => {
    const rows = request.query.project_id
      ? db.prepare('SELECT * FROM endpoints WHERE project_id = ? ORDER BY kind, id').all(request.query.project_id)
      : db.prepare('SELECT * FROM endpoints ORDER BY project_id, kind, id').all();
    return (rows as Array<Record<string, unknown>>).map(publicEndpoint);
  });

  app.post('/api/endpoints', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const projectId = num(body.project_id, 'projet', 1, Number.MAX_SAFE_INTEGER, 0);
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) throw new BadRequest('Projet introuvable.');

    const values = endpointBody(body);
    const info = db
      .prepare(
        `INSERT INTO endpoints
           (project_id, kind, label, url, priority, method, interval_seconds, timeout_ms, slow_ms,
            expected_status, keyword_expect, keyword_forbid, auth_user, auth_pass, enabled)
         VALUES (@project_id, @kind, @label, @url, @priority, @method, @interval_seconds, @timeout_ms,
                 @slow_ms, @expected_status, @keyword_expect, @keyword_forbid, @auth_user, @auth_pass, @enabled)`,
      )
      .run({
        ...values,
        project_id: projectId,
        auth_pass: str(body.auth_pass, 'mot de passe', { max: 500 }),
      });
    ensureStateRows();
    const created = db.prepare('SELECT * FROM endpoints WHERE id = ?').get(info.lastInsertRowid);
    return reply.status(201).send(publicEndpoint(created as Record<string, unknown>));
  });

  app.put<{ Params: { id: string } }>('/api/endpoints/:id', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const existing = db.prepare('SELECT * FROM endpoints WHERE id = ?').get(request.params.id) as
      | Endpoint
      | undefined;
    if (!existing) return reply.status(404).send({ error: 'URL introuvable.' });

    const values = endpointBody(body, existing);
    // Un mot de passe absent du formulaire signifie « inchangé », pas « effacé ».
    const newPassword = str(body.auth_pass, 'mot de passe', { max: 500 });
    db.prepare(
      `UPDATE endpoints SET
         kind = @kind, label = @label, url = @url, priority = @priority, method = @method,
         interval_seconds = @interval_seconds, timeout_ms = @timeout_ms, slow_ms = @slow_ms,
         expected_status = @expected_status, keyword_expect = @keyword_expect,
         keyword_forbid = @keyword_forbid, auth_user = @auth_user, auth_pass = @auth_pass,
         enabled = @enabled, updated_at = datetime('now')
       WHERE id = @id`,
    ).run({
      ...values,
      id: existing.id,
      auth_pass: newPassword ?? existing.auth_pass,
    });
    db.prepare(`UPDATE endpoint_state SET next_check_at = datetime('now') WHERE endpoint_id = ?`).run(
      existing.id,
    );
    return publicEndpoint(
      db.prepare('SELECT * FROM endpoints WHERE id = ?').get(existing.id) as Record<string, unknown>,
    );
  });

  app.delete<{ Params: { id: string } }>('/api/endpoints/:id', async (request, reply) => {
    const info = db.prepare('DELETE FROM endpoints WHERE id = ?').run(request.params.id);
    if (info.changes === 0) return reply.status(404).send({ error: 'URL introuvable.' });
    return reply.status(204).send();
  });

  app.get<{ Params: { id: string } }>('/api/endpoints/:id/detail', async (request, reply) => {
    const endpoint = db
      .prepare(
        `SELECT e.*, p.name AS project_name, p.client, p.owner
         FROM endpoints e JOIN projects p ON p.id = e.project_id WHERE e.id = ?`,
      )
      .get(request.params.id) as Record<string, unknown> | undefined;
    if (!endpoint) return reply.status(404).send({ error: 'URL introuvable.' });

    return {
      endpoint: publicEndpoint(endpoint),
      state: db.prepare('SELECT * FROM endpoint_state WHERE endpoint_id = ?').get(request.params.id),
      checks: db
        .prepare('SELECT * FROM checks WHERE endpoint_id = ? ORDER BY checked_at DESC LIMIT 120')
        .all(request.params.id),
      daily: db
        .prepare(
          `SELECT day, total_checks, failed_checks, slow_checks, max_ms,
                  CASE WHEN total_checks > 0 THEN sum_ms / total_checks END AS avg_ms
           FROM daily_stats WHERE endpoint_id = ? AND day >= date('now', '-30 days')
           ORDER BY day DESC`,
        )
        .all(request.params.id),
      incidents: db
        .prepare('SELECT * FROM incidents WHERE endpoint_id = ? ORDER BY started_at DESC LIMIT 20')
        .all(request.params.id),
    };
  });

  app.post<{ Params: { id: string } }>('/api/endpoints/:id/check', async (request, reply) => {
    try {
      await checkNow(Number(request.params.id));
    } catch {
      return reply.status(404).send({ error: 'URL introuvable.' });
    }
    return db.prepare('SELECT * FROM endpoint_state WHERE endpoint_id = ?').get(request.params.id);
  });

  app.get('/api/settings', async () => ({
    paused: getSetting('monitoring_paused', '0') === '1',
    min_interval_seconds: config.minIntervalSeconds,
    max_concurrent_checks: config.maxConcurrentChecks,
    failure_threshold: config.failureThreshold,
    retention_days: config.retentionDays,
  }));

  app.post('/api/settings/pause', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    setSetting('monitoring_paused', body.paused ? '1' : '0');
    return { paused: body.paused === true };
  });

  app.get('/api/health', async () => ({ status: 'ok', time: new Date().toISOString() }));
}
