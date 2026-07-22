/// <reference types="node" />

import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { NativeBridge } from "../src/native/client.js";
import { createServer } from "../src/server.js";
import { join } from "node:path";
import { tmpdir } from "node:os";

const status = {
  artifactRoot: "/tmp/computer-use-mcp/test-session",
  control: {
    inputEnabled: true,
    indicatorAvailable: true,
    state: "idle",
  },
  permissions: {
    accessibility: true,
    "post-event": true,
    "screen-capture": true,
  },
  process: {
    pid: 123,
  },
  system: {
    operatingSystemVersion: "Version 26.5.1",
    architecture: "arm64",
  },
};

const application = {
  processId: 123,
  bundleIdentifier: "com.microsoft.VSCode",
  name: "Code",
  bundlePath: "/Applications/Visual Studio Code.app",
  isActive: true,
  isHidden: false,
  activationPolicy: 0,
};

const mouseState = {
  position: { x: 100, y: 200 },
  heldButtons: [] as Array<"left" | "right" | "middle">,
};

const keyboardState = {
  heldKeys: [] as string[],
  heldModifiers: [] as string[],
};

const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01,
]);

const window = {
  windowId: "456",
  title: "project — Code",
  bounds: { x: -1512, y: 879, width: 1512, height: 949 },
  isOnScreen: true,
  isActive: true,
  owningApplication: {
    processId: 123,
    bundleIdentifier: "com.microsoft.VSCode",
    name: "Code",
  },
};

interface NativeRequestRecord {
  method: string;
  params: Record<string, unknown>;
}

class StubNativeBridge implements NativeBridge {
  requests: NativeRequestRecord[] = [];
  responses: Record<
    string,
    unknown | ((params: Record<string, unknown>) => unknown | Promise<unknown>)
  > = {
    health: status,
    "display.list": {
      displays: [
        {
          displayId: "5",
          name: "Studio Display",
          bounds: { x: 0, y: 0, width: 5120, height: 1440 },
          pixelSize: { width: 5120, height: 1440 },
          pixelsPerPoint: { x: 1, y: 1 },
          isMain: true,
          coreGraphicsBoundsMatch: true,
        },
      ],
    },
    "application.list": { applications: [application] },
    "application.activate": { application, verified: true },
    "window.list": { windows: [window] },
    "window.focus": {
      windowId: window.windowId,
      title: window.title,
      application: window.owningApplication,
      raiseResult: 0,
      verified: true,
    },
    "mouse.position": mouseState,
    "mouse.move": mouseState,
    "mouse.button": { ...mouseState, heldButtons: ["left"] },
    "mouse.click": mouseState,
    "mouse.drag": mouseState,
    "mouse.scroll": mouseState,
    "keyboard.type": keyboardState,
    "keyboard.key": keyboardState,
    "keyboard.shortcut": keyboardState,
    "input.releaseAll": {
      ...mouseState,
      ...keyboardState,
      releasedButtons: ["left"],
      releasedKeys: ["a"],
      releasedModifiers: ["command"],
    },
    "input.batch": {
      completed: true,
      completedCount: 2,
      results: [
        { index: 0, type: "wait", result: { waitedMs: 0 } },
        { index: 1, type: "keyboard_key", result: keyboardState },
      ],
    },
  };

  async request<T>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    this.requests.push({ method, params });
    const response = this.responses[method];
    return (
      typeof response === "function" ? await response(params) : response
    ) as T;
  }

  async close(): Promise<void> {}
}

interface TestContext {
  native: StubNativeBridge;
  client: Client;
}

const cleanup: Array<() => Promise<void>> = [];

