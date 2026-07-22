import { z } from "zod";

export const nativeErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export const nativeResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    id: z.union([z.string(), z.number()]),
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.object({
    id: z.union([z.string(), z.number(), z.null()]),
    ok: z.literal(false),
    error: nativeErrorSchema,
  }),
]);

export type NativeResponse = z.infer<typeof nativeResponseSchema>;

export interface NativeRequest {
  id: string;
  version: 1;
  method: string;
  params: Record<string, unknown>;
}

export class NativeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "NativeError";
  }
}
