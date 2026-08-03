// verdict.ts — the verdict vocabulary shared by the reviewer and the
// coordinator. Both render the same four verdicts into the same four glyphs at
// the top of their sticky comment; keeping one table means a new verdict cannot
// render as a question mark in one comment and a real glyph in the other.

export function verdictEmoji(v: string): string {
  if (v === "APPROVE") return "✅";
  if (v === "APPROVE_WITH_COMMENTS") return "⚠️";
  if (v === "BLOCK") return "🛑";
  return "❓";
}
