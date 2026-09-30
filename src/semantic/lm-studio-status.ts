import { z } from "zod";

const modelNameSchema = z.string().min(1).max(256);
const timestampSchema = z.iso.datetime();

export const lmStudioStatusSchema = z.object({
  state: z.enum([
    "checking",
    "disabled",
    "offline",
    "not_loaded",
    "unsupported",
    "ambiguous",
    "ready",
    "error",
  ]),
  model: modelNameSchema.nullable(),
  checkedAt: timestampSchema.nullable(),
  detail: z.string().min(1).max(512).nullable(),
  lastUsed: z
    .object({
      at: timestampSchema,
      model: modelNameSchema,
      durationMs: z.number().finite().nonnegative(),
    })
    .nullable(),
  lastFailure: z
    .object({
      at: timestampSchema,
      reason: z.string().min(1).max(256),
      model: modelNameSchema.nullable(),
    })
    .nullable(),
});

export type LmStudioStatus = z.infer<typeof lmStudioStatusSchema>;

export function initialLmStudioStatus(disabled = false): LmStudioStatus {
  return {
    state: disabled ? "disabled" : "checking",
    model: null,
    checkedAt: null,
    detail: disabled ? "LM Studio visual selection is disabled" : null,
    lastUsed: null,
    lastFailure: null,
  };
}
