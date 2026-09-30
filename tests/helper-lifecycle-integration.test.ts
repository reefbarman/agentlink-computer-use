import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { describe, expect, it } from "vitest";
import { NativeClient } from "../src/native/client.js";
import { initialLmStudioStatus } from "../src/semantic/lm-studio-status.js";

const nativePath = resolve("native/.build/release/ComputerUseNative");
const serverPath = resolve("dist/index.js");

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function readResponse(
  child: ChildProcessWithoutNullStreams,
  lines: Interface,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = once(lines, "line");
  child.stdin.write(`${JSON.stringify(request)}\n`);
  const [line] = await response;
  return JSON.parse(line as string) as Record<string, unknown>;
}

async function cleanup(
  child: ChildProcessWithoutNullStreams,
  lines: Interface,
  helperPid: number | undefined,
): Promise<void> {
  lines.close();
  child.stdin.destroy();
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
  if (helperPid !== undefined && isRunning(helperPid)) {
    process.kill(helperPid, "SIGTERM");
    try {
      await expect
        .poll(() => isRunning(helperPid), { timeout: 3_000 })
        .toBe(false);
    } finally {
      if (isRunning(helperPid)) process.kill(helperPid, "SIGKILL");
    }
  }
}

// These regressions use health and status requests only, never capture or input.
describe("helper lifecycle", () => {
  it("stores LM Studio readiness and nullable failure history without changing control state", async () => {
    const native = new NativeClient({ executablePath: nativePath });
    try {
      const before = await native.request<{ control: unknown }>("health");
      const status = {
        ...initialLmStudioStatus(),
        state: "ready" as const,
        model: "qwen/qwen3-vl-8b",
        checkedAt: new Date().toISOString(),
        lastUsed: {
          at: new Date().toISOString(),
          model: "qwen/qwen3-vl-8b",
          durationMs: 12.5,
        },
        lastFailure: {
          at: new Date().toISOString(),
          reason: "provider_model_selection",
          model: null,
        },
      };
      await native.updateLmStudioStatus(status);
      const after = await native.request<{
        lmStudio: unknown;
        control: unknown;
      }>("health");
      expect(after.lmStudio).toEqual(status);
      expect(after.control).toEqual(before.control);
      await expect(
        native.request("lmStudio.status", {
          ...status,
          lastUsed: { ...status.lastUsed, durationMs: true },
        }),
      ).rejects.toMatchObject({ code: "invalid_argument" });
      await expect(
        native.request("lmStudio.status", {
          ...status,
          checkedAt: "not-a-date",
        }),
      ).rejects.toMatchObject({ code: "invalid_argument" });
      await expect(
        native.request("lmStudio.status", { ...status, model: "" }),
      ).rejects.toMatchObject({ code: "invalid_argument" });
      const unchanged = await native.request<{ lmStudio: unknown }>("health");
      expect(unchanged.lmStudio).toEqual(status);
    } finally {
      await native.close();
    }
  });

  it("exits the MCP server and helper when the client closes stdin", async () => {
    const child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, COMPUTER_USE_NATIVE_PATH: nativePath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout });
    let helperPid: number | undefined;
    try {
      await readResponse(child, lines, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "lifecycle-test", version: "1.0.0" },
        },
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
      const response = await readResponse(child, lines, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "computer_status", arguments: {} },
      });
      const result = response.result as {
        isError?: boolean;
        structuredContent: { process: { pid: number } };
      };
      expect(result.isError).not.toBe(true);
      helperPid = result.structuredContent.process.pid;
      expect(isRunning(helperPid)).toBe(true);

      child.stdin.end();
      await expect.poll(() => child.exitCode, { timeout: 5_000 }).toBe(0);
      await expect
        .poll(() => isRunning(helperPid!), { timeout: 5_000 })
        .toBe(false);
    } finally {
      await cleanup(child, lines, helperPid);
    }
  });

  it("exits through cleanup rather than SIGPIPE when stdout closes", async () => {
    const child = spawn(nativePath, ["serve"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout });
    try {
      const response = await readResponse(child, lines, {
        id: "health",
        version: 1,
        method: "health",
        params: {},
      });
      expect(response.ok).toBe(true);
      const closed = once(child.stdout, "close");
      child.stdout.destroy();
      await closed;
      child.stdin.write(
        `${JSON.stringify({ id: "broken-pipe", version: 1, method: "health", params: {} })}\n`,
      );
      await expect.poll(() => child.exitCode, { timeout: 5_000 }).toBe(1);
      expect(child.signalCode).toBeNull();
    } finally {
      await cleanup(child, lines, child.pid);
    }
  });

  it("exits the native helper if its parent dies while stdin remains open", async () => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import { spawn } from "node:child_process"; spawn(process.env.COMPUTER_USE_NATIVE_PATH, ["serve"], { stdio: "inherit" });',
      ],
      {
        env: { ...process.env, COMPUTER_USE_NATIVE_PATH: nativePath },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const lines = createInterface({ input: child.stdout });
    let helperPid: number | undefined;
    try {
      const response = await readResponse(child, lines, {
        id: "health",
        version: 1,
        method: "health",
        params: {},
      });
      expect(response.ok).toBe(true);
      const result = response.result as { process: { pid: number } };
      helperPid = result.process.pid;
      expect(isRunning(helperPid)).toBe(true);

      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      // The native helper inherited this pipe directly. Keep our write end open
      // so EOF cannot hide a broken parent-exit handler.
      expect(child.stdin.writableEnded).toBe(false);
      await expect
        .poll(() => isRunning(helperPid!), { timeout: 5_000 })
        .toBe(false);
    } finally {
      await cleanup(child, lines, helperPid);
    }
  });
});
