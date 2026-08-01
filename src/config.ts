function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  port: int('PORT', 3000),
  host: process.env.HOST ?? '0.0.0.0',
  databaseFile: process.env.DATABASE_FILE ?? 'data/monitor.db',

  /** Nombre de requêtes sortantes simultanées, tous serveurs confondus. */
  maxConcurrentChecks: int('MAX_CONCURRENT_CHECKS', 6),
  /** Une seule requête en vol par hôte : évite de marteler un même serveur. */
  maxConcurrentPerHost: 1,
  /** Plancher de fréquence, empêche de configurer un intervalle agressif. */
  minIntervalSeconds: int('MIN_INTERVAL_SECONDS', 60),
  /** Le planificateur regarde les échéances à ce rythme. */
  tickMs: int('SCHEDULER_TICK_MS', 5_000),
  /** Désynchronise les checks pour lisser la charge sortante. */
  jitterRatio: 0.1,
  /** Nombre d'échecs consécutifs avant de basculer en rouge. */
  failureThreshold: int('FAILURE_THRESHOLD', 3),
  /** Au-delà, on espace les checks d'un service durablement en panne. */
  backoffAfterFailures: int('BACKOFF_AFTER_FAILURES', 5),
  backoffMaxIntervalSeconds: int('BACKOFF_MAX_INTERVAL_SECONDS', 900),
  /** Octets lus au maximum pour la recherche de mot-clé. */
  maxBodyBytes: int('MAX_BODY_BYTES', 262_144),
  userAgent: process.env.USER_AGENT ?? 'LeniUrlMonitor/1.0 (supervision interne)',
  /** Rétention du détail des checks. Les agrégats journaliers sont conservés. */
  retentionDays: int('RETENTION_DAYS', 30),
} as const;

export const DEFAULT_INTERVAL_BY_PRIORITY: Record<string, number> = {
  P1: 180,
  P2: 300,
  P3: 900,
};
