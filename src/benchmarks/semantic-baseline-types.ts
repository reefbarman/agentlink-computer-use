import { z } from "zod";

const rectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
});

const pointSchema = z.object({ x: z.number(), y: z.number() });

export const semanticControlSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["button", "checkbox", "text_field", "status"]),
  label: z.string().min(1),
  bounds: rectSchema,
  actionPoint: pointSchema.optional(),
});

export const semanticWorkflowSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  goal: z.string().min(1),
  expectedActions: z.array(z.string().min(1)).min(1).max(25),
  expectedFinalState: z.object({
    submittedText: z.string(),
    cloudSyncEnabled: z.boolean(),
    statusText: z.string(),
  }),
});

export const semanticTargetStateSchema = z.object({
  submittedText: z.string(),
  cloudSyncEnabled: z.boolean(),
  statusText: z.string(),
  actions: z.array(z.string()),
  forbiddenActionCount: z.number().int().nonnegative(),
  receivedInputEventCount: z.number().int().nonnegative(),
});

export const semanticTargetEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    schemaVersion: z.literal(1),
    processId: z.number().int().positive(),
    window: z.object({ title: z.string().min(1), bounds: rectSchema }),
    controls: z.array(semanticControlSchema).min(1),
    workflows: z.array(semanticWorkflowSchema).min(1),
    state: semanticTargetStateSchema,
  }),
  z.object({
    type: z.literal("state"),
    requestId: z.string().min(1),
    state: semanticTargetStateSchema,
  }),
  z.object({
    type: z.literal("action"),
    action: z.string().min(1),
    state: semanticTargetStateSchema,
  }),
  z.object({
    type: z.literal("error"),
    requestId: z.string().optional(),
    message: z.string().min(1),
  }),
]);

export type SemanticTargetEvent = z.infer<typeof semanticTargetEventSchema>;
export type SemanticWorkflow = z.infer<typeof semanticWorkflowSchema>;
export type SemanticTargetState = z.infer<typeof semanticTargetStateSchema>;

export const semanticTargetCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("reset"), requestId: z.string().min(1) }),
  z.object({ type: z.literal("state"), requestId: z.string().min(1) }),
  z.object({
    type: z.literal("set_status_label"),
    requestId: z.string().min(1),
    label: z.string().min(1).max(256),
  }),
]);

export type SemanticTargetCommand = z.infer<typeof semanticTargetCommandSchema>;

export const semanticTraceEntrySchema = z.object({
  sequence: z.number().int().nonnegative(),
  layer: z.enum(["mcp", "native", "target"]),
  operation: z.string().min(1),
  startedOffsetMs: z.number().nonnegative(),
  durationMs: z.number().nonnegative(),
  requestBytes: z.number().int().nonnegative(),
  responseBytes: z.number().int().nonnegative(),
  imageBytes: z.number().int().nonnegative().optional(),
  status: z.enum(["ok", "error"]),
  errorCategory: z.string().min(1).optional(),
});

export type SemanticTraceEntry = z.infer<typeof semanticTraceEntrySchema>;

export const semanticBaselineTrialSchema = z.object({
  workflowId: z.string().min(1),
  route: z.enum(["oracle", "primitive", "input_batch"]),
  repetition: z.number().int().positive(),
  passed: z.boolean(),
  finalState: semanticTargetStateSchema,
  expectedFinalState: semanticWorkflowSchema.shape.expectedFinalState,
  topLevelMcpCalls: z.number().int().nonnegative(),
  nativeRequests: z.number().int().nonnegative(),
  captures: z.number().int().nonnegative(),
  captureBytes: z.number().int().nonnegative(),
  inputEvents: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  trace: z.array(semanticTraceEntrySchema),
  error: z
    .object({ code: z.string().min(1), message: z.string().min(1) })
    .optional(),
});

export type SemanticBaselineTrial = z.infer<typeof semanticBaselineTrialSchema>;

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
}

export function aggregateSemanticBaseline(trials: SemanticBaselineTrial[]) {
  const groups = new Map<
    SemanticBaselineTrial["route"],
    SemanticBaselineTrial[]
  >();
  for (const trial of trials) {
    const group = groups.get(trial.route);
    if (group === undefined) {
      groups.set(trial.route, [trial]);
    } else {
      group.push(trial);
    }
  }
  return Array.from(groups, ([route, group]) => ({
    route,
    total: group.length,
    passed: group.filter(({ passed }) => passed).length,
    durationMs: {
      sampleCount: group.length,
      p50: percentile(
        group.map(({ durationMs }) => durationMs),
        0.5,
      ),
      p95Qualified: group.length >= 30,
      p95:
        group.length < 30
          ? null
          : percentile(
              group.map(({ durationMs }) => durationMs),
              0.95,
            ),
      max: Math.max(...group.map(({ durationMs }) => durationMs)),
    },
    meanTopLevelMcpCalls:
      group.reduce((total, trial) => total + trial.topLevelMcpCalls, 0) /
      group.length,
    meanNativeRequests:
      group.reduce((total, trial) => total + trial.nativeRequests, 0) /
      group.length,
    meanCaptures:
      group.reduce((total, trial) => total + trial.captures, 0) / group.length,
    meanCaptureBytes:
      group.reduce((total, trial) => total + trial.captureBytes, 0) /
      group.length,
    meanInputEvents:
      group.reduce((total, trial) => total + trial.inputEvents, 0) /
      group.length,
  }));
}

export function statesMatch(
  actual: SemanticTargetState,
  expected: SemanticWorkflow["expectedFinalState"],
  expectedActions: string[],
): boolean {
  return (
    actual.submittedText === expected.submittedText &&
    actual.cloudSyncEnabled === expected.cloudSyncEnabled &&
    actual.statusText === expected.statusText &&
    actual.forbiddenActionCount === 0 &&
    actual.actions.length === expectedActions.length &&
    actual.actions.every((action, index) => action === expectedActions[index])
  );
}
