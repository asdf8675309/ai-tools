// Design note:
// `permanently_dismissed` findings that are re-emitted by a source surface are
// INTENTIONALLY not surfaced in user-facing buckets (newly_introduced,
// carried_over, reemerged, dismissed). The whole point of the
// permanently_dismissed status is "stop bothering the author about this." They
// are logged to stderr for telemetry/audit only — if a recurring permanently
// dismissed finding indicates a missed real issue, that decision belongs with
// the human reading the run log, not in the LLM-facing verdict.
import {
  CURRENT_SCHEMA_VERSION,
  type CoordinatorState,
  type DismissalRecord,
  type FindingSeverity,
  type StateFinding,
} from "./state-schema.ts";

export interface SourceFinding {
  source_surface: string;
  severity: FindingSeverity;
  file: string;
  line: number;
  title: string;
  id?: string;
}

export interface GitResult {
  ok: boolean;
}

export interface ComputeDeltaOptions {
  currentHeadSha: string;
  currentRunId: string;
  currentRunUrl: string;
  currentTs: string;
  baseSha: string;
  forcePushed: boolean;
  dismissalRecords: DismissalRecord[];
  renameMap: Map<string, string>;
}

export interface ComputeDeltaResult {
  state: CoordinatorState;
  newly_introduced: StateFinding[];
  carried_over: StateFinding[];
  resolved: StateFinding[];
  dismissed: StateFinding[];
  reemerged: StateFinding[];
}

export function findingIdentity(f: {
  source_surface: string;
  file: string;
  title: string;
}): string {
  const path = f.file.toLowerCase().trim();
  const title = normalizeTitle(f.title);
  return `${f.source_surface.toLowerCase().trim()}::${path}::${title}`;
}

export function applyRenameMap(
  state: CoordinatorState,
  renames: Map<string, string>,
): CoordinatorState {
  const renamedIds = new Set<string>();
  const renamedFindings = state.findings.map((finding) => {
    const renamedFile = renames.get(finding.file);
    if (renamedFile !== undefined) renamedIds.add(finding.id);
    return { ...finding, file: renamedFile ?? finding.file };
  });

  if (renames.size > 0) logRenameCollisions(renamedFindings, renamedIds);

  return {
    ...state,
    commits_reviewed: state.commits_reviewed.map((commit) => ({ ...commit })),
    findings: renamedFindings,
    counters: { ...state.counters },
  };
}

// A rename can collapse two distinct prior findings onto the same identity
// (source_surface::file::title). findPriorMatch then matches only one of them
// and the other silently loses its history. Log it — behavior is unchanged, this
// is diagnostics only. Only collision groups that a rename actually contributed
// to are reported.
function logRenameCollisions(findings: StateFinding[], renamedIds: Set<string>): void {
  const idsByIdentity = new Map<string, string[]>();
  for (const finding of findings) {
    const identity = findingIdentity({
      source_surface: finding.source_surface,
      file: finding.file,
      title: finding.title_normalized,
    });
    const ids = idsByIdentity.get(identity);
    if (ids) ids.push(finding.id);
    else idsByIdentity.set(identity, [finding.id]);
  }
  for (const [identity, ids] of idsByIdentity) {
    if (ids.length > 1 && ids.some((id) => renamedIds.has(id))) {
      console.error(
        `[compute-delta] rename collision: ${ids.length} prior findings collapsed to identity "${identity}" after rename (ids=${ids.join(", ")}); history may be mis-attributed`,
      );
    }
  }
}

export function detectForcePush(
  lastHeadSha: string | undefined,
  currentHeadSha: string,
  runGit: (args: string[]) => GitResult,
): boolean {
  if (!lastHeadSha) return false;
  // --end-of-options (git ≥2.24) so a `-`-prefixed SHA can never be parsed as a
  // flag. A bare `--` only separates pathspecs, not revisions.
  const result = runGit(["merge-base", "--is-ancestor", "--end-of-options", lastHeadSha, currentHeadSha]);
  return result.ok === false;
}

