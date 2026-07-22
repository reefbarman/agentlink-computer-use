import {
  addCaptureAfter,
  interactionToolResult,
  withCaptureAfter,
} from "./post-action-capture.js";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NativeBridge } from "../native/client.js";
import { keyboardStateSchema } from "./keyboard.js";
import { z } from "zod";

export const pointSchema = z.object({
  x: z.number(),
  y: z.number(),
});

export const buttonSchema = z.enum(["left", "right", "middle"]);
export const heldButtonsSchema = z.array(buttonSchema);

export const mouseStateSchema = z.object({
  position: pointSchema,
  heldButtons: heldButtonsSchema,
});

export const releaseResultSchema = z.object({
  ...mouseStateSchema.shape,
  ...keyboardStateSchema.shape,
  releasedButtons: heldButtonsSchema,
  releasedKeys: keyboardStateSchema.shape.heldKeys,
  releasedModifiers: keyboardStateSchema.shape.heldModifiers,
});

function toolResult<T extends Record<string, unknown>>(value: T) {
  return {
    structuredContent: value,
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

async function nativeMouseResult(
  native: NativeBridge,
  method: string,
  params: Record<string, unknown> = {},
) {
  return mouseStateSchema.parse(await native.request<unknown>(method, params));
}

export function registerMouseTools(
  server: McpServer,
  native: NativeBridge,
): void {
  server.registerTool(
    "mouse_position",
    {
      title: "Get mouse position",
      description:
        "Return the current cursor position in the same global logical-point coordinate space used by screen capture mappings.",
      outputSchema: mouseStateSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => toolResult(await nativeMouseResult(native, "mouse.position")),
  );

  server.registerTool(
    "mouse_move",
    {
      title: "Move mouse",
      description:
        "Move the cursor to an absolute global logical point. When one button is held, emits the corresponding dragged events. Optionally capture the resulting UI with captureAfter; capture failures are reported separately from successful movement.",
      inputSchema: addCaptureAfter(
        z.object({
          to: pointSchema,
          durationMs: z.number().int().min(0).max(10_000).default(0),
        }),
      ),
      outputSchema: withCaptureAfter(mouseStateSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      interactionToolResult(native, "mouse.move", input, mouseStateSchema),
  );

  server.registerTool(
    "mouse_button",
    {
      title: "Press or release mouse button",
      description:
        "Press and hold or release one mouse button, optionally after moving to an absolute point. Moving with a different button already held emits dragged events for that held button. Use input_release_all for recovery after an interrupted sequence. Optionally capture the resulting UI with captureAfter; capture failures are reported separately from the successful button operation.",
      inputSchema: addCaptureAfter(
        z.object({
          button: buttonSchema.default("left"),
          action: z.enum(["down", "up"]),
          point: pointSchema.optional(),
        }),
      ),
      outputSchema: withCaptureAfter(mouseStateSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      interactionToolResult(native, "mouse.button", input, mouseStateSchema),
  );

  server.registerTool(
    "mouse_click",
    {
      title: "Click mouse",
      description:
        "Click a mouse button at the current or supplied absolute point. Supports single, double, and triple click sequences. Moving to the supplied point with another button already held emits dragged events for that held button. Optionally capture the resulting UI with captureAfter; capture failures are reported separately from the successful click.",
      inputSchema: addCaptureAfter(
        z.object({
          button: buttonSchema.default("left"),
          point: pointSchema.optional(),
          count: z.number().int().min(1).max(3).default(1),
          intervalMs: z.number().int().min(0).max(1_000).default(100),
        }),
      ),
      outputSchema: withCaptureAfter(mouseStateSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      interactionToolResult(native, "mouse.click", input, mouseStateSchema),
  );

  server.registerTool(
    "mouse_drag",
    {
      title: "Drag mouse",
      description:
        "Move to an optional start point, hold one button, interpolate dragged events to the destination, and release the button. Optionally capture the resulting UI with captureAfter; capture failures are reported separately from the successful drag.",
      inputSchema: addCaptureAfter(
        z.object({
          button: buttonSchema.default("left"),
          from: pointSchema.optional(),
          to: pointSchema,
          durationMs: z.number().int().min(0).max(10_000).default(500),
        }),
      ),
      outputSchema: withCaptureAfter(mouseStateSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      interactionToolResult(native, "mouse.drag", input, mouseStateSchema),
  );

  server.registerTool(
    "mouse_scroll",
    {
      title: "Scroll mouse",
      description:
        "Scroll horizontally and/or vertically at the current or supplied point. Positive and negative direction follow macOS CGEvent scroll conventions. Moving to the supplied point with a held button emits dragged events for that held button. Optionally capture the resulting UI with captureAfter; capture failures are reported separately from the successful scroll.",
      inputSchema: addCaptureAfter(
        z.object({
          deltaX: z
            .number()
            .int()
            .min(-2_147_483_648)
            .max(2_147_483_647)
            .default(0),
          deltaY: z
            .number()
            .int()
            .min(-2_147_483_648)
            .max(2_147_483_647)
            .default(0),
          unit: z.enum(["line", "pixel"]).default("line"),
          point: pointSchema.optional(),
        }),
      ).refine(({ deltaX, deltaY }) => deltaX !== 0 || deltaY !== 0, {
        message: "At least one scroll delta must be nonzero",
      }),
      outputSchema: withCaptureAfter(mouseStateSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      interactionToolResult(native, "mouse.scroll", input, mouseStateSchema),
  );

  server.registerTool(
    "input_release_all",
    {
      title: "Release held input",
      description:
        "Release every keyboard key, modifier, and mouse button currently tracked as held by the native helper. Safe and idempotent when no input is held.",
      outputSchema: releaseResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const result = releaseResultSchema.parse(
        await native.request<unknown>("input.releaseAll"),
      );
      return toolResult(result);
    },
  );
}
