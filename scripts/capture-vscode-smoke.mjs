#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { z } from "zod";

const outputPath = process.argv[2] ?? "/tmp/computer-use-mcp-visual-smoke.png";
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("dist/index.js")],
  env: {
    ...process.env,
    COMPUTER_USE_NATIVE_PATH: resolve(
      "native/.build/release/ComputerUseNative",
    ),
  },
  stderr: "pipe",
});
const client = new Client({ name: "capture-smoke", version: "1.0.0" });

try {
  await client.connect(transport);
  const windows = await client.callTool({
    name: "window_list",
    arguments: {
      bundleIdentifier: "com.microsoft.VSCode",
      onScreenOnly: true,
      includeUntitled: false,
    },
  });
  const windowList = z
    .object({
      windows: z.array(z.object({ windowId: z.string(), title: z.string() })),
    })
    .parse(windows.structuredContent);
  const window = windowList.windows[0];
  if (!window) {
    throw new Error("No titled on-screen VS Code window was discovered");
  }

  const result = await client.callTool({
    name: "screen_capture",
    arguments: {
      target: { kind: "window", windowId: window.windowId },
      format: "png",
      scale: "logical",
      maxWidth: 1200,
      includeCursor: false,
    },
  });
  if (result.isError) {
    throw new Error("screen_capture returned an MCP tool error");
  }

  const content = z
    .array(
      z.union([
        z.object({ type: z.literal("text"), text: z.string() }).passthrough(),
        z
          .object({
            type: z.literal("image"),
            data: z.string(),
            mimeType: z.literal("image/png"),
          })
          .passthrough(),
      ]),
    )
    .parse(result.content);
  const image = content.find((item) => item.type === "image");
  if (!image || image.type !== "image") {
    throw new Error("screen_capture returned no PNG image content");
  }

  await writeFile(outputPath, Buffer.from(image.data, "base64"));
  process.stdout.write(
    `${JSON.stringify({ outputPath, windowId: window.windowId, title: window.title, capture: result.structuredContent }, null, 2)}\n`,
  );
} finally {
  await client.close();
}