export function computeDelta(
  priorState: CoordinatorState | null,
  currentFindings: SourceFinding[],
  opts: ComputeDeltaOptions,
): ComputeDeltaResult {
  const renamedPrior = priorState ? applyRenameMap(priorState, opts.renameMap) : null;
  const priorFindings = renamedPrior?.findings ?? [];
  const matchedPriorIds = new Set<string>();
  const nextFindings: StateFinding[] = [];
  const newlyIntroduced: StateFinding[] = [];
  const carriedOver: StateFinding[] = [];
  const resolved: StateFinding[] = [];
  // Note: the dismissed bucket isn't accumulated here — applyDismissals (below)
  // returns the authoritative dismissed list.
  const reemerged: StateFinding[] = [];

  for (const current of currentFindings) {
    const match = findPriorMatch(current, priorFindings, matchedPriorIds);
    if (!match) {
      const created = createStateFinding(current, opts);
      nextFindings.push(created);
      newlyIntroduced.push(created);
      continue;
    }

    matchedPriorIds.add(match.id);
    const updated = updateSeenFinding(match, current, opts);

    if (opts.forcePushed) {
      const reset = resetFirstSeen(updated, opts);
      nextFindings.push(reset);
      newlyIntroduced.push(reset);
      continue;
    }

    if (match.status === "dismissed") {
      const count = (match.reemergence_count ?? 0) + 1;
      const reemergedFinding: StateFinding = {
        ...updated,
        status: count >= 3 ? "permanently_dismissed" : "reemerged",
        reemerged_at_commit: opts.currentHeadSha,
        reemergence_count: count,
      };
      nextFindings.push(reemergedFinding);
      if (reemergedFinding.status === "reemerged") reemerged.push(reemergedFinding);
      continue;
    }

    if (match.status === "permanently_dismissed") {
      const reCount = (match.reemergence_count ?? 0) + 1;
      console.error(
        `[compute-delta] source surface re-emitted permanently_dismissed finding: id=${match.id} count=${reCount}`,
      );
      nextFindings.push({
        ...updated,
        status: "permanently_dismissed",
        reemergence_count: reCount,
      });
      continue;
    }

    if (match.status === "resolved") {
      const reopened = resetFirstSeen(
        {
          ...updated,
          status: "open",
          resolved_at_commit: undefined,
        },
        opts,
      );
      nextFindings.push(reopened);
      newlyIntroduced.push(reopened);
      continue;
    }

    const openFinding: StateFinding = {
      ...updated,
      status: "open",
      resolved_at_commit: undefined,
    };
    nextFindings.push(openFinding);
    carriedOver.push(openFinding);
  }

  for (const prior of priorFindings) {
    if (matchedPriorIds.has(prior.id)) continue;

    if (opts.forcePushed) {
      nextFindings.push({ ...prior });
      continue;
    }

    if (prior.status === "open" || prior.status === "reemerged") {
      const resolvedFinding: StateFinding = {
        ...prior,
        status: "resolved",
        resolved_at_commit: opts.currentHeadSha,
      };
      nextFindings.push(resolvedFinding);
      resolved.push(resolvedFinding);
      continue;
    }

    nextFindings.push({ ...prior });
  }

  const stateBeforeDismissals = buildState(renamedPrior, nextFindings, opts);
  const afterDismissals = applyDismissals(
    stateBeforeDismissals,
    opts.dismissalRecords,
    priorState?.last_run_ts,
    opts.currentHeadSha,
  );

  return {
    state: afterDismissals.state,
    newly_introduced: removeDismissedFromBucket(newlyIntroduced, afterDismissals.state),
    carried_over: removeDismissedFromBucket(carriedOver, afterDismissals.state),
    resolved,
    dismissed: afterDismissals.dismissed,
    reemerged: removeDismissedFromBucket(reemerged, afterDismissals.state),
  };
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[`'"]/g, "")
    .replace(/:\d+/g, "")
    .replace(/\((?:\d+|\$\{[^}]+\})\)/g, "")
    .trim();
}

function findPriorMatch(
  current: SourceFinding,
  priorFindings: StateFinding[],
  matchedPriorIds: Set<string>,
): StateFinding | null {
  const identity = findingIdentity(current);
  for (const prior of priorFindings) {
    if (matchedPriorIds.has(prior.id)) continue;
    const priorIdentity = findingIdentity({
      source_surface: prior.source_surface,
      file: prior.file,
      title: prior.title_normalized,
    });
    if (priorIdentity !== identity) continue;
    if (Math.abs(prior.line_at_last_seen - current.line) > 20) continue;
    return prior;
  }
  return null;
}

// Scrub title fields BEFORE storing them in StateFinding. The state JSON
// survives across runs and gets re-injected into the LLM prompt, bypassing
// fetch-surfaces.ts's delimiter scrub. An attacker who controls a source-surface
// finding title could otherwise inject prompt fragments that persist forever via
// state.
function scrubForPromptStorage(s: string): string {
  return s
    .replace(/<!--\s*SURFACE_INPUT\s*-->/gi, "[redacted-delim]")
    .replace(/<!--\s*\/SURFACE_INPUT\s*-->/gi, "[redacted-delim]")
    .replace(/<!--\s*coordinator-state\s*-->/gi, "[redacted-marker]")
    .replace(/<!--\s*coordinator-judge\s*-->/gi, "[redacted-marker]")
    .replace(/```+/g, "[redacted-fence]")
    .slice(0, 500);
}

