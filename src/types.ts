export type EndpointKind = 'front' | 'back';
export type Priority = 'P1' | 'P2' | 'P3';

/** `degraded` = échecs en cours mais seuil de confirmation pas encore atteint. */
export type CheckStatus = 'ok' | 'slow' | 'degraded' | 'down';
export type EndpointStatus = CheckStatus | 'paused' | 'unknown';

export interface Project {
  id: number;
  name: string;
  client: string | null;
  owner: string | null;
  notes: string | null;
  created_at: string;
}

export interface Endpoint {
  id: number;
  project_id: number;
  kind: EndpointKind;
  label: string | null;
  url: string;
  priority: Priority;
  method: 'GET' | 'HEAD';
  interval_seconds: number;
  timeout_ms: number;
  slow_ms: number;
  expected_status: number;
  keyword_expect: string | null;
  keyword_forbid: string | null;
  auth_user: string | null;
  auth_pass: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface EndpointState {
  endpoint_id: number;
  status: EndpointStatus;
  consecutive_failures: number;
  last_checked_at: string | null;
  last_ok_at: string | null;
  last_response_ms: number | null;
  last_http_status: number | null;
  last_error: string | null;
  next_check_at: string;
  cert_expires_at: string | null;
}

export interface CheckRow {
  id: number;
  endpoint_id: number;
  checked_at: string;
  status: CheckStatus;
  http_status: number | null;
  response_ms: number | null;
  error: string | null;
  cert_days_left: number | null;
}

export interface CheckOutcome {
  status: CheckStatus;
  httpStatus: number | null;
  responseMs: number | null;
  error: string | null;
  certDaysLeft: number | null;
  certExpiresAt: string | null;
}
