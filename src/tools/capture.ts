import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NativeBridge } from "../native/client.js";
import { consumeCaptureArtifact } from "../native/artifacts.js";
import { z } from "zod";

const rectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
});

export const captureTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("display"),
    displayId: z.string().regex(/^\d+$/, "displayId must be a numeric string"),
  }),
  z.object({
    kind: z.literal("window"),
    windowId: z.string().regex(/^\d+$/, "windowId must be a numeric string"),
  }),
  z.object({
    kind: z.literal("region"),
    bounds: rectSchema,
  }),
]);

export const captureScaleSchema = z.union([
  z.enum(["logical", "native"]),
  z.number().positive().max(4),
]);

const pixelSizeSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const captureMetadataSchema = z.object({
  captureId: z.uuid(),
  byteLength: z.number().int().positive(),
  target: captureTargetSchema,
  mimeType: z.enum(["image/png", "image/jpeg"]),
  nativePixelSize: pixelSizeSchema.nullable(),
  outputPixelSize: pixelSizeSchema,
  mapping: z.object({
    kind: z.literal("linear"),
    imageContentBounds: rectSchema,
    screenBounds: rectSchema,
    pixelsPerPoint: z.object({
      x: z.number().positive(),
      y: z.number().positive(),
    }),
  }),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  capturedAt: z.iso.datetime(),
});

export const captureRequestSchema = z.object({
  target: captureTargetSchema,
  format: z.enum(["png", "jpeg"]).default("png"),
  scale: captureScaleSchema.default("logical"),
  maxWidth: z.number().int().positive().max(16_384).optional(),
  maxHeight: z.number().int().positive().max(16_384).optional(),
  includeCursor: z.boolean().default(false),
});

export const captureAfterSchema = captureRequestSchema.extend({
  format: z.enum(["png", "jpeg"]).default("jpeg"),
  settleMs: z
    .number()
    .int()
    .min(0)
    .max(2_000)
    .default(100)
    .describe(
      "Fixed delay before capture, not a readiness or success check. Inspect the image or use ui_wait for a known Accessibility condition. A captureError does not mean the preceding action failed; do not repeat successful input just to obtain an image.",
    ),
});

const captureResultSchema = z.object({ capture: captureMetadataSchema });
export const helperStatusSchema = z.object({ artifactRoot: z.string().min(1) });

export function registerCaptureTools(
  server: McpServer,
  native: NativeBridge,
): void {
  server.registerTool(
    "screen_capture",
    {
      title: "Capture screen content",
      description:
        "Capture one display, one window, or a global logical-point region. Returns an image plus its pixel-to-global-point mapping. For visual input, use this capture's mapping, not raw image pixels: screen = screenBounds origin + (image point - imageContentBounds origin) / pixelsPerPoint, per axis. Account for any additional host resizing before applying that mapping. Prefer a focused window or region for small controls; recapture after geometry changes. Region targets must fit entirely within one display. nativePixelSize is null when a window spans displays. Use an input tool's captureAfter when an action and its resulting image are both needed.",
      inputSchema: captureRequestSchema,
      outputSchema: captureResultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const status = helperStatusSchema.parse(
        await native.request<unknown>("health"),
      );
      const artifact = await native.request<unknown>("screen.capture", input);
      const consumed = await consumeCaptureArtifact(
        artifact,
        status.artifactRoot,
      );
      const capture = captureMetadataSchema.parse(consumed.metadata);
      const structuredContent = { capture };

      return {
        structuredContent,
        content: [
          {
            type: "text",
            text: JSON.stringify(structuredContent, null, 2),
          },
          {
            type: "image",
            data: consumed.data,
            mimeType: capture.mimeType,
          },
        ],
      };
    },
  );
}
