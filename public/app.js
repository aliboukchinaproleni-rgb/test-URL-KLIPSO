const STATUS_LABELS = {
  ok: 'Opérationnel',
  slow: 'Lent',
  degraded: 'Instable',
  down: 'En panne',
  paused: 'En pause',
  unknown: 'En attente',
};

const COUNTER_ORDER = ['down', 'degraded', 'slow', 'ok', 'paused', 'unknown'];

const state = { endpoints: [], projects: [], paused: false };

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== null && value !== undefined) node[key] = value;
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: options.body ? { 'content-type': 'application/json' } : {},
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? 'Erreur inattendue.');
  return payload;
}

/** Les dates SQLite arrivent en UTC sans suffixe : on le rétablit avant parsing. */
function parseDate(value) {
  if (!value) return null;
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function relativeTime(value) {
  const date = parseDate(value);
  if (!date) return 'jamais';
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `il y a ${Math.max(seconds, 0)} s`;
  if (seconds < 3600) return `il y a ${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `il y a ${Math.round(seconds / 3600)} h`;
  return `il y a ${Math.round(seconds / 86400)} j`;
}

function formatDateTime(value) {
  const date = parseDate(value);
  return date ? date.toLocaleString('fr-FR') : '—';
}

function statusPill(status) {
  return el('span', { class: 'pill', dataset: { status } }, [
    el('span', { class: 'dot' }),
    STATUS_LABELS[status] ?? status,
  ]);
}

function describeRow(endpoint) {
  if (endpoint.status === 'paused') return 'Surveillance désactivée';
  if (endpoint.last_error) return endpoint.last_error;
  if (endpoint.status === 'slow') {
    return `Réponse au-delà du seuil de ${endpoint.slow_ms} ms`;
  }
  const cert = parseDate(endpoint.cert_expires_at);
  if (cert) {
    const daysLeft = Math.floor((cert.getTime() - Date.now()) / 86_400_000);
    if (daysLeft < 0) return 'Certificat SSL expiré';
    if (daysLeft <= 21) return `Certificat SSL expire dans ${daysLeft} j`;
  }
  return endpoint.last_http_status ? `HTTP ${endpoint.last_http_status}` : '—';
}

function visibleEndpoints() {
  const term = $('search').value.trim().toLowerCase();
  const status = $('statusFilter').value;
  const priority = $('priorityFilter').value;
  const kind = $('kindFilter').value;

  return state.endpoints.filter((endpoint) => {
    if (status && endpoint.status !== status) return false;
    if (priority && endpoint.priority !== priority) return false;
    if (kind && endpoint.kind !== kind) return false;
    if (!term) return true;
    return [endpoint.project_name, endpoint.client, endpoint.owner, endpoint.label, endpoint.url]
      .filter(Boolean)
      .some((field) => String(field).toLowerCase().includes(term));
  });
}

function renderCounters(counts) {
  const container = $('counters');
  container.replaceChildren(
    ...COUNTER_ORDER.filter((status) => counts[status] > 0 || status === 'down' || status === 'ok').map(
      (status) =>
        el('div', { class: 'counter', dataset: { status } }, [
          el('strong', { textContent: String(counts[status] ?? 0) }),
          el('span', { textContent: STATUS_LABELS[status] }),
        ]),
    ),
  );
}

function renderGrid() {
  const rows = visibleEndpoints();
  const body = $('gridBody');
  $('emptyState').hidden = rows.length > 0;

  body.replaceChildren(
    ...rows.map((endpoint) =>
      el('tr', { dataset: { status: endpoint.status } }, [
        el('td', {}, statusPill(endpoint.status)),
        el('td', {}, el('span', { class: 'prio', dataset: { p: endpoint.priority }, textContent: endpoint.priority })),
        el('td', {}, [
          el('div', { textContent: endpoint.project_name }),
          endpoint.client ? el('small', { class: 'muted', textContent: endpoint.client }) : null,
        ]),
        el('td', { textContent: endpoint.kind === 'front' ? 'Front' : 'Back-office' }),
        el('td', { class: 'url-cell' }, [
          el('a', {
            href: endpoint.url,
            target: '_blank',
            rel: 'noreferrer noopener',
            textContent: endpoint.label || endpoint.url,
          }),
        ]),
        el('td', { textContent: endpoint.last_response_ms ? `${endpoint.last_response_ms} ms` : '—' }),
        el('td', {
          textContent:
            endpoint.uptime_7d === null || endpoint.uptime_7d === undefined
              ? '—'
              : `${endpoint.uptime_7d.toFixed(2)} %`,
        }),
        el('td', { textContent: relativeTime(endpoint.last_checked_at) }),
        el('td', { class: 'detail-cell', textContent: describeRow(endpoint) }),
        el('td', {}, [
          el('div', { class: 'row-actions' }, [
            el('button', {
              class: 'btn btn-sm',
              type: 'button',
              textContent: 'Tester',
              onclick: () => testNow(endpoint.id),
            }),
            el('button', {
              class: 'btn btn-sm',
              type: 'button',
              textContent: 'Détail',
              onclick: () => openDetail(endpoint.id),
            }),
            el('button', {
              class: 'btn btn-sm',
              type: 'button',
              textContent: 'Éditer',
              onclick: () => openEndpointDialog(endpoint.id),
            }),
            el('button', {
              class: 'btn btn-sm',
              type: 'button',
              textContent: 'Suppr.',
              onclick: () => removeEndpoint(endpoint),
            }),
          ]),
        ]),
      ]),
    ),
  );
}

async function refresh() {
  const data = await api('/api/dashboard');
  state.endpoints = data.endpoints;
  state.paused = data.paused;
  renderCounters(data.counts);
  renderGrid();
  $('lastUpdate').textContent = `${data.endpoints.length} URL surveillées — actualisé à ${new Date().toLocaleTimeString('fr-FR')}${data.paused ? ' — SURVEILLANCE EN PAUSE' : ''}`;
  $('pauseBtn').textContent = data.paused ? 'Reprendre la surveillance' : 'Mettre en pause';
}

async function loadProjects() {
  state.projects = await api('/api/projects');
}

async function testNow(id) {
  await api(`/api/endpoints/${id}/check`, { method: 'POST' });
  await refresh();
}

async function removeEndpoint(endpoint) {
  if (!confirm(`Supprimer la surveillance de ${endpoint.url} ?`)) return;
  await api(`/api/endpoints/${endpoint.id}`, { method: 'DELETE' });
  await refresh();
}

function openDialog(dialog) {
  dialog.showModal();
}

function showFormError(node, message) {
  node.textContent = message;
  node.hidden = !message;
}

function openProjectDialog() {
  const form = $('projectForm');
  form.reset();
  showFormError($('projectError'), '');
  openDialog($('projectDialog'));
}

function openEndpointDialog(endpointId = null) {
  if (state.projects.length === 0) {
    alert("Créez d'abord un projet avant d'ajouter des URL.");
    return;
  }
  const form = $('endpointForm');
  form.reset();
  showFormError($('endpointError'), '');

  form.project_id.replaceChildren(
    ...state.projects.map((project) =>
      el('option', {
        value: String(project.id),
        textContent: project.client ? `${project.name} — ${project.client}` : project.name,
      }),
    ),
  );

  const existing = endpointId ? state.endpoints.find((e) => e.id === endpointId) : null;
  $('endpointDialogTitle').textContent = existing ? "Modifier l'URL" : 'Ajouter une URL';
  $('authHint').hidden = !existing;
  form.id.value = existing ? String(existing.id) : '';

  if (existing) {
    api(`/api/endpoints/${existing.id}/detail`).then(({ endpoint }) => {
      form.project_id.value = String(endpoint.project_id);
      form.kind.value = endpoint.kind;
      form.url.value = endpoint.url;
      form.label.value = endpoint.label ?? '';
      form.priority.value = endpoint.priority;
      form.method.value = endpoint.method;
      form.expected_status.value = endpoint.expected_status;
      form.slow_ms.value = endpoint.slow_ms;
      form.timeout_ms.value = endpoint.timeout_ms;
      form.keyword_expect.value = endpoint.keyword_expect ?? '';
      form.keyword_forbid.value = endpoint.keyword_forbid ?? '';
      form.auth_user.value = endpoint.auth_user ?? '';
      form.enabled.checked = endpoint.enabled === 1;
      const option = [...form.interval_seconds.options].find(
        (o) => Number(o.value) === endpoint.interval_seconds,
      );
      if (!option) {
        form.interval_seconds.append(
          el('option', {
            value: String(endpoint.interval_seconds),
            textContent: `Toutes les ${Math.round(endpoint.interval_seconds / 60)} minutes`,
          }),
        );
      }
      form.interval_seconds.value = String(endpoint.interval_seconds);
    });
  }
  openDialog($('endpointDialog'));
}

async function openDetail(id) {
  const data = await api(`/api/endpoints/${id}/detail`);
  const { endpoint, state: endpointState, checks, incidents } = data;
  const container = $('detailContent');

  const openIncidents = incidents.filter((incident) => !incident.resolved_at).length;
  const avgMs =
    checks.length > 0
      ? Math.round(checks.reduce((sum, c) => sum + (c.response_ms ?? 0), 0) / checks.length)
      : null;
  const maxMs = checks.reduce((max, c) => Math.max(max, c.response_ms ?? 0), 0);

  container.replaceChildren(
    el('h2', { textContent: endpoint.label || endpoint.url }),
    el('p', {
      class: 'muted',
      textContent: `${endpoint.project_name}${endpoint.client ? ` — ${endpoint.client}` : ''} · ${endpoint.kind === 'front' ? 'Front' : 'Back-office'} · ${endpoint.priority} · test toutes les ${Math.round(endpoint.interval_seconds / 60)} min`,
    }),
    el('div', { class: 'detail-grid' }, [
      el('div', {}, [
        el('span', { textContent: 'Statut actuel' }),
        statusPill(endpoint.enabled ? (endpointState?.status ?? 'unknown') : 'paused'),
      ]),
      el('div', {}, [
        el('span', { textContent: 'Temps moyen (récent)' }),
        el('strong', { textContent: avgMs === null ? '—' : `${avgMs} ms` }),
      ]),
      el('div', {}, [
        el('span', { textContent: 'Pic de latence' }),
        el('strong', { textContent: maxMs ? `${maxMs} ms` : '—' }),
      ]),
      el('div', {}, [
        el('span', { textContent: 'Incidents ouverts' }),
        el('strong', { textContent: String(openIncidents) }),
      ]),
      el('div', {}, [
        el('span', { textContent: 'Dernier succès' }),
        el('strong', { textContent: relativeTime(endpointState?.last_ok_at) }),
      ]),
      el('div', {}, [
        el('span', { textContent: 'Certificat SSL' }),
        el('strong', {
          textContent: endpointState?.cert_expires_at
            ? `expire le ${parseDate(endpointState.cert_expires_at)?.toLocaleDateString('fr-FR')}`
            : '—',
        }),
      ]),
    ]),
    el('p', { class: 'muted', textContent: 'Historique récent (du plus ancien au plus récent)' }),
    el(
      'div',
      { class: 'sparkline' },
      [...checks].reverse().map((check) =>
        el('div', {
          class: 'spark',
          dataset: { status: check.status === 'degraded' ? 'down' : check.status },
          title: `${formatDateTime(check.checked_at)} — ${check.response_ms ?? '?'} ms${check.error ? ` — ${check.error}` : ''}`,
          style: `height:${check.status === 'down' ? 100 : Math.max(8, Math.min(100, ((check.response_ms ?? 0) / Math.max(maxMs, 1)) * 100))}%`,
        }),
      ),
    ),
    el('div', { class: 'history' }, [
      el('table', {}, [
        el('thead', {}, el('tr', {}, [
          el('th', { textContent: 'Date' }),
          el('th', { textContent: 'Statut' }),
          el('th', { textContent: 'HTTP' }),
          el('th', { textContent: 'Temps' }),
          el('th', { textContent: 'Message' }),
        ])),
        el(
          'tbody',
          {},
          checks.slice(0, 40).map((check) =>
            el('tr', {}, [
              el('td', { textContent: formatDateTime(check.checked_at) }),
              el('td', {}, statusPill(check.status)),
              el('td', { textContent: check.http_status ?? '—' }),
              el('td', { textContent: check.response_ms ? `${check.response_ms} ms` : '—' }),
              el('td', { textContent: check.error ?? '' }),
            ]),
          ),
        ),
      ]),
    ]),
  );
  openDialog($('detailDialog'));
}

$('projectForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  try {
    await api('/api/projects', { method: 'POST', body: data });
    $('projectDialog').close();
    await loadProjects();
    await refresh();
  } catch (err) {
    showFormError($('projectError'), err.message);
  }
});

$('endpointForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form));
  data.enabled = form.enabled.checked;
  const id = data.id;
  delete data.id;

  try {
    if (id) await api(`/api/endpoints/${id}`, { method: 'PUT', body: data });
    else await api('/api/endpoints', { method: 'POST', body: data });
    $('endpointDialog').close();
    await refresh();
  } catch (err) {
    showFormError($('endpointError'), err.message);
  }
});

$('pauseBtn').addEventListener('click', async () => {
  await api('/api/settings/pause', { method: 'POST', body: { paused: !state.paused } });
  await refresh();
});

$('newProjectBtn').addEventListener('click', openProjectDialog);
$('newEndpointBtn').addEventListener('click', () => openEndpointDialog());

for (const button of document.querySelectorAll('[data-close]')) {
  button.addEventListener('click', () => button.closest('dialog').close());
}

for (const control of ['search', 'statusFilter', 'priorityFilter', 'kindFilter']) {
  $(control).addEventListener('input', renderGrid);
}

await loadProjects();
await refresh();
// Rafraîchit l'affichage seulement : la fréquence des tests reste pilotée côté serveur.
setInterval(refresh, 20_000);
