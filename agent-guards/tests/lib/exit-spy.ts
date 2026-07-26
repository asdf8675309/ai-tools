/**
 * exit-spy.ts — test-only helper for calling a guard's real `main()` (the
 * exact function Claude Code invokes) without letting a `block()`-triggered
 * `process.exit(2)` kill the bun:test process.
 *
 * This is standard practice for testing code that calls process.exit: swap
 * it out for the duration of one call, have it throw instead of terminating,
 * and unwind via the normal JS exception path — which mirrors what a real
 * exit does (nothing after it runs) while staying observable and recoverable.
 * The swap is scoped to a single `withExitSpy()` call and always restored in
 * a `finally`, so it can never leak into an unrelated test.
 */

class ExitCalled extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

export interface ExitSpyResult {
  /** The code process.exit was called with, or undefined if it was never called. */
  exitCode: number | undefined;
  /** Everything written to stderr during the call. */
  stderr: string;
  /** Everything written to stdout during the call. */
  stdout: string;
}

export function withExitSpy(fn: () => void): ExitSpyResult {
  const originalExit = process.exit;
  const originalErrWrite = process.stderr.write.bind(process.stderr);
  const originalOutWrite = process.stdout.write.bind(process.stdout);
  let exitCode: number | undefined;
  let stderr = '';
  let stdout = '';
  process.exit = (code?: number) => {
    exitCode = code ?? 0;
    throw new ExitCalled(exitCode);
  };
  process.stderr.write = (chunk: string) => {
    stderr += chunk;
    return true;
  };
  process.stdout.write = (chunk: string) => {
    stdout += chunk;
    return true;
  };

  try {
    fn();
  } catch (e) {
    if (!(e instanceof ExitCalled)) throw e;
  } finally {
    process.exit = originalExit;
    process.stderr.write = originalErrWrite;
    process.stdout.write = originalOutWrite;
  }

  return { exitCode, stderr, stdout };
}