async function createArtifactRoot(): Promise<string> {
  const base = join(tmpdir(), "computer-use-mcp");
  await mkdir(base, { recursive: true, mode: 0o700 });
  await chmod(base, 0o700);
  const root = await mkdtemp(join(base, "server-test-"));
  await chmod(root, 0o700);
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function createCaptureArtifact(
  root: string,
  overrides: Record<string, unknown> = {},
) {
  const artifactPath = join(root, `${randomUUID()}.png`);
  await writeFile(artifactPath, pngBytes, { mode: 0o600 });
  await chmod(artifactPath, 0o600);
  return {
    captureId: randomUUID(),
    artifactRoot: root,
    artifactPath,
    byteLength: pngBytes.length,
    target: { kind: "window", windowId: "456" },
    mimeType: "image/png",
    nativePixelSize: { width: 100, height: 100 },
    outputPixelSize: { width: 100, height: 100 },
    mapping: {
      kind: "linear",
      imageContentBounds: { x: 0, y: 0, width: 100, height: 100 },
      screenBounds: { x: 0, y: 0, width: 100, height: 100 },
      pixelsPerPoint: { x: 1, y: 1 },
    },
    sha256: createHash("sha256").update(pngBytes).digest("hex"),
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

async function createTestContext(): Promise<TestContext> {
  const native = new StubNativeBridge();
  const server = createServer(native);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(
    async () => client.close(),
    async () => server.close(),
  );
  return { native, client };
}

describe("MCP tools", () => {
  it("registers the status and discovery tool surface", async () => {
    const { client } = await createTestContext();
    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "application_activate",
      "application_list",
      "computer_status",
      "display_list",
      "input_batch",
      "input_release_all",
      "keyboard_key",
      "keyboard_shortcut",
      "keyboard_type",
      "mouse_button",
      "mouse_click",
      "mouse_drag",
      "mouse_move",
      "mouse_position",
      "mouse_scroll",
      "screen_capture",
      "window_focus",
      "window_list",
    ]);
    const statusTool = tools.tools.find(
      (tool) => tool.name === "computer_status",
    );
    expect(statusTool?.description).toContain("input");
    expect(statusTool?.description).toContain("activity-indicator");
  });

  it("returns structured computer status", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "computer_status",
      arguments: {},
    });

    expect(result.isError).not.toBe(true);
    const { artifactRoot: _artifactRoot, ...visibleStatus } = status;
    expect(result.structuredContent).toEqual(visibleStatus);
    expect(result.structuredContent).toMatchObject({
      control: {
        inputEnabled: true,
        indicatorAvailable: true,
        state: "idle",
      },
    });
    expect(native.requests).toEqual([{ method: "health", params: {} }]);
  });

  it("rejects computer status without control state", async () => {
    const { client, native } = await createTestContext();
    const { control: _control, ...statusWithoutControl } = status;
    native.responses.health = statusWithoutControl;

    const result = await client.callTool({
      name: "computer_status",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(native.requests).toEqual([{ method: "health", params: {} }]);
  });

  it("lists displays", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "display_list",
      arguments: {},
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      displays: [{ displayId: "5" }],
    });
    expect(native.requests).toEqual([{ method: "display.list", params: {} }]);
  });

  it("applies application-list defaults", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "application_list",
      arguments: {},
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ applications: [application] });
    expect(native.requests).toEqual([
      { method: "application.list", params: { includeBackground: false } },
    ]);
  });

  it("forwards includeBackground to application listing", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "application_list",
      arguments: { includeBackground: true },
    });

    expect(result.isError).not.toBe(true);
    expect(native.requests).toEqual([
      { method: "application.list", params: { includeBackground: true } },
    ]);
  });

  it("activates an application using exactly one selector", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "application_activate",
      arguments: { bundleIdentifier: "com.microsoft.VSCode" },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ application, verified: true });
    expect(native.requests).toEqual([
      {
        method: "application.activate",
        params: { bundleIdentifier: "com.microsoft.VSCode" },
      },
    ]);
  });

  it("rejects ambiguous application selectors before native execution", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "application_activate",
      arguments: {
        processId: 123,
        bundleIdentifier: "com.microsoft.VSCode",
      },
    });

    expect(result.isError).toBe(true);
    expect(native.requests).toEqual([]);
  });

  it("applies window-list defaults and optional app filters", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "window_list",
      arguments: { bundleIdentifier: "com.microsoft.VSCode" },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ windows: [window] });
    expect(native.requests).toEqual([
      {
        method: "window.list",
        params: {
          bundleIdentifier: "com.microsoft.VSCode",
          onScreenOnly: true,
          includeUntitled: false,
        },
      },
    ]);
  });

  it("rejects non-numeric window IDs before native execution", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "window_focus",
      arguments: { windowId: "not-a-window" },
    });

    expect(result.isError).toBe(true);
    expect(native.requests).toEqual([]);
  });

  it("focuses a window by opaque session ID", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "window_focus",
      arguments: { windowId: "456" },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      windowId: "456",
      verified: true,
    });
    expect(native.requests).toEqual([
      { method: "window.focus", params: { windowId: "456" } },
    ]);
  });

  it("returns mouse position without parameters", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "mouse_position",
      arguments: {},
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(mouseState);
    expect(native.requests).toEqual([{ method: "mouse.position", params: {} }]);
  });

  it("applies mouse move defaults", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "mouse_move",
      arguments: { to: { x: 100, y: 200 } },
    });

    expect(result.isError).not.toBe(true);
    expect(native.requests).toEqual([
      {
        method: "mouse.move",
        params: { to: { x: 100, y: 200 }, durationMs: 0 },
      },
    ]);
  });

  it("tracks explicit mouse button state", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "mouse_button",
      arguments: { action: "down", point: { x: 100, y: 200 } },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      position: mouseState.position,
      heldButtons: ["left"],
    });
    expect(native.requests).toEqual([
      {
        method: "mouse.button",
        params: {
          action: "down",
          button: "left",
          point: { x: 100, y: 200 },
        },
      },
    ]);
  });

  it("applies click and drag defaults", async () => {
    const { client, native } = await createTestContext();
    await client.callTool({
      name: "mouse_click",
      arguments: { point: { x: 100, y: 200 } },
    });
    await client.callTool({
      name: "mouse_drag",
      arguments: { to: { x: 120, y: 220 } },
    });

    expect(native.requests).toEqual([
      {
        method: "mouse.click",
        params: {
          button: "left",
          point: { x: 100, y: 200 },
          count: 1,
          intervalMs: 100,
        },
      },
      {
        method: "mouse.drag",
        params: {
          button: "left",
          to: { x: 120, y: 220 },
          durationMs: 500,
        },
      },
    ]);
  });

  it("forwards signed pixel scroll deltas", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "mouse_scroll",
      arguments: { deltaX: -25, deltaY: 50, unit: "pixel" },
    });

    expect(result.isError).not.toBe(true);
    expect(native.requests).toEqual([
      {
        method: "mouse.scroll",
        params: { deltaX: -25, deltaY: 50, unit: "pixel" },
      },
    ]);
  });

  it("rejects invalid mouse inputs before native execution", async () => {
    const { client, native } = await createTestContext();
    const invalidCount = await client.callTool({
      name: "mouse_click",
      arguments: { count: 4 },
    });
    const incompletePoint = await client.callTool({
      name: "mouse_move",
      arguments: { to: { x: 100 } },
    });
    const zeroScroll = await client.callTool({
      name: "mouse_scroll",
      arguments: {},
    });

    expect(invalidCount.isError).toBe(true);
    expect(incompletePoint.isError).toBe(true);
    expect(zeroScroll.isError).toBe(true);
    expect(native.requests).toEqual([]);
  });

  it("types Unicode text and applies defaults", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "keyboard_type",
      arguments: { text: "Hello, 世界 👋" },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(keyboardState);
    expect(native.requests).toEqual([
      {
        method: "keyboard.type",
        params: { text: "Hello, 世界 👋", intervalMs: 0 },
      },
    ]);
  });

  it("returns a post-action capture image without exposing artifact paths", async () => {
    const root = await createArtifactRoot();
    const { client, native } = await createTestContext();
    native.responses.health = { ...status, artifactRoot: root };
    native.responses["keyboard.type"] = async () => ({
      interaction: keyboardState,
      capture: await createCaptureArtifact(root),
    });

    const result = await client.callTool({
      name: "keyboard_type",
      arguments: {
        text: "verified",
        captureAfter: {
          target: { kind: "window", windowId: "456" },
          maxWidth: 640,
        },
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      interaction: keyboardState,
      capture: {
        target: { kind: "window", windowId: "456" },
        byteLength: pngBytes.length,
      },
    });
    expect(result.structuredContent).not.toHaveProperty("capture.artifactRoot");
    expect(result.structuredContent).not.toHaveProperty("capture.artifactPath");
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "image",
          data: pngBytes.toString("base64"),
          mimeType: "image/png",
        }),
      ]),
    );
    expect(native.requests).toEqual([
      { method: "health", params: {} },
      {
        method: "keyboard.type",
        params: {
          text: "verified",
          intervalMs: 0,
          captureAfter: {
            target: { kind: "window", windowId: "456" },
            format: "jpeg",
            scale: "logical",
            maxWidth: 640,
            includeCursor: false,
            settleMs: 100,
          },
        },
      },
    ]);
  });

  it("consumes a capture artifact before rejecting malformed interaction data", async () => {
    const root = await createArtifactRoot();
    const { client, native } = await createTestContext();
    const artifact = await createCaptureArtifact(root);
    native.responses.health = { ...status, artifactRoot: root };
    native.responses["keyboard.type"] = {
      interaction: { heldKeys: "invalid", heldModifiers: [] },
      capture: artifact,
    };

    const result = await client.callTool({
      name: "keyboard_type",
      arguments: {
        text: "once",
        captureAfter: {
          target: { kind: "window", windowId: "456" },
          settleMs: 0,
        },
      },
    });

    expect(result.isError).toBe(true);
    await expect(access(artifact.artifactPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves a successful interaction when artifact validation fails", async () => {
    const root = await createArtifactRoot();
    const { client, native } = await createTestContext();
    native.responses.health = { ...status, artifactRoot: root };
    native.responses["keyboard.type"] = async () => ({
      interaction: keyboardState,
      capture: await createCaptureArtifact(root, { sha256: "0".repeat(64) }),
    });

    const result = await client.callTool({
      name: "keyboard_type",
      arguments: {
        text: "once",
        captureAfter: {
          target: { kind: "window", windowId: "456" },
          settleMs: 0,
        },
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      interaction: keyboardState,
      captureError: {
        code: "native_unavailable",
        message: expect.any(String),
      },
    });
    expect(result.structuredContent).not.toHaveProperty("capture");
    expect(result.content).toHaveLength(1);
    expect(
      native.requests.filter(({ method }) => method === "keyboard.type"),
    ).toHaveLength(1);
  });

  it("forwards key presses and ordered shortcuts", async () => {
    const { client, native } = await createTestContext();
    await client.callTool({
      name: "keyboard_key",
      arguments: {
        key: "a",
        modifiers: ["command", "shift"],
        repeat: 2,
      },
    });
    await client.callTool({
      name: "keyboard_shortcut",
      arguments: { keys: ["command", "shift", "p"] },
    });

    expect(native.requests).toEqual([
      {
        method: "keyboard.key",
        params: {
          key: "a",
          action: "press",
          modifiers: ["command", "shift"],
          repeat: 2,
        },
      },
      {
        method: "keyboard.shortcut",
        params: { keys: ["command", "shift", "p"], holdMs: 0 },
      },
    ]);
  });

  it("tracks held keyboard state", async () => {
    const { client, native } = await createTestContext();
    native.responses["keyboard.key"] = {
      heldKeys: [],
      heldModifiers: ["shift"],
    };

    const result = await client.callTool({
      name: "keyboard_key",
      arguments: { key: "shift", action: "down" },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      heldKeys: [],
      heldModifiers: ["shift"],
    });
  });

  it("rejects invalid keyboard input before native execution", async () => {
    const { client, native } = await createTestContext();
    const duplicateShortcut = await client.callTool({
      name: "keyboard_shortcut",
      arguments: { keys: ["command", "command"] },
    });
    const heldWithModifiers = await client.callTool({
      name: "keyboard_key",
      arguments: { key: "a", action: "down", modifiers: ["shift"] },
    });
    const excessiveDelay = await client.callTool({
      name: "keyboard_type",
      arguments: { text: "abc", intervalMs: 10_000 },
    });
    const heldCapsLock = await client.callTool({
      name: "keyboard_key",
      arguments: { key: "caps-lock", action: "down" },
    });
    const capsLockShortcut = await client.callTool({
      name: "keyboard_shortcut",
      arguments: { keys: ["caps-lock", "a"] },
    });
    const excessiveSettle = await client.callTool({
      name: "keyboard_type",
      arguments: {
        text: "safe",
        captureAfter: {
          target: { kind: "window", windowId: "456" },
          settleMs: 2_001,
        },
      },
    });

    expect(duplicateShortcut.isError).toBe(true);
    expect(heldWithModifiers.isError).toBe(true);
    expect(excessiveDelay.isError).toBe(true);
    expect(heldCapsLock.isError).toBe(true);
    expect(capsLockShortcut.isError).toBe(true);
    expect(excessiveSettle.isError).toBe(true);
    expect(native.requests).toEqual([]);
  });

  it("normalizes and forwards an input batch as one native request", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "input_batch",
      arguments: {
        steps: [
          { type: "wait", durationMs: 0 },
          { type: "keyboard_key", key: "a" },
        ],
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      completed: true,
      completedCount: 2,
      results: [
        { index: 0, type: "wait", result: { waitedMs: 0 } },
        { index: 1, type: "keyboard_key", result: keyboardState },
      ],
    });
    expect(native.requests).toEqual([
      {
        method: "input.batch",
        params: {
          steps: [
            { type: "wait", durationMs: 0 },
            {
              type: "keyboard_key",
              key: "a",
              action: "press",
              modifiers: [],
              repeat: 1,
            },
          ],
        },
      },
    ]);
  });

  it("rejects an invalid later batch step before native dispatch", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "input_batch",
      arguments: {
        steps: [
          { type: "keyboard_key", key: "shift", action: "down" },
          { type: "wait", durationMs: 5_001 },
        ],
      },
    });

    expect(result.isError).toBe(true);
    expect(native.requests).toEqual([]);
  });

  it("preserves progress and marks a stopped input batch as an MCP error", async () => {
    const { client, native } = await createTestContext();
    native.responses["input.batch"] = {
      completed: false,
      completedCount: 1,
      results: [{ index: 0, type: "wait", result: { waitedMs: 0 } }],
      failure: {
        index: 1,
        type: "keyboard_key",
        error: {
          code: "action_failed",
          message: "Keyboard key is already held",
        },
        cleanup: {
          ...mouseState,
          ...keyboardState,
          releasedButtons: [],
          releasedKeys: ["a"],
          releasedModifiers: [],
        },
      },
    };

    const result = await client.callTool({
      name: "input_batch",
      arguments: {
        steps: [
          { type: "wait", durationMs: 0 },
          { type: "keyboard_key", key: "a", action: "down" },
        ],
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      completed: false,
      completedCount: 1,
      failure: {
        index: 1,
        error: { code: "action_failed" },
        cleanup: {
          heldButtons: [],
          heldKeys: [],
          heldModifiers: [],
          releasedKeys: ["a"],
        },
      },
    });
  });

  it("rejects a batch whose declared duration exceeds the total limit", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "input_batch",
      arguments: {
        steps: Array.from({ length: 7 }, () => ({
          type: "wait",
          durationMs: 5_000,
        })),
      },
    });

    expect(result.isError).toBe(true);
    expect(native.requests).toEqual([]);
  });

  it("rejects an excessive zero-delay batch workload", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "input_batch",
      arguments: {
        steps: [
          { type: "keyboard_type", text: "a".repeat(4_096) },
          { type: "keyboard_type", text: "b" },
        ],
      },
    });

    expect(result.isError).toBe(true);
    expect(native.requests).toEqual([]);
  });

  it("releases all tracked input state", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "input_release_all",
      arguments: {},
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      ...mouseState,
      ...keyboardState,
      releasedButtons: ["left"],
      releasedKeys: ["a"],
      releasedModifiers: ["command"],
    });
    expect(native.requests).toEqual([
      { method: "input.releaseAll", params: {} },
    ]);
  });

  it("rejects a native focus result that was not verified", async () => {
    const { client, native } = await createTestContext();
    native.responses["window.focus"] = {
      windowId: "456",
      title: window.title,
      application: window.owningApplication,
      raiseResult: 0,
      verified: false,
    };

    const result = await client.callTool({
      name: "window_focus",
      arguments: { windowId: "456" },
    });

    expect(result.isError).toBe(true);
    expect(native.requests).toEqual([
      { method: "window.focus", params: { windowId: "456" } },
    ]);
  });
});
