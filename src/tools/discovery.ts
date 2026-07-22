import {
  addCaptureAfter,
  interactionToolResult,
  withCaptureAfter,
} from "./post-action-capture.js";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NativeBridge } from "../native/client.js";
import { z } from "zod";

const screenRectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});

const pixelSizeSchema = z.object({
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
});

const scaleSchema = z.object({
  x: z.number().nonnegative(),
  y: z.number().nonnegative(),
});

export const displaySchema = z.object({
  displayId: z.string(),
  name: z.string(),
  bounds: screenRectSchema,
  pixelSize: pixelSizeSchema,
  pixelsPerPoint: scaleSchema,
  isMain: z.boolean(),
  coreGraphicsBoundsMatch: z.boolean(),
});

export const applicationSchema = z.object({
  processId: z.number().int().positive(),
  bundleIdentifier: z.string().nullable(),
  name: z.string(),
  bundlePath: z.string().nullable(),
  isActive: z.boolean(),
  isHidden: z.boolean(),
  activationPolicy: z.number().int(),
});

const windowApplicationSchema = z.object({
  processId: z.number().int().positive(),
  bundleIdentifier: z.string(),
  name: z.string(),
});

export const windowSchema = z.object({
  windowId: z.string(),
  title: z.string(),
  bounds: screenRectSchema,
  isOnScreen: z.boolean(),
  isActive: z.boolean(),
  owningApplication: windowApplicationSchema,
});

const displayListResultSchema = z.object({ displays: z.array(displaySchema) });
const applicationListResultSchema = z.object({
  applications: z.array(applicationSchema),
});
const applicationActivateResultSchema = z.object({
  application: applicationSchema,
  verified: z.literal(true),
});
const windowListResultSchema = z.object({ windows: z.array(windowSchema) });
const windowFocusResultSchema = z.object({
  windowId: z.string(),
  title: z.string(),
  application: windowApplicationSchema,
  raiseResult: z.number().int(),
  verified: z.literal(true),
});

const applicationSelectorSchema = z.union([
  addCaptureAfter(
    z
      .object({
        processId: z.number().int().positive(),
      })
      .strict(),
  ),
  addCaptureAfter(
    z
      .object({
        bundleIdentifier: z.string().min(1),
      })
      .strict(),
  ),
]);

function toolResult<T extends Record<string, unknown>>(value: T) {
  return {
    structuredContent: value,
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

export function registerDiscoveryTools(
  server: McpServer,
  native: NativeBridge,
): void {
  server.registerTool(
    "display_list",
    {
      title: "List displays",
      description:
        "List macOS displays with stable session IDs, global logical bounds, pixel dimensions, and screenshot-to-pointer scale metadata.",
      outputSchema: displayListResultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const result = displayListResultSchema.parse(
        await native.request<unknown>("display.list"),
      );
      return toolResult(result);
    },
  );

  server.registerTool(
    "application_list",
    {
      title: "List applications",
      description:
        "List running macOS GUI applications. Background/accessory processes are excluded unless requested.",
      inputSchema: z.object({
        includeBackground: z.boolean().default(false),
      }),
      outputSchema: applicationListResultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ includeBackground }) => {
      const result = applicationListResultSchema.parse(
        await native.request<unknown>("application.list", {
          includeBackground,
        }),
      );
      return toolResult(result);
    },
  );

  server.registerTool(
    "application_activate",
    {
      title: "Activate application",
      description:
        "Bring exactly one running application to the foreground by either process ID or bundle identifier, then verify that it became frontmost. Optionally capture the resulting UI with captureAfter; capture failures are reported separately from successful activation.",
      inputSchema: applicationSelectorSchema,
      outputSchema: withCaptureAfter(applicationActivateResultSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (selector) =>
      interactionToolResult(
        native,
        "application.activate",
        selector,
        applicationActivateResultSchema,
      ),
  );

  server.registerTool(
    "window_list",
    {
      title: "List windows",
      description:
        "List capturable macOS windows, optionally filtered by application. When both bundleIdentifier and processId are supplied, windows must match both. Defaults to titled, on-screen windows for agent use.",
      inputSchema: z.object({
        bundleIdentifier: z.string().min(1).optional(),
        processId: z.number().int().positive().optional(),
        onScreenOnly: z.boolean().default(true),
        includeUntitled: z.boolean().default(false),
      }),
      outputSchema: windowListResultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const result = windowListResultSchema.parse(
        await native.request<unknown>("window.list", input),
      );
      return toolResult(result);
    },
  );

  server.registerTool(
    "window_focus",
    {
      title: "Focus window",
      description:
        "Activate a window's application, match the ScreenCaptureKit window to one Accessibility window, unminimize it if needed, make it the application's main window, raise it, and verify focus. Optionally capture the resulting UI with captureAfter; capture failures are reported separately from successful focus.",
      inputSchema: addCaptureAfter(
        z.object({
          windowId: z
            .string()
            .regex(/^\d+$/, "windowId must be a numeric string"),
        }),
      ),
      outputSchema: withCaptureAfter(windowFocusResultSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      interactionToolResult(
        native,
        "window.focus",
        input,
        windowFocusResultSchema,
      ),
  );
}
