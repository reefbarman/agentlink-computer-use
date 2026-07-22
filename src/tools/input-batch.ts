import {
  addCaptureAfter,
  interactionToolResult,
  withCaptureAfter,
} from "./post-action-capture.js";
import {
  buttonSchema,
  mouseStateSchema,
  pointSchema,
  releaseResultSchema,
} from "./mouse.js";
import {
  keyboardKeySchema,
  keyboardStateSchema,
  modifierSchema,
} from "./keyboard.js";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NativeBridge } from "../native/client.js";
import { z } from "zod";

const maximumBatchDurationMs = 30_000;
const maximumBatchInputUnits = 4_096;

const mouseMoveStepSchema = z.object({
  type: z.literal("mouse_move"),
  to: pointSchema,
  durationMs: z.number().int().min(0).max(10_000).default(0),
});

const mouseButtonStepSchema = z.object({
  type: z.literal("mouse_button"),
  button: buttonSchema.default("left"),
  action: z.enum(["down", "up"]),
  point: pointSchema.optional(),
});

const mouseClickStepSchema = z.object({
  type: z.literal("mouse_click"),
  button: buttonSchema.default("left"),
  point: pointSchema.optional(),
  count: z.number().int().min(1).max(3).default(1),
  intervalMs: z.number().int().min(0).max(1_000).default(100),
});

const mouseDragStepSchema = z.object({
  type: z.literal("mouse_drag"),
  button: buttonSchema.default("left"),
  from: pointSchema.optional(),
  to: pointSchema,
  durationMs: z.number().int().min(0).max(10_000).default(500),
});

const mouseScrollStepSchema = z
  .object({
    type: z.literal("mouse_scroll"),
    deltaX: z.number().int().min(-2_147_483_648).max(2_147_483_647).default(0),
    deltaY: z.number().int().min(-2_147_483_648).max(2_147_483_647).default(0),
    unit: z.enum(["line", "pixel"]).default("line"),
    point: pointSchema.optional(),
  })
  .refine(({ deltaX, deltaY }) => deltaX !== 0 || deltaY !== 0, {
    message: "At least one scroll delta must be nonzero",
  });

const keyboardTypeStepSchema = z
  .object({
    type: z.literal("keyboard_type"),
    text: z.string().min(1).max(4_096),
    intervalMs: z.number().int().min(0).max(1_000).default(0),
  })
  .refine(
    ({ text, intervalMs }) =>
      Math.max(0, Array.from(text).length - 1) * intervalMs <= 10_000,
    { message: "Keyboard typing delay may not exceed 10000 ms" },
  );

const keyboardKeyStepSchema = z
  .object({
    type: z.literal("keyboard_key"),
    key: keyboardKeySchema,
    action: z.enum(["press", "down", "up"]).default("press"),
    modifiers: z.array(modifierSchema).max(5).default([]),
    repeat: z.number().int().min(1).max(100).default(1),
  })
  .superRefine(({ key, action, modifiers, repeat }, context) => {
    if (new Set(modifiers).size !== modifiers.length) {
      context.addIssue({
        code: "custom",
        path: ["modifiers"],
        message: "Modifiers must not contain duplicates",
      });
    }
    if (action !== "press" && (modifiers.length > 0 || repeat !== 1)) {
      context.addIssue({
        code: "custom",
        message: "Modifiers and repeat are supported only for press actions",
      });
    }
    if (action === "press" && modifiers.includes(key as never)) {
      context.addIssue({
        code: "custom",
        path: ["modifiers"],
        message: "A key cannot also be its own transient modifier",
      });
    }
    if (
      key === "caps-lock" &&
      (action !== "press" || modifiers.length > 0 || repeat !== 1)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Caps Lock supports only a one-shot press without modifiers or repeat",
      });
    }
  });

const keyboardShortcutStepSchema = z
  .object({
    type: z.literal("keyboard_shortcut"),
    keys: z.array(keyboardKeySchema).min(2).max(8),
    holdMs: z.number().int().min(0).max(10_000).default(0),
  })
  .superRefine(({ keys }, context) => {
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        path: ["keys"],
        message: "Shortcut keys must not contain duplicates",
      });
    }
    if (keys.includes("caps-lock")) {
      context.addIssue({
        code: "custom",
        path: ["keys"],
        message: "Caps Lock cannot be part of a shortcut",
      });
    }
  });

const waitStepSchema = z.object({
  type: z.literal("wait"),
  durationMs: z.number().int().min(0).max(5_000),
});

