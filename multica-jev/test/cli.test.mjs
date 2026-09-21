import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const BIN = fileURLToPath(new URL("../bin/multica-jev.mjs", import.meta.url));

// Every case here fails before the transport is reached, so the CLI suite
// makes no network call and needs no credential.
async function runCli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args], { env: { PATH: process.env.PATH } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

test("an unreadable @questions file is reported as a CLI error, not a crash", async () => {
  const { code, stderr } = await runCli(["--state", "s", "--purpose", "custom", "--questions", "@/nonexistent/nope.json"]);
  assert.notEqual(code, 0);
  assert.match(stderr, /^multica-jev error: /m);
  assert.doesNotMatch(stderr, /triggerUncaughtException/, "a raw Node stack trace must not reach the user");
  assert.doesNotMatch(stderr, /at async main/);
});

test("a malformed @questions file is reported as a CLI error", async () => {
  const path = new URL("./fixtures-bad-questions.tmp.json", import.meta.url);
  await (await import("node:fs/promises")).writeFile(path, "{not json");
  try {
    const { code, stderr } = await runCli(["--state", "s", "--purpose", "custom", "--questions", `@${fileURLToPath(path)}`]);
    assert.notEqual(code, 0);
    assert.match(stderr, /questions_json is not valid JSON/);
  } finally {
    await (await import("node:fs/promises")).rm(path, { force: true });
  }
});

test("a missing --state prints usage and exits 2", async () => {
  const { code, stderr } = await runCli(["--purpose", "triage"]);
  assert.equal(code, 2);
  assert.match(stderr, /Usage: multica-jev/);
});
