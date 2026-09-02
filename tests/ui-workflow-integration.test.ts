/// <reference types="node" />

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { NativeClient } from "../src/native/client.js";
import { access } from "node:fs/promises";
import { createInterface, type Interface } from "node:readline";
import { createServer } from "../src/server.js";
import { resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const helperPath = resolve("native/.build/release/ComputerUseNative");
const semanticTargetPath = resolve(
  "native/.build/release/SemanticWorkflowTestTarget",
);

interface PassiveTarget {
  child: ChildProcessWithoutNullStreams;
  lines: Interface;
  processId: number;
}

async function startTarget(): Promise<PassiveTarget> {
  const child = spawn(semanticTargetPath, [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, SEMANTIC_WORKFLOW_PASSIVE: "1" },
  });
  const lines = createInterface({ input: child.stdout });
  const processId = await new Promise<number>((resolveReady, rejectReady) => {
    const timeout = setTimeout(
      () => rejectReady(new Error("Semantic workflow target timed out")),
      10_000,
    );
    const fail = (error: Error) => {
      clearTimeout(timeout);
      rejectReady(error);
    };
    lines.on("line", (line) => {
      try {
        const event = JSON.parse(line) as { type?: string; processId?: number };
        if (event.type === "ready" && typeof event.processId === "number") {
          clearTimeout(timeout);
          resolveReady(event.processId);
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.once("error", fail);
    child.once("exit", (code, signal) =>
      fail(new Error(`Target exited (${signal ?? code}) before readiness`)),
    );
  });
  return { child, lines, processId };
}

async function stopTarget(target: PassiveTarget | undefined): Promise<void> {
  if (target === undefined) return;
  target.lines.close();
  if (target.child.exitCode !== null) return;
  target.child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolveExit) =>
      target.child.once("exit", () => resolveExit()),
    ),
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
  ]);
  if (target.child.exitCode === null) target.child.kill("SIGKILL");
}

describe("ui_workflow disposable-target integration", () => {
  let native: NativeClient;
  let server: ReturnType<typeof createServer>;
  let client: Client;

  beforeAll(async () => {
    await Promise.all([access(helperPath), access(semanticTargetPath)]);
    native = new NativeClient({ executablePath: helperPath });
    server = createServer(native, undefined);
    client = new Client({ name: "workflow-integration", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
    await native.close();
  });

  it("fills, submits, and waits through one bounded workflow", async () => {
    const health = await native.request<{
      permissions: { accessibility: boolean };
    }>("health");
    if (!health.permissions.accessibility) return;

    let target: PassiveTarget | undefined;
    try {
      target = await startTarget();
      const result = await client.callTool({
        name: "ui_workflow",
        arguments: {
          scope: { processId: target.processId },
          timeoutMs: 20_000,
          steps: [
            {
              kind: "fill",
              fields: [
                {
                  target: { roles: ["AXTextField"], name: "Workflow text" },
                  value: "Project Alpha ready",
                },
              ],
              postcondition: {
                kind: "element",
                target: { name: "Workflow text" },
                state: "appears",
              },
            },
            {
              kind: "act",
              target: { roles: ["AXButton"], name: "Submit workflow" },
              action: "press",
              postcondition: {
                kind: "element",
                target: { name: "Submitted: Project Alpha ready" },
                state: "appears",
              },
            },
            {
              kind: "wait",
              condition: {
                kind: "element",
                target: { name: "Submitted: Project Alpha ready" },
                state: "appears",
              },
            },
          ],
        },
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        outcome: "verified",
        completedStepCount: 3,
        stoppedAtStep: null,
        steps: [
          { kind: "fill", status: "verified" },
          { kind: "act", status: "verified" },
          { kind: "wait", status: "satisfied" },
        ],
      });
      expect(JSON.stringify(result.structuredContent)).not.toContain(
        "Project Alpha ready",
      );
    } finally {
      await stopTarget(target);
    }
  });
});