const inputBatchStepTypeSchema = z.enum([
  "mouse_move",
  "mouse_button",
  "mouse_click",
  "mouse_drag",
  "mouse_scroll",
  "keyboard_type",
  "keyboard_key",
  "keyboard_shortcut",
  "wait",
]);

const inputBatchStepSchema = z.union([
  mouseMoveStepSchema,
  mouseButtonStepSchema,
  mouseClickStepSchema,
  mouseDragStepSchema,
  mouseScrollStepSchema,
  keyboardTypeStepSchema,
  keyboardKeyStepSchema,
  keyboardShortcutStepSchema,
  waitStepSchema,
]);

type InputBatchStep = z.infer<typeof inputBatchStepSchema>;

function inputUnits(step: InputBatchStep): number {
  switch (step.type) {
    case "mouse_click":
      return step.count;
    case "keyboard_type":
      return Array.from(step.text).length;
    case "keyboard_key":
      return step.repeat;
    case "keyboard_shortcut":
      return step.keys.length;
    default:
      return 1;
  }
}

function declaredDurationMs(step: InputBatchStep): number {
  switch (step.type) {
    case "mouse_move":
    case "mouse_drag":
      return step.durationMs;
    case "mouse_click":
      return (step.count - 1) * step.intervalMs;
    case "keyboard_type":
      return Math.max(0, Array.from(step.text).length - 1) * step.intervalMs;
    case "keyboard_shortcut":
      return step.holdMs;
    case "wait":
      return step.durationMs;
    default:
      return 0;
  }
}

const inputBatchRequestSchema = addCaptureAfter(
  z
    .object({
      steps: z.array(inputBatchStepSchema).min(1).max(25),
    })
    .refine(
      ({ steps }) =>
        steps.reduce((total, step) => total + declaredDurationMs(step), 0) <=
        maximumBatchDurationMs,
      { message: "Declared batch duration may not exceed 30000 ms" },
    )
    .refine(
      ({ steps }) =>
        steps.reduce((total, step) => total + inputUnits(step), 0) <=
        maximumBatchInputUnits,
      { message: "Batch input workload may not exceed 4096 units" },
    ),
);

const batchStepResultSchema = z.object({
  index: z.number().int().min(0),
  type: inputBatchStepTypeSchema,
  result: z.union([
    mouseStateSchema,
    keyboardStateSchema,
    z.object({ waitedMs: z.number().int() }),
  ]),
});

const batchFailureSchema = z.object({
  index: z.number().int().min(0),
  type: inputBatchStepTypeSchema,
  error: z.object({ code: z.string(), message: z.string() }),
  cleanup: releaseResultSchema,
});

const inputBatchResultObjectSchema = z.object({
  completed: z.boolean(),
  completedCount: z.number().int().min(0).max(25),
  results: z.array(batchStepResultSchema).max(25),
  failure: batchFailureSchema.optional(),
});

const inputBatchResultSchema = inputBatchResultObjectSchema.superRefine(
  ({ completed, completedCount, results, failure }, context) => {
    if (completedCount !== results.length) {
      context.addIssue({
        code: "custom",
        path: ["completedCount"],
        message: "Completed count must match the number of step results",
      });
    }
    if (results.some(({ index }, resultIndex) => index !== resultIndex)) {
      context.addIssue({
        code: "custom",
        path: ["results"],
        message: "Step result indexes must be contiguous and zero-based",
      });
    }
    if (completed === (failure !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["failure"],
        message:
          "Completed batches must omit failure and stopped batches must include it",
      });
    }
    if (failure !== undefined && failure.index !== completedCount) {
      context.addIssue({
        code: "custom",
        path: ["failure", "index"],
        message: "Failure index must follow the completed step results",
      });
    }
  },
);

export function registerInputBatchTool(
  server: McpServer,
  native: NativeBridge,
): void {
  server.registerTool(
    "input_batch",
    {
      title: "Perform input batch",
      description:
        "Validate and perform 1-25 mouse, keyboard, and wait steps sequentially. The whole batch is validated before input begins. Execution stops on the first runtime failure and automatically releases all tracked input state. Optionally capture the resulting UI after execution finishes, including after a stopped batch.",
      inputSchema: inputBatchRequestSchema,
      outputSchema: withCaptureAfter(inputBatchResultObjectSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const result = await interactionToolResult(
        native,
        "input.batch",
        input,
        inputBatchResultSchema,
      );
      const structuredContent = result.structuredContent;
      const batch = inputBatchResultSchema.parse(
        "interaction" in structuredContent
          ? structuredContent.interaction
          : structuredContent,
      );
      return batch.completed ? result : { ...result, isError: true };
    },
  );
}
