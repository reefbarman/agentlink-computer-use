import {
  captureAfterSchema,
  captureMetadataSchema,
  helperStatusSchema,
} from "./capture.js";

import type { NativeBridge } from "../native/client.js";
import { NativeError } from "../native/protocol.js";
import { consumeCaptureArtifact } from "../native/artifacts.js";
import { z } from "zod";

const captureErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export function withCaptureAfter<T extends z.ZodRawShape>(
  interactionSchema: z.ZodObject<T>,
) {
  return z.object({
    ...interactionSchema.partial().shape,
    interaction: interactionSchema.optional(),
    capture: captureMetadataSchema.optional(),
    captureError: captureErrorSchema.optional(),
  });
}

export function addCaptureAfter<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
) {
  return schema.extend({ captureAfter: captureAfterSchema.optional() });
}

export async function interactionToolResult<T extends Record<string, unknown>>(
  native: NativeBridge,
  method: string,
  params: Record<string, unknown>,
  interactionSchema: z.ZodType<T>,
) {
  if (params.captureAfter === undefined) {
    const raw = await native.request<unknown>(method, params);
    const interaction = interactionSchema.parse(raw);
    return {
      structuredContent: interaction,
      content: [
        { type: "text" as const, text: JSON.stringify(interaction, null, 2) },
      ],
    };
  }

  const status = helperStatusSchema.parse(
    await native.request<unknown>("health"),
  );
  const raw = await native.request<unknown>(method, params);
  const nativeEnvelope = z
    .object({
      interaction: z.unknown(),
      capture: z.unknown().optional(),
      captureError: captureErrorSchema.optional(),
    })
    .refine(
      ({ capture, captureError }) =>
        (capture === undefined) !== (captureError === undefined),
      {
        message:
          "Native interaction result must contain capture or captureError",
      },
    )
    .parse(raw);

  let captureError = nativeEnvelope.captureError;
  let capture: z.infer<typeof captureMetadataSchema> | undefined;
  let image:
    | { type: "image"; data: string; mimeType: "image/png" | "image/jpeg" }
    | undefined;

  if (nativeEnvelope.capture !== undefined) {
    try {
      const consumed = await consumeCaptureArtifact(
        nativeEnvelope.capture,
        status.artifactRoot,
      );
      capture = captureMetadataSchema.parse(consumed.metadata);
      image = {
        type: "image",
        data: consumed.data,
        mimeType: capture.mimeType,
      };
    } catch (error) {
      captureError = {
        code: error instanceof NativeError ? error.code : "native_unavailable",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const interaction = interactionSchema.parse(nativeEnvelope.interaction);
  const structuredContent = {
    interaction,
    ...(capture === undefined ? {} : { capture }),
    ...(captureError === undefined ? {} : { captureError }),
  };
  return {
    structuredContent,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(structuredContent, null, 2),
      },
      ...(image === undefined ? [] : [image]),
    ],
  };
}
