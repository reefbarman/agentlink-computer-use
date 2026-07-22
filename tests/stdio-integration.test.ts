import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
import { z } from "zod";

const serverPath = resolve("dist/index.js");
const nativePath = resolve("native/.build/release/ComputerUseNative");
let client: Client;

beforeAll(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      ...process.env,
      COMPUTER_USE_NATIVE_PATH: nativePath,
    },
    stderr: "pipe",
  });
  client = new Client({ name: "stdio-test-client", version: "1.0.0" });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
});

describe("stdio MCP integration", () => {
  it("exposes the complete discovery tool surface", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();

    expect(names).toEqual([
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
  });

  it("calls computer_status through the built server and release helper", async () => {
    const result = await client.callTool({
      name: "computer_status",
      arguments: {},
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      permissions: {
        accessibility: expect.any(Boolean),
        "post-event": expect.any(Boolean),
        "screen-capture": expect.any(Boolean),
      },
    });
  });

  it("executes read-only display, application, and window discovery", async () => {
    const displays = await client.callTool({
      name: "display_list",
      arguments: {},
    });
    const applications = await client.callTool({
      name: "application_list",
      arguments: {},
    });
    const windows = await client.callTool({
      name: "window_list",
      arguments: { bundleIdentifier: "com.microsoft.VSCode" },
    });

    expect(displays.isError).not.toBe(true);
    expect(displays.structuredContent).toMatchObject({
      displays: expect.any(Array),
    });
    expect(applications.isError).not.toBe(true);
    expect(applications.structuredContent).toMatchObject({
      applications: expect.arrayContaining([
        expect.objectContaining({ bundleIdentifier: "com.microsoft.VSCode" }),
      ]),
    });
    expect(windows.isError).not.toBe(true);
    expect(windows.structuredContent).toMatchObject({
      windows: expect.arrayContaining([
        expect.objectContaining({
          owningApplication: expect.objectContaining({
            bundleIdentifier: "com.microsoft.VSCode",
          }),
        }),
      ]),
    });
  });

  it("executes a wait-only input batch through MCP stdio", async () => {
    const result = await client.callTool({
      name: "input_batch",
      arguments: {
        steps: [
          { type: "wait", durationMs: 0 },
          { type: "wait", durationMs: 5 },
        ],
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      completed: true,
      completedCount: 2,
      results: [
        { index: 0, type: "wait", result: { waitedMs: 0 } },
        { index: 1, type: "wait", result: { waitedMs: 5 } },
      ],
    });
  });

  it("returns mouse position through MCP stdio", async () => {
    const result = await client.callTool({
      name: "mouse_position",
      arguments: {},
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      position: { x: expect.any(Number), y: expect.any(Number) },
      heldButtons: expect.any(Array),
    });
  });

  it("returns metadata and image content without leaking artifact paths", async () => {
    const displays = await client.callTool({
      name: "display_list",
      arguments: {},
    });
    const displayList = displays.structuredContent as {
      displays: Array<{ displayId: string; isMain: boolean }>;
    };
    const display = displayList.displays.find((candidate) => candidate.isMain);
    if (!display) {
      throw new Error("No main display was discovered");
    }

    const result = await client.callTool({
      name: "screen_capture",
      arguments: {
        target: { kind: "display", displayId: display.displayId },
        format: "png",
        scale: "logical",
        maxWidth: 320,
        includeCursor: false,
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      capture: {
        mimeType: "image/png",
        outputPixelSize: { width: 320 },
        mapping: { kind: "linear" },
      },
    });
    expect(result.structuredContent).not.toHaveProperty("capture.artifactPath");
    expect(result.structuredContent).not.toHaveProperty("capture.artifactRoot");

    const content = z
      .array(
        z.union([
          z.looseObject({ type: z.literal("text"), text: z.string() }),
          z.looseObject({
            type: z.literal("image"),
            data: z.string(),
            mimeType: z.string(),
          }),
        ]),
      )
      .parse(result.content);
    const image = content.find((item) => item.type === "image");
    expect(image).toBeDefined();
    if (!image || image.type !== "image") {
      throw new Error("screen_capture did not return image content");
    }
    const bytes = Buffer.from(image.data, "base64");
    expect([...bytes.subarray(0, 8)]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
  });

  it("returns a post-focus verification image in the interaction result", async () => {
    const windows = await client.callTool({
      name: "window_list",
      arguments: {
        bundleIdentifier: "com.microsoft.VSCode",
        onScreenOnly: true,
        includeUntitled: false,
      },
    });
    const windowList = windows.structuredContent as {
      windows: Array<{ windowId: string }>;
    };
    const window = windowList.windows[0];
    if (!window) {
      throw new Error("No on-screen VS Code window was discovered");
    }

    const result = await client.callTool({
      name: "window_focus",
      arguments: {
        windowId: window.windowId,
        captureAfter: {
          target: { kind: "window", windowId: window.windowId },
          maxWidth: 320,
          settleMs: 100,
        },
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      interaction: {
        windowId: window.windowId,
        verified: true,
      },
      capture: {
        target: { kind: "window", windowId: window.windowId },
        mimeType: "image/jpeg",
        mapping: { kind: "linear" },
      },
    });
    expect(result.structuredContent).not.toHaveProperty("captureError");
    expect(result.structuredContent).not.toHaveProperty("capture.artifactPath");
    expect(result.structuredContent).not.toHaveProperty("capture.artifactRoot");
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "image",
          mimeType: "image/jpeg",
          data: expect.any(String),
        }),
      ]),
    );
  });
});
