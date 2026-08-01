import tls from 'node:tls';
import { config } from './config.js';
import type { CheckOutcome, Endpoint } from './types.js';

/** Messages réseau bruts traduits en libellés lisibles par un chef de projet. */
const ERROR_LABELS: Array<[RegExp, string]> = [
  [/ENOTFOUND|EAI_AGAIN|getaddrinfo/i, 'Nom de domaine introuvable (DNS)'],
  [/ECONNREFUSED/i, 'Connexion refusée par le serveur'],
  [/ECONNRESET/i, 'Connexion interrompue par le serveur'],
  [/EHOSTUNREACH|ENETUNREACH/i, 'Serveur injoignable sur le réseau'],
  [/ETIMEDOUT/i, 'Délai de connexion dépassé'],
  [/CERT_HAS_EXPIRED/i, 'Certificat SSL expiré'],
  [/DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED/i, 'Certificat SSL auto-signé'],
  [/UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER/i, 'Certificat SSL non vérifiable'],
  [/ERR_TLS|SSL routines|EPROTO/i, 'Erreur SSL/TLS'],
];

function describeError(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  while (current instanceof Error) {
    parts.push(current.message);
    const code = (current as NodeJS.ErrnoException).code;
    if (code) parts.push(code);
    current = current.cause;
  }
  const haystack = parts.join(' ') || String(err);
  for (const [pattern, label] of ERROR_LABELS) {
    if (pattern.test(haystack)) return label;
  }
  return haystack.slice(0, 200);
}

/**
 * Lit au plus `maxBodyBytes` puis coupe le flux : un backoffice qui renvoie
 * une page lourde ne doit pas coûter de la bande passante au serveur surveillé.
 */
async function readCappedText(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (received < config.maxBodyBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        received += value.byteLength;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

export async function runCheck(endpoint: Endpoint): Promise<CheckOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), endpoint.timeout_ms);
  const startedAt = performance.now();

  const headers: Record<string, string> = {
    'user-agent': config.userAgent,
    accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'accept-encoding': 'gzip, deflate',
    'cache-control': 'no-cache',
  };
  if (endpoint.auth_user) {
    const token = Buffer.from(`${endpoint.auth_user}:${endpoint.auth_pass ?? ''}`).toString(
      'base64',
    );
    headers.authorization = `Basic ${token}`;
  }

  const needsBody = Boolean(endpoint.keyword_expect || endpoint.keyword_forbid);
  const method = needsBody ? 'GET' : endpoint.method;

  try {
    const response = await fetch(endpoint.url, {
      method,
      headers,
      redirect: 'follow',
      signal: controller.signal,
    });
    // Mesuré à la réception des en-têtes : c'est le temps de traitement serveur,
    // indépendant du poids de la page.
    const responseMs = Math.round(performance.now() - startedAt);

    let body = '';
    if (needsBody) {
      body = await readCappedText(response);
    } else if (response.body) {
      await response.body.cancel().catch(() => {});
    }

    const problems: string[] = [];
    if (response.status !== endpoint.expected_status) {
      problems.push(`HTTP ${response.status} (attendu ${endpoint.expected_status})`);
    }
    if (endpoint.keyword_expect && !body.includes(endpoint.keyword_expect)) {
      problems.push(`Texte attendu absent : « ${endpoint.keyword_expect} »`);
    }
    if (endpoint.keyword_forbid && body.includes(endpoint.keyword_forbid)) {
      problems.push(`Texte d'erreur détecté : « ${endpoint.keyword_forbid} »`);
    }

    if (problems.length > 0) {
      return {
        status: 'down',
        httpStatus: response.status,
        responseMs,
        error: problems.join(' — '),
        certDaysLeft: null,
        certExpiresAt: null,
      };
    }

    return {
      status: responseMs > endpoint.slow_ms ? 'slow' : 'ok',
      httpStatus: response.status,
      responseMs,
      error: null,
      certDaysLeft: null,
      certExpiresAt: null,
    };
  } catch (err) {
    const aborted = controller.signal.aborted;
    return {
      status: 'down',
      httpStatus: null,
      responseMs: Math.round(performance.now() - startedAt),
      error: aborted ? `Délai dépassé (> ${endpoint.timeout_ms} ms)` : describeError(err),
      certDaysLeft: null,
      certExpiresAt: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Interrogation TLS séparée, appelée au plus une fois par jour et par URL :
 * l'expiration d'un certificat est une panne annoncée qu'on veut voir venir.
 */
export async function inspectCertificate(
  rawUrl: string,
): Promise<{ expiresAt: string; daysLeft: number } | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;

  return new Promise((resolvePromise) => {
    const socket = tls.connect(
      {
        host: url.hostname,
        port: Number(url.port) || 443,
        servername: url.hostname,
        rejectUnauthorized: false,
        timeout: 8000,
      },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        if (!cert?.valid_to) return resolvePromise(null);
        const expiry = new Date(cert.valid_to);
        if (Number.isNaN(expiry.getTime())) return resolvePromise(null);
        resolvePromise({
          expiresAt: expiry.toISOString(),
          daysLeft: Math.floor((expiry.getTime() - Date.now()) / 86_400_000),
        });
      },
    );
    const fail = () => {
      socket.destroy();
      resolvePromise(null);
    };
    socket.on('error', fail);
    socket.on('timeout', fail);
  });
}
