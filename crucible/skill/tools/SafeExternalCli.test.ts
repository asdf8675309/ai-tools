import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { fileURLToPath } from "node:url";
const WORKFLOW = new URL("../workflows/crucible.workflow.js", import.meta.url);
const RUNNER = new URL("./safe-external-cli.sh", import.meta.url);

describe("external CLI environment isolation", () => {
  test("the external CLI instructions require env -i and an isolation marker", () => {
    const source = readFileSync(WORKFLOW, "utf8");
    expect(source).toContain("safe-external-cli.sh");
    expect(source).toContain("env -i");
    expect(source).toContain("CRUCIBLE_ENV_ISOLATED=1");
    expect(source).toContain("never pass SSH_AUTH_SOCK");
    expect(source).toContain("do NOT retry with the inherited environment");
  });

  test("the scrubbed runner removes credential-shaped variables and SSH agent state", () => {
    const output = execFileSync(fileURLToPath(RUNNER), ["env"], {
      env: {
        PATH: "/usr/bin:/bin",
        SYNTH_AWS_ACCESS_KEY_ID: "must-not-leak",
        SYNTH_API_KEY: "must-not-leak",
        SYNTH_TOKEN: "must-not-leak",
        SYNTH_SECRET: "must-not-leak",
        SSH_AUTH_SOCK: "/tmp/synthetic-agent.sock",
      },
      encoding: "utf8",
    });
    expect(output).toContain("CRUCIBLE_ENV_ISOLATED=1");
    expect(output).not.toContain("SYNTH_AWS_ACCESS_KEY_ID");
    expect(output).not.toContain("SYNTH_API_KEY");
    expect(output).not.toContain("SYNTH_TOKEN");
    expect(output).not.toContain("SYNTH_SECRET");
    expect(output).not.toContain("SSH_AUTH_SOCK");
  });

  test("the scrubbed runner preserves required non-secret runtime metadata", () => {
    const output = execFileSync(fileURLToPath(RUNNER), ["env"], {
      env: {
        PATH: "/usr/bin:/bin",
        HOME: "/synthetic/home",
        TMPDIR: "/synthetic/tmp",
        LANG: "en_US.UTF-8",
        LC_ALL: "C",
        TERM: "dumb",
        PWD: "/synthetic/worktree",
        USER: "synthetic-user",
        LOGNAME: "synthetic-user",
        SHELL: "/bin/sh",
      },
      encoding: "utf8",
    });
    expect(output).toMatch(/^PWD=/m);
    for (const entry of [
      "PATH=/usr/bin:/bin",
      "HOME=/synthetic/home",
      "TMPDIR=/synthetic/tmp",
      "LANG=en_US.UTF-8",
      "LC_ALL=C",
      "TERM=dumb",
      "USER=synthetic-user",
      "LOGNAME=synthetic-user",
      "SHELL=/bin/sh",
      "CRUCIBLE_ENV_ISOLATED=1",
    ]) {
      expect(output).toContain(entry);
    }
  });

  test("fails closed when the env primitive cannot be resolved", () => {
    const result = spawnSync(fileURLToPath(RUNNER), ["env"], {
      env: { PATH: "/definitely-missing-synthetic-path" },
      encoding: "utf8",
    });
    expect(result.status).toBe(125);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("env command unavailable; refusing dispatch");
  });
});
