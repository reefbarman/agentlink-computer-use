/// <reference types="node" />

import {
  accessibilityActSchema,
  accessibilityFillSchema,
  accessibilityQuerySchema,
  accessibilityWaitSchema,
} from "../src/semantic/contracts.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { NativeClient } from "../src/native/client.js";
import { access } from "node:fs/promises";
import { consumeCaptureArtifact } from "../src/native/artifacts.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { resolve } from "node:path";

const helperPath = resolve("native/.build/release/ComputerUseNative");
const semanticTargetPath = resolve(
  "native/.build/release/SemanticWorkflowTestTarget",
);
let client: NativeClient;

interface PassiveSemanticTarget {
  child: ChildProcessWithoutNullStreams;
  lines: Interface;
  processId: number;
}

async function startPassiveSemanticTarget(): Promise<PassiveSemanticTarget> {
  const child = spawn(semanticTargetPath, [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, SEMANTIC_WORKFLOW_PASSIVE: "1" },
  });
  const lines = createInterface({ input: child.stdout });
  const processId = await new Promise<number>((resolveReady, rejectReady) => {
    const timeout = setTimeout(
      () => rejectReady(new Error("Passive semantic target timed out")),
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
      fail(
        new Error(
          `Passive semantic target exited (${signal ?? code}) before readiness`,
        ),
      ),
    );
  });
  return { child, lines, processId };
}