function createStateFinding(current: SourceFinding, opts: ComputeDeltaOptions): StateFinding {
  return {
    id: current.id ?? buildFindingId(current),
    source_surface: current.source_surface,
    severity: current.severity,
    file: current.file,
    line: current.line,
    line_at_last_seen: current.line,
    title_normalized: scrubForPromptStorage(normalizeTitle(current.title)),
    title_original: scrubForPromptStorage(current.title),
    status: "open",
    first_seen_commit: opts.currentHeadSha,
    first_seen_run_id: opts.currentRunId,
    last_seen_commit: opts.currentHeadSha,
    last_seen_run_id: opts.currentRunId,
  };
}

function updateSeenFinding(
  prior: StateFinding,
  current: SourceFinding,
  opts: ComputeDeltaOptions,
): StateFinding {
  return {
    ...prior,
    source_surface: current.source_surface,
    severity: current.severity,
    file: current.file,
    line_at_last_seen: current.line,
    title_normalized: scrubForPromptStorage(normalizeTitle(current.title)),
    title_original: scrubForPromptStorage(current.title),
    last_seen_commit: opts.currentHeadSha,
    last_seen_run_id: opts.currentRunId,
  };
}

function resetFirstSeen(finding: StateFinding, opts: ComputeDeltaOptions): StateFinding {
  return {
    ...finding,
    status: "open",
    first_seen_commit: opts.currentHeadSha,
    first_seen_run_id: opts.currentRunId,
    resolved_at_commit: undefined,
    dismissed_at_commit: undefined,
    dismissed_by: undefined,
    dismissed_reason: undefined,
    reemerged_at_commit: undefined,
  };
}

function buildState(
  priorState: CoordinatorState | null,
  findings: StateFinding[],
  opts: ComputeDeltaOptions,
): CoordinatorState {
  const commits = [
    ...(priorState?.commits_reviewed.map((commit) => ({ ...commit })) ?? []),
    { sha: opts.currentHeadSha, ts: opts.currentTs, run_id: opts.currentRunId },
  ];

  return withCounters({
    schema_version: CURRENT_SCHEMA_VERSION,
    last_run_id: opts.currentRunId,
    last_run_url: opts.currentRunUrl,
    last_run_ts: opts.currentTs,
    last_head_sha: opts.currentHeadSha,
    last_base_sha: opts.baseSha,
    commits_reviewed: dedupeCommits(commits),
    findings,
    counters: { open: 0, resolved: 0, dismissed: 0, reemerged: 0, total_ever_seen: 0 },
  });
}

