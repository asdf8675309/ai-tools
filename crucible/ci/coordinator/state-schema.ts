// Shape of the machine-readable state the coordinator keeps in a sticky PR
// comment, plus a total validator. The validator is not ceremony: the state is
// read back from a PUBLIC comment body, so it is untrusted input on the way in
// even though we wrote it on the way out.

export const CURRENT_SCHEMA_VERSION = 1 as const;

export type FindingSeverity = "CRITICAL" | "WARNING" | "SUGGESTION";

export type FindingStatus =
  | "open"
  | "resolved"
  | "dismissed"
  | "reemerged"
  | "permanently_dismissed";

export interface StateFinding {
  id: string;
  source_surface: string;
  severity: FindingSeverity;
  file: string;
  line: number;
  line_at_last_seen: number;
  title_normalized: string;
  title_original: string;
  status: FindingStatus;
  first_seen_commit: string;
  first_seen_run_id: string;
  last_seen_commit: string;
  last_seen_run_id: string;
  dismissed_at_commit?: string;
  dismissed_by?: string;
  dismissed_reason?: string;
  resolved_at_commit?: string;
  reemerged_at_commit?: string;
  reemergence_count?: number;
}

export interface DismissalRecord {
  finding_id: string;
  reason: string;
  author: string;
  ts: string;
}

export interface CoordinatorState {
  schema_version: typeof CURRENT_SCHEMA_VERSION;
  last_run_id: string;
  last_run_url: string;
  last_run_ts: string;
  last_head_sha: string;
  last_base_sha: string;
  commits_reviewed: Array<{
    sha: string;
    ts: string;
    run_id: string;
  }>;
  findings: StateFinding[];
  counters: {
    open: number;
    resolved: number;
    dismissed: number;
    reemerged: number;
    total_ever_seen: number;
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSeverity(value: unknown): value is FindingSeverity {
  return value === "CRITICAL" || value === "WARNING" || value === "SUGGESTION";
}

function isStatus(value: unknown): value is FindingStatus {
  return (
    value === "open" ||
    value === "resolved" ||
    value === "dismissed" ||
    value === "reemerged" ||
    value === "permanently_dismissed"
  );
}

function isCommitRecord(value: unknown): value is CoordinatorState["commits_reviewed"][number] {
  if (!isObject(value)) return false;
  return isString(value.sha) && isString(value.ts) && isString(value.run_id);
}

function optionalString(value: unknown): boolean {
  return value === undefined || isString(value);
}

function optionalNumber(value: unknown): boolean {
  return value === undefined || isNumber(value);
}

function isStateFinding(value: unknown): value is StateFinding {
  if (!isObject(value)) return false;
  return (
    isString(value.id) &&
    isString(value.source_surface) &&
    isSeverity(value.severity) &&
    isString(value.file) &&
    isNumber(value.line) &&
    isNumber(value.line_at_last_seen) &&
    isString(value.title_normalized) &&
    isString(value.title_original) &&
    isStatus(value.status) &&
    isString(value.first_seen_commit) &&
    isString(value.first_seen_run_id) &&
    isString(value.last_seen_commit) &&
    isString(value.last_seen_run_id) &&
    optionalString(value.dismissed_at_commit) &&
    optionalString(value.dismissed_by) &&
    optionalString(value.dismissed_reason) &&
    optionalString(value.resolved_at_commit) &&
    optionalString(value.reemerged_at_commit) &&
    optionalNumber(value.reemergence_count)
  );
}

function isCounters(value: unknown): value is CoordinatorState["counters"] {
  if (!isObject(value)) return false;
  return (
    isNumber(value.open) &&
    isNumber(value.resolved) &&
    isNumber(value.dismissed) &&
    isNumber(value.reemerged) &&
    isNumber(value.total_ever_seen)
  );
}

export function isCoordinatorState(value: unknown): value is CoordinatorState {
  if (!isObject(value)) return false;
  return (
    value.schema_version === CURRENT_SCHEMA_VERSION &&
    isString(value.last_run_id) &&
    isString(value.last_run_url) &&
    isString(value.last_run_ts) &&
    isString(value.last_head_sha) &&
    isString(value.last_base_sha) &&
    Array.isArray(value.commits_reviewed) &&
    value.commits_reviewed.every(isCommitRecord) &&
    Array.isArray(value.findings) &&
    value.findings.every(isStateFinding) &&
    isCounters(value.counters)
  );
}
