/// <reference types="node" />

import { describe, expect, it } from "vitest";

import { resolve } from "node:path";
import { spawn } from "node:child_process";

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runGuard(optIn: boolean): Promise<Result> {
  return new Promise((resolveResult, rejectResult) => {
    const env = { ...process.env };
    if (optIn) {
      env.COMPUTER_USE_ALLOW_REAL_INPUT = "1";
    } else {
      delete env.COMPUTER_USE_ALLOW_REAL_INPUT;
    }
    const child = spawn(
      process.execPath,
      [resolve("scripts/confirm-real-input.mjs")],
      {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectResult);
    child.once("exit", (code) => resolveResult({ code, stdout, stderr }));
    child.stdin.end();
  });
}

describe("real-input command guard", () => {
  it("refuses non-interactive execution without explicit opt-in", async () => {
    const result = await runGuard(false);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("REFUSING TO POST REAL INPUT");
    expect(result.stderr).toContain("COMPUTER_USE_ALLOW_REAL_INPUT=1");
  });

  it("allows a non-interactive run only with explicit opt-in", async () => {
    const result = await runGuard(true);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "real mouse/keyboard input explicitly enabled",
    );
  });
});
