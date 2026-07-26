import { CURRENT_SCHEMA_VERSION, isCoordinatorState, type CoordinatorState } from "./state-schema.ts";

const STATE_MARKER = "<!-- coordinator-state -->";

export function parseStateComment(commentBody: string | null): CoordinatorState | null {
  // Distinct stderr per outcome, so "no prior state" (a seed run) is
  // distinguishable from "prior state corrupted" in the run log. Both return
  // null; only the log tells you which happened.
  if (!commentBody) {
    console.error("[coordinator-state] no prior state: empty comment body (seed run)");
    return null;
  }

  const markerIndex = commentBody.indexOf(STATE_MARKER);
  if (markerIndex < 0) {
    console.error("[coordinator-state] no prior state: STATE_MARKER not found (seed run)");
    return null;
  }

  const afterMarker = commentBody.slice(markerIndex + STATE_MARKER.length);

  // Anchor to the "State JSON" <details> wrapper that renderStateComment emits,
  // so a decoy ```json fence appearing between the marker and the real state
  // block (e.g. an LLM reply quoting the state) cannot be picked instead of the
  // authoritative block. Fall back to the LAST json fence after the marker when
  // the anchor is absent (older comment shape) — the state block is always
  // rendered last.
  const summaryMatch = /<summary>\s*State JSON\s*<\/summary>/i.exec(afterMarker);
  let fenceBody: string | null = null;
  if (summaryMatch) {
    const region = afterMarker.slice(summaryMatch.index + summaryMatch[0].length);
    const anchored = /```json\s*([\s\S]*?)\s*```/i.exec(region);
    if (anchored?.[1] !== undefined) fenceBody = anchored[1];
  } else {
    const all = [...afterMarker.matchAll(/```json\s*([\s\S]*?)\s*```/gi)];
    const last = all[all.length - 1];
    if (last?.[1] !== undefined) fenceBody = last[1];
  }

  if (fenceBody === null) {
    console.error("[coordinator-state] parse failed: missing json fence");
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fenceBody);
  } catch (e) {
    console.error(`[coordinator-state] parse failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }

  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "schema_version" in parsed &&
    typeof parsed.schema_version === "number" &&
    parsed.schema_version > CURRENT_SCHEMA_VERSION
  ) {
    console.error(
      `[coordinator-state] parse failed: unsupported schema version ${parsed.schema_version}`,
    );
    return null;
  }

  if (!isCoordinatorState(parsed)) {
    console.error("[coordinator-state] parse failed: invalid schema");
    return null;
  }

  return parsed;
}
