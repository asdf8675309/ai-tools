/**
 * Crucible — shared CLI plumbing for the skill's tools.
 *
 * Each tool's `import.meta.main` block hand-rolled the same three things: an
 * outcome record, `indexOf("--flag") + 1` argument reading, and the
 * stderr-then-stdout-then-exit epilogue. The ORDER in that epilogue is the part
 * worth stating once — stderr (the audit line) is written before stdout (the
 * bare verdict a shell gates on), so a `$(...)`-captured verdict is never
 * interleaved with prose.
 */

export interface CliOutcome {
  /** The machine-readable result: a bare verdict, or JSON under --json. */
  stdout: string;
  /** The human/audit line. Written first, so it cannot pollute a captured stdout. */
  stderr: string;
  exitCode: number;
}

/**
 * The value after `--flag`, or `fallback`. Returns the fallback for a trailing
 * flag with no value, so `--base` at the end of argv cannot yield undefined and
 * silently diff against the string "undefined".
 */
export function flagValue(argv: string[], flag: string, fallback: string): string {
  const i = argv.indexOf(flag);
  if (i < 0) return fallback;
  return argv[i + 1] ?? fallback;
}

/** Print an outcome the way every tool here prints one, then exit. */
export function emitOutcome(outcome: CliOutcome): never {
  if (outcome.stderr) console.error(outcome.stderr);
  if (outcome.stdout) console.log(outcome.stdout);
  process.exit(outcome.exitCode);
}