async function stopPassiveSemanticTarget(
  target: PassiveSemanticTarget | undefined,
): Promise<void> {
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

beforeAll(async () => {
  await access(helperPath);
  client = new NativeClient({ executablePath: helperPath });
});

afterAll(async () => {
  await client.close();
});

describe("native helper integration", () => {
  it("serves health over protocol-v1 NDJSON", async () => {
    const result = await client.request<Record<string, unknown>>("health");

    expect(result).toMatchObject({
      control: {
        inputEnabled: expect.any(Boolean),
        indicatorAvailable: true,
        state: expect.stringMatching(/^(idle|paused)$/),
      },
      permissions: {
        accessibility: expect.any(Boolean),
        "post-event": expect.any(Boolean),
        "screen-capture": expect.any(Boolean),
      },
    });
  });

  it("lists displays with normalized geometry", async () => {
    const result = await client.request<{
      displays: Array<Record<string, unknown>>;
    }>("display.list");

    expect(result.displays.length).toBeGreaterThan(0);
    expect(result.displays).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          displayId: expect.any(String),
          name: expect.any(String),
          bounds: expect.objectContaining({
            x: expect.any(Number),
            y: expect.any(Number),
            width: expect.any(Number),
            height: expect.any(Number),
          }),
          isMain: expect.any(Boolean),
        }),
      ]),
    );
  });

  it("lists regular GUI applications including VS Code without exposing the helper", async () => {
    const status = await client.request<{ process: { pid: number } }>("health");
    const result = await client.request<{
      applications: Array<Record<string, unknown>>;
    }>("application.list", { includeBackground: true });

    expect(result.applications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bundleIdentifier: "com.microsoft.VSCode",
          processId: expect.any(Number),
          name: expect.any(String),
        }),
      ]),
    );
    expect(result.applications).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ processId: status.process.pid }),
      ]),
    );
  });

  it("keeps readable matched labels query-only and binds AX observations to a process instance", async () => {
    await expect(
      client.request("accessibility.snapshot", {
        processId: process.pid,
        contentPolicy: "matched",
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" });

    const health = await client.request<{
      permissions: { accessibility: boolean };
    }>("health");
    if (!health.permissions.accessibility) {
      return;
    }

    const applications = await client.request<{
      applications: Array<{
        processId: number;
        bundleIdentifier: string | null;
      }>;
    }>("application.list", { includeBackground: false });
    const application = applications.applications.find(
      ({ bundleIdentifier }) => bundleIdentifier === "com.microsoft.VSCode",
    );
    if (!application?.bundleIdentifier) {
      throw new Error("VS Code was not running for AX identity integration");
    }

    const parameters = {
      processId: application.processId,
      expectedBundleIdentifier: application.bundleIdentifier,
      contentPolicy: "matched",
      predicate: { roles: ["AXApplication"] },
      limits: { maxNodes: 1 },
    };
    const first = accessibilityQuerySchema.parse(
      await client.request("accessibility.query", parameters),
    );
    const second = accessibilityQuerySchema.parse(
      await client.request("accessibility.query", parameters),
    );

    expect(first.application).toMatchObject({
      processId: application.processId,
      processInstanceId: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      bundleIdentifier: application.bundleIdentifier,
    });
    expect(second.application.processInstanceId).toBe(
      first.application.processInstanceId,
    );
  });

  it("waits for immediate AX conditions and times out absent conditions without input", async () => {
    const health = await client.request<{
      permissions: { accessibility: boolean };
    }>("health");
    if (!health.permissions.accessibility) {
      return;
    }

    const applications = await client.request<{
      applications: Array<{
        processId: number;
        bundleIdentifier: string | null;
      }>;
    }>("application.list", { includeBackground: false });
    const application = applications.applications.find(
      ({ bundleIdentifier }) => bundleIdentifier === "com.microsoft.VSCode",
    );
    if (!application?.bundleIdentifier) {
      throw new Error("VS Code was not running for AX wait integration");
    }

    const base = {
      processId: application.processId,
      expectedBundleIdentifier: application.bundleIdentifier,
      contentPolicy: "redacted",
      pollIntervalMs: 50,
    };
    const satisfied = accessibilityWaitSchema.parse(
      await client.request("accessibility.wait", {
        ...base,
        timeoutMs: 500,
        condition: {
          allOf: [
            {
              kind: "element",
              target: { roles: ["AXApplication"] },
              state: "appears",
            },
            {
              kind: "window",
              state: "appears",
            },
          ],
        },
      }),
    );
    expect(satisfied).toMatchObject({
      status: "satisfied",
      pollCount: 1,
      evaluations: [
        { kind: "element", status: "satisfied" },
        { kind: "window", status: "satisfied" },
      ],
      reasons: [],
    });
    expect(satisfied.observation).not.toHaveProperty("nodes");

    let target: PassiveSemanticTarget | undefined;
    try {
      target = await startPassiveSemanticTarget();
      await expect(
        client.request("accessibility.wait", {
          processId: target.processId,
          condition: {
            kind: "window",
            state: "appears",
          },
          unexpected: true,
        }),
      ).rejects.toMatchObject({ code: "invalid_argument" });
      await expect(
        client.request("accessibility.wait", {
          processId: target.processId,
          condition: {
            kind: "window",
            state: "appears",
            unexpected: true,
          },
        }),
      ).rejects.toMatchObject({ code: "invalid_argument" });
      await expect(
        client.request("accessibility.wait", {
          processId: target.processId,
          condition: {
            kind: "element",
            target: { name: "Submit workflow", unexpected: true },
            state: "appears",
          },
        }),
      ).rejects.toMatchObject({ code: "invalid_argument" });

      const completeTreeConditions = accessibilityWaitSchema.parse(
        await client.request("accessibility.wait", {
          processId: target.processId,
          contentPolicy: "redacted",
          timeoutMs: 500,
          pollIntervalMs: 50,
          condition: {
            allOf: [
              {
                kind: "window",
                title: "Computer Use Semantic Workflow Target",
                titleMatch: "exact",
                state: "appears",
              },
              {
                kind: "element",
                target: { name: "Enable cloud sync" },
                state: "enabled",
                equals: true,
              },
            ],
          },
        }),
      );
      expect(completeTreeConditions).toMatchObject({
        status: "satisfied",
        pollCount: 1,
        evaluations: [
          {
            kind: "window",
            state: "appears",
            status: "satisfied",
            matchCount: 1,
          },
          {
            kind: "element",
            state: "enabled",
            status: "satisfied",
            matchCount: 1,
            observedValue: true,
          },
        ],
        reasons: [],
      });

      const anyOf = accessibilityWaitSchema.parse(
        await client.request("accessibility.wait", {
          processId: target.processId,
          contentPolicy: "redacted",
          timeoutMs: 500,
          pollIntervalMs: 50,
          condition: {
            anyOf: [
              {
                kind: "element",
                target: { roles: ["AXButton"] },
                state: "enabled",
                equals: true,
              },
              {
                kind: "window",
                title: "Computer Use Semantic Workflow Target",
                titleMatch: "exact",
                state: "appears",
              },
            ],
          },
        }),
      );
      expect(anyOf).toMatchObject({
        status: "satisfied",
        pollCount: 1,
        evaluations: [
          { status: "uncertain", reason: "element_ambiguous" },
          { status: "satisfied", kind: "window" },
        ],
        reasons: [],
      });

      const transientUncertainty = accessibilityWaitSchema.parse(
        await client.request("accessibility.wait", {
          processId: target.processId,
          contentPolicy: "redacted",
          timeoutMs: 250,
          pollIntervalMs: 50,
          condition: {
            kind: "element",
            target: { roles: ["AXButton"] },
            state: "enabled",
            equals: true,
          },
        }),
      );
      expect(transientUncertainty).toMatchObject({
        status: "uncertain",
        evaluations: [
          {
            status: "uncertain",
            reason: "element_ambiguous",
          },
        ],
        reasons: ["element_ambiguous"],
      });
      expect(transientUncertainty.pollCount).toBeGreaterThanOrEqual(2);

      const dynamicWait = client.request("accessibility.wait", {
        processId: target.processId,
        contentPolicy: "redacted",
        pollIntervalMs: 50,
        timeoutMs: 2_000,
        condition: {
          kind: "element",
          target: { name: "Wait transition complete" },
          state: "appears",
        },
      });
      setTimeout(() => {
        target?.child.stdin.write(
          `${JSON.stringify({
            type: "set_status_label",
            requestId: "wait-transition",
            label: "Wait transition complete",
          })}\n`,
        );
      }, 150);
      const transitioned = accessibilityWaitSchema.parse(await dynamicWait);
      expect(transitioned).toMatchObject({
        status: "satisfied",
        evaluations: [
          {
            kind: "element",
            state: "appears",
            status: "satisfied",
            matchCount: 1,
            observedValue: true,
          },
        ],
        reasons: [],
      });
      expect(transitioned.pollCount).toBeGreaterThanOrEqual(2);

      const timedOut = accessibilityWaitSchema.parse(
        await client.request("accessibility.wait", {
          processId: target.processId,
          contentPolicy: "redacted",
          pollIntervalMs: 50,
          timeoutMs: 300,
          condition: {
            kind: "element",
            target: { name: "Control that cannot exist in this integration" },
            state: "appears",
          },
        }),
      );
      expect(timedOut).toMatchObject({
        status: "timed_out",
        pollCount: expect.any(Number),
        evaluations: [
          {
            kind: "element",
            status: "unsatisfied",
            matchCount: 0,
            observedValue: false,
          },
        ],
        reasons: ["timeout"],
      });
      expect(timedOut.pollCount).toBeGreaterThanOrEqual(2);

      const disappearingWait = client.request("accessibility.wait", {
        processId: target.processId,
        contentPolicy: "redacted",
        pollIntervalMs: 50,
        timeoutMs: 2_000,
        condition: {
          kind: "element",
          target: { name: "Never appears before process exit" },
          state: "appears",
        },
      });
      setTimeout(() => target?.child.kill("SIGTERM"), 150);
      const disappeared = accessibilityWaitSchema.parse(await disappearingWait);
      expect(disappeared).toMatchObject({
        status: "uncertain",
        observation: null,
        evaluations: [],
        reasons: ["process_identity_changed"],
      });
      expect(disappeared.pollCount).toBeGreaterThanOrEqual(1);
    } finally {
      await stopPassiveSemanticTarget(target);
    }
  });

  it("performs verified AX actions and classifies failures around the dispatch boundary", async () => {
    const health = await client.request<{
      permissions: { accessibility: boolean };
    }>("health");
    if (!health.permissions.accessibility) {
      return;
    }

    let target: PassiveSemanticTarget | undefined;
    try {
      target = await startPassiveSemanticTarget();
      const base = {
        processId: target.processId,
        contentPolicy: "redacted",
        verificationTimeoutMs: 2_000,
        pollIntervalMs: 50,
      };

      const filled = accessibilityFillSchema.parse(
        await client.request("accessibility.fill", {
          ...base,
          fields: [
            {
              target: { roles: ["AXTextField"], name: "Workflow text" },
              value: "Filled without keyboard input",
            },
          ],
          postcondition: {
            kind: "element",
            target: { name: "Workflow text" },
            state: "appears",
          },
        }),
      );
      expect(filled).toMatchObject({
        outcome: "verified",
        phase: "complete",
        dispatchAttempted: true,
        dispatchAcknowledged: true,
        fields: [{ index: 0, valueStatus: "verified", reason: null }],
        postcondition: { status: "satisfied" },
        reasons: [],
      });
      expect(JSON.stringify(filled)).not.toContain(
        "Filled without keyboard input",
      );

      const verified = accessibilityActSchema.parse(
        await client.request("accessibility.act", {
          ...base,
          target: { roles: ["AXCheckBox"], name: "Enable cloud sync" },
          action: "press",
          postcondition: {
            kind: "element",
            target: { name: "Cloud sync enabled" },
            state: "appears",
          },
        }),
      );
      expect(verified).toMatchObject({
        outcome: "verified",
        phase: "complete",
        action: "press",
        dispatchAttempted: true,
        dispatchAcknowledged: true,
        postcondition: { status: "satisfied" },
        reasons: [],
      });
      expect(verified.target?.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);

      const staleFingerprint = accessibilityActSchema.parse(
        await client.request("accessibility.act", {
          ...base,
          target: { roles: ["AXCheckBox"], name: "Enable cloud sync" },
          action: "press",
          expectedTargetFingerprint: `sha256:${"0".repeat(64)}`,
          postcondition: { kind: "window", state: "appears" },
        }),
      );
      expect(staleFingerprint).toMatchObject({
        outcome: "not_dispatched",
        phase: "pre_dispatch",
        dispatchAttempted: false,
        dispatchAcknowledged: false,
        reasons: ["target_fingerprint_mismatch"],
      });

      const ambiguous = accessibilityActSchema.parse(
        await client.request("accessibility.act", {
          ...base,
          target: { roles: ["AXButton"] },
          action: "press",
          postcondition: { kind: "window", state: "appears" },
        }),
      );
      expect(ambiguous).toMatchObject({
        outcome: "not_dispatched",
        phase: "pre_dispatch",
        dispatchAttempted: false,
        reasons: ["target_ambiguous"],
      });

      const selectedCandidate = accessibilityActSchema.parse(
        await client.request("accessibility.act", {
          ...base,
          target: { roles: ["AXButton"] },
          action: "press",
          selectedTargetFingerprint: `sha256:${"0".repeat(64)}`,
          postcondition: { kind: "window", state: "appears" },
        }),
      );
      expect(selectedCandidate).toMatchObject({
        outcome: "not_dispatched",
        phase: "pre_dispatch",
        dispatchAttempted: false,
        reasons: ["candidate_selection_changed"],
      });

      const unverified = accessibilityActSchema.parse(
        await client.request("accessibility.act", {
          ...base,
          verificationTimeoutMs: 300,
          target: { roles: ["AXCheckBox"], name: "Enable cloud sync" },
          action: "press",
          postcondition: {
            kind: "element",
            target: { name: "Never appears after this action" },
            state: "appears",
          },
        }),
      );
      expect(unverified).toMatchObject({
        outcome: "indeterminate",
        phase: "verifying",
        dispatchAttempted: true,
        dispatchAcknowledged: true,
        postcondition: { status: "unsatisfied" },
        reasons: ["postcondition_unsatisfied"],
      });
      expect(unverified.postcondition.pollCount).toBeGreaterThanOrEqual(2);
    } finally {
      await stopPassiveSemanticTarget(target);
    }
  });

  it("preserves successful interaction when post-action capture fails", async () => {
    const applications = await client.request<{
      applications: Array<{
        processId: number;
        bundleIdentifier: string | null;
      }>;
    }>("application.list", { includeBackground: false });
    const code = applications.applications.find(
      ({ bundleIdentifier }) => bundleIdentifier === "com.microsoft.VSCode",
    );
    if (!code) {
      throw new Error("VS Code was not running for post-action capture");
    }

    const result = await client.request<{
      interaction: { verified: true };
      capture?: unknown;
      captureError?: { code: string; message: string };
    }>("application.activate", {
      processId: code.processId,
      captureAfter: {
        target: { kind: "display", displayId: "4294967295" },
        settleMs: 0,
      },
    });

    expect(result.interaction.verified).toBe(true);
    expect(result.capture).toBeUndefined();
    expect(result.captureError).toMatchObject({
      code: "target_not_found",
      message: expect.any(String),
    });
    await expect(client.request("health")).resolves.toMatchObject({
      permissions: expect.any(Object),
    });
  });

  it("does not expose activity-indicator windows", async () => {
    const status = await client.request<{ process: { pid: number } }>("health");
    const result = await client.request<{
      windows: Array<{ owningApplication: { processId: number } }>;
    }>("window.list", {
      processId: status.process.pid,
      onScreenOnly: false,
      includeUntitled: true,
    });

    expect(result.windows).toEqual([]);
  });

  it("lists meaningful on-screen VS Code windows", async () => {
    const result = await client.request<{
      windows: Array<Record<string, unknown>>;
    }>("window.list", {
      bundleIdentifier: "com.microsoft.VSCode",
      onScreenOnly: true,
      includeUntitled: false,
    });

    expect(result.windows.length).toBeGreaterThan(0);
    expect(result.windows[0]).toMatchObject({
      windowId: expect.stringMatching(/^\d+$/),
      title: expect.any(String),
      isOnScreen: true,
      owningApplication: {
        bundleIdentifier: "com.microsoft.VSCode",
      },
    });
  });

  it("moves and restores the cursor and supports idempotent recovery", async () => {
    const initial = await client.request<{
      position: { x: number; y: number };
      heldButtons: string[];
    }>("mouse.position");
    expect(initial.heldButtons).toEqual([]);

    const displays = await client.request<{
      displays: Array<{
        bounds: { x: number; y: number; width: number; height: number };
      }>;
    }>("display.list");
    const containingDisplay = displays.displays.find(({ bounds }) => {
      return (
        initial.position.x >= bounds.x &&
        initial.position.x <= bounds.x + bounds.width &&
        initial.position.y >= bounds.y &&
        initial.position.y <= bounds.y + bounds.height
      );
    });
    if (!containingDisplay) {
      throw new Error("Current cursor was not inside a discovered display");
    }

    const target = {
      x: Math.min(
        containingDisplay.bounds.x + containingDisplay.bounds.width - 2,
        initial.position.x + 10,
      ),
      y: Math.min(
        containingDisplay.bounds.y + containingDisplay.bounds.height - 2,
        initial.position.y + 10,
      ),
    };

    try {
      const moved = await client.request<{
        position: { x: number; y: number };
        heldButtons: string[];
      }>("mouse.move", { to: target, durationMs: 50 });
      expect(moved.position.x).toBeCloseTo(target.x, 0);
      expect(moved.position.y).toBeCloseTo(target.y, 0);

      const released = await client.request<{
        heldButtons: string[];
        heldKeys: string[];
        heldModifiers: string[];
        releasedButtons: string[];
        releasedKeys: string[];
        releasedModifiers: string[];
      }>("input.releaseAll");
      expect(released).toMatchObject({
        heldButtons: [],
        heldKeys: [],
        heldModifiers: [],
        releasedButtons: [],
        releasedKeys: [],
        releasedModifiers: [],
      });
    } finally {
      await client.request("input.releaseAll").catch(() => undefined);
      await client
        .request("mouse.move", { to: initial.position, durationMs: 0 })
        .catch(() => undefined);
    }
  });

  it("executes a wait-only input batch sequentially", async () => {
    const result = await client.request<{
      completed: boolean;
      completedCount: number;
      results: Array<{
        index: number;
        type: string;
        result: { waitedMs: number };
      }>;
    }>("input.batch", {
      steps: [
        { type: "wait", durationMs: 0 },
        { type: "wait", durationMs: 10 },
      ],
    });

    expect(result).toEqual({
      completed: true,
      completedCount: 2,
      results: [
        { index: 0, type: "wait", result: { waitedMs: 0 } },
        { index: 1, type: "wait", result: { waitedMs: 10 } },
      ],
    });
  });

  it("validates every input batch step before execution", async () => {
    await expect(
      client.request("input.batch", {
        steps: [
          { type: "wait", durationMs: 10 },
          { type: "wait", durationMs: 5_001 },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" });

    await expect(client.request("health")).resolves.toMatchObject({
      permissions: expect.any(Object),
    });
  });

  it("captures display, window, and region targets through secure artifact consumption", async () => {
    const status = await client.request<{ artifactRoot: string }>("health");
    const displays = await client.request<{
      displays: Array<{
        displayId: string;
        isMain: boolean;
        bounds: { x: number; y: number; width: number; height: number };
      }>;
    }>("display.list");
    const display = displays.displays.find((candidate) => candidate.isMain);
    if (!display) {
      throw new Error("No main display was discovered");
    }

    const displayArtifact = await client.request<unknown>("screen.capture", {
      target: { kind: "display", displayId: display.displayId },
      format: "png",
      scale: "logical",
      maxWidth: 640,
      includeCursor: false,
    });
    const displayCapture = await consumeCaptureArtifact(
      displayArtifact,
      status.artifactRoot,
    );
    expect(displayCapture.metadata).toMatchObject({
      target: { kind: "display", displayId: display.displayId },
      mimeType: "image/png",
      outputPixelSize: { width: 640 },
      mapping: {
        kind: "linear",
        screenBounds: display.bounds,
      },
    });

    const windows = await client.request<{
      windows: Array<{ windowId: string }>;
    }>("window.list", {
      bundleIdentifier: "com.microsoft.VSCode",
      onScreenOnly: true,
      includeUntitled: false,
    });
    const window = windows.windows[0];
    if (!window) {
      throw new Error("No VS Code window was discovered");
    }

    const windowArtifact = await client.request<unknown>("screen.capture", {
      target: { kind: "window", windowId: window.windowId },
      format: "jpeg",
      scale: "logical",
      maxWidth: 800,
      includeCursor: false,
    });
    const windowCapture = await consumeCaptureArtifact(
      windowArtifact,
      status.artifactRoot,
    );
    expect(windowCapture.metadata).toMatchObject({
      target: { kind: "window", windowId: window.windowId },
      mimeType: "image/jpeg",
      mapping: { kind: "linear" },
    });
    const jpegBytes = Buffer.from(windowCapture.data, "base64");
    expect([...jpegBytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);

    const regionBounds = {
      x: display.bounds.x,
      y: display.bounds.y,
      width: Math.min(320, display.bounds.width),
      height: Math.min(240, display.bounds.height),
    };
    const regionArtifact = await client.request<unknown>("screen.capture", {
      target: { kind: "region", bounds: regionBounds },
      format: "png",
      scale: 1,
      includeCursor: false,
    });
    const regionCapture = await consumeCaptureArtifact(
      regionArtifact,
      status.artifactRoot,
    );
    expect(regionCapture.metadata).toMatchObject({
      target: { kind: "region", bounds: regionBounds },
      outputPixelSize: {
        width: regionBounds.width,
        height: regionBounds.height,
      },
      mapping: {
        screenBounds: regionBounds,
        pixelsPerPoint: { x: 1, y: 1 },
      },
    });

    const secondary = displays.displays.find(
      (candidate) =>
        !candidate.isMain && (candidate.bounds.x < 0 || candidate.bounds.y < 0),
    );
    if (secondary) {
      const secondaryBounds = {
        x: secondary.bounds.x,
        y: secondary.bounds.y,
        width: Math.min(257, secondary.bounds.width),
        height: Math.min(193, secondary.bounds.height),
      };
      const secondaryArtifact = await client.request<unknown>(
        "screen.capture",
        {
          target: { kind: "region", bounds: secondaryBounds },
          format: "png",
          scale: 1.25,
          maxWidth: 251,
          maxHeight: 190,
          includeCursor: false,
        },
      );
      const secondaryCapture = await consumeCaptureArtifact(
        secondaryArtifact,
        status.artifactRoot,
      );
      expect(secondaryCapture.metadata.mapping.screenBounds).toEqual(
        secondaryBounds,
      );
      expect(
        secondaryCapture.metadata.outputPixelSize.width,
      ).toBeLessThanOrEqual(251);
      expect(
        secondaryCapture.metadata.outputPixelSize.height,
      ).toBeLessThanOrEqual(190);
    }
  });
});