function applyDismissals(
  state: CoordinatorState,
  records: DismissalRecord[],
  priorRunTs: string | undefined,
  currentHeadSha: string,
): { state: CoordinatorState; dismissed: StateFinding[] } {
  const dismissed: StateFinding[] = [];
  const latestById = latestDismissalById(records, priorRunTs);
  const findings = state.findings.map((finding) => {
    const record = latestById.get(finding.id);
    if (!record) return finding;
    if (finding.status === "permanently_dismissed") return finding;
    if (finding.status === "dismissed") return finding;

    const updated: StateFinding = {
      ...finding,
      status: "dismissed",
      dismissed_at_commit: currentHeadSha,
      dismissed_by: record.author,
      dismissed_reason: record.reason,
    };
    dismissed.push(updated);
    return updated;
  });

  for (const record of latestById.values()) {
    if (!state.findings.some((finding) => finding.id === record.finding_id)) {
      console.error(
        `[coordinator-dismissals] dismissal ignored for unknown finding_id=${record.finding_id}`,
      );
    }
  }

  return { state: withCounters({ ...state, findings }), dismissed };
}

function latestDismissalById(
  records: DismissalRecord[],
  priorRunTs: string | undefined,
): Map<string, DismissalRecord> {
  const cutoff = priorRunTs ? Date.parse(priorRunTs) : Number.NEGATIVE_INFINITY;
  const byId = new Map<string, DismissalRecord>();
  for (const record of records) {
    const recordTs = Date.parse(record.ts);
    if (Number.isFinite(recordTs) && recordTs <= cutoff) continue;
    const existing = byId.get(record.finding_id);
    if (!existing || Date.parse(existing.ts) <= recordTs) byId.set(record.finding_id, record);
  }
  return byId;
}

function removeDismissedFromBucket(
  bucket: StateFinding[],
  state: CoordinatorState,
): StateFinding[] {
  const byId = new Map(state.findings.map((finding) => [finding.id, finding]));
  return bucket
    .map((finding) => byId.get(finding.id) ?? finding)
    .filter((finding) => finding.status === "open");
}

/**
 * Recount the status buckets from the findings themselves. Exported because
 * call-coordinator.ts recounts after its own state edits and carried a private
 * copy of this loop — two counters that had to be kept in step by hand.
 */
export function withCounters(state: CoordinatorState): CoordinatorState {
  const counters = {
    open: 0,
    resolved: 0,
    dismissed: 0,
    reemerged: 0,
    total_ever_seen: state.findings.length,
  };
  for (const finding of state.findings) {
    if (finding.status === "open") counters.open += 1;
    if (finding.status === "resolved") counters.resolved += 1;
    if (finding.status === "dismissed" || finding.status === "permanently_dismissed") {
      counters.dismissed += 1;
    }
    if (finding.status === "reemerged") counters.reemerged += 1;
  }
  return { ...state, counters };
}

function dedupeCommits(
  commits: CoordinatorState["commits_reviewed"],
): CoordinatorState["commits_reviewed"] {
  const seen = new Set<string>();
  const out: CoordinatorState["commits_reviewed"] = [];
  for (const commit of commits) {
    const key = `${commit.sha}:${commit.run_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(commit);
  }
  return out;
}

function buildFindingId(finding: SourceFinding): string {
  const prefix =
    finding.severity === "CRITICAL" ? "CRT" : finding.severity === "WARNING" ? "WRN" : "SUG";
  return `${prefix}-${fnv1a(`${findingIdentity(finding)}::${finding.line}`).toString(36).toUpperCase()}`;
}

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
