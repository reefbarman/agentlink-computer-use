/// <reference types="node" />

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { NativeClient } from "../src/native/client.js";
import { access } from "node:fs/promises";
import { consumeCaptureArtifact } from "../src/native/artifacts.js";
import { resolve } from "node:path";

const helperPath = resolve("native/.build/release/ComputerUseNative");
let client: NativeClient;

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
