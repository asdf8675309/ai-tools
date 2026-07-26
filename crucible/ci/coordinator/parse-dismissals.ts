import type { DismissalRecord } from "./state-schema.ts";

export interface DismissalComment {
  body: string;
  user: { login: string };
  author_association: string;
  created_at: string;
}

const WRITE_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

// Associations allowed to dismiss when the commenter is the PR author.
// Superset of WRITE_ASSOCIATIONS plus CONTRIBUTOR — i.e. "CONTRIBUTOR or above".
// A fork PR author with author_association NONE or FIRST_TIME_CONTRIBUTOR is
// therefore NOT allowed to dismiss findings on their own PR; without this gate
// such an author could, via the 3-reemergence permanently_dismissed rule, burn
// any finding down to unrecoverable in three force-pushes.
const DISMISS_AUTHOR_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR"]);

// Cap on actionable /dismiss commands parsed per comment. Bounds telemetry: a
// single 50KB comment with thousands of /dismiss lines would otherwise flood the
// dismissal records and the stderr audit log.
const MAX_DISMISSALS_PER_COMMENT = 10;

export function parseDismissalCommands(
  comments: DismissalComment[],
  prAuthor: string,
): DismissalRecord[] {
  const records: DismissalRecord[] = [];

  for (const comment of comments) {
    // Anchor to line-start with multiline mode. This prevents substring matches
    // inside prose ("we should /dismiss that one") while still allowing several
    // slash commands in one multi-line comment.
    const dismissRegex = /^\s*\/dismiss\s+(\S+)(?:\s+["']?(.+?)["']?)?\s*$/gim;
    let parsedInComment = 0;
    for (const match of comment.body.matchAll(dismissRegex)) {
      if (parsedInComment >= MAX_DISMISSALS_PER_COMMENT) {
        console.error(
          `[coordinator-dismissals] per-comment cap (${MAX_DISMISSALS_PER_COMMENT}) reached for login=${comment.user.login}; ignoring remaining /dismiss commands in this comment`,
        );
        break;
      }
      parsedInComment += 1;

      const findingId = match[1] ?? "";
      const login = comment.user.login;
      const authorized =
        WRITE_ASSOCIATIONS.has(comment.author_association) ||
        (login === prAuthor && DISMISS_AUTHOR_ASSOCIATIONS.has(comment.author_association));

      if (!authorized) {
        console.error(
          `[coordinator-dismissals] unauthorized dismissal ignored: login=${login} finding_id=${findingId}`,
        );
        continue;
      }

      records.push({
        finding_id: findingId,
        reason: scrubDismissalReason(match[2]?.trim() ?? ""),
        author: login,
        ts: comment.created_at,
      });
    }
  }

  return records;
}

// Scrub attacker-controlled free-form text from a /dismiss reason BEFORE it
// lands in state. Scoped tightly to this single field — the structured state
// JSON itself is NOT scrubbed (see renderStateComment in call-coordinator.ts for
// why). Strips:
//  - coordinator markers (prevent state/verdict comment-detection poisoning when
//    the state JSON is re-rendered)
//  - triple-backtick fence sequences (prevent breakout of the json fence in the
//    state comment's <details> block)
//  - Bearer-token-shaped + long-alnum strings (defense in depth against
//    accidentally-pasted secrets in dismissal reasons)
function scrubDismissalReason(s: string): string {
  return s
    .replace(/<!--\s*coordinator-state\s*-->/gi, "[redacted-marker]")
    .replace(/<!--\s*coordinator-judge\s*-->/gi, "[redacted-marker]")
    .replace(/```+/g, "[redacted-fence]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    // Known secret prefixes, redacted by shape regardless of length, so a pasted
    // secret shorter than the generic heuristic below is still caught.
    .replace(/\b(ghp_|gho_|ghu_|ghs_|ghr_|sk-ant-|sk-|sk_|cf_|xoxb-|xoxp-)[A-Za-z0-9_-]+/g, "[REDACTED-PREFIXED-TOKEN]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[REDACTED-TOKEN-SHAPE]");
}
