import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NativeBridge } from "../native/client.js";
import type { CoordinatedNativeBridge } from "../semantic/operation-coordinator.js";

import { NativeError } from "../native/protocol.js";
import {
  accessibilityActSchema,
  accessibilityFillSchema,
  accessibilityWaitSchema,
  uiWorkflowInputSchema,
  type UiWorkflowStep,
} from "../semantic/contracts.js";
import { applicationSchema } from "./discovery.js";
import { z } from "zod";

const applicationListResultSchema = z.object({
  applications: z.array(applicationSchema),
});

const scopeApplicationSchema = z.object({
  processId: z.number().int().positive(),
  processInstanceId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  bundleIdentifier: z.string().nullable(),
  launchDate: z.iso.datetime().nullable(),
});

const workflowStepResultSchema = z.discriminatedUnion("kind", [
  z.object({
    index: z.number().int().nonnegative(),
    kind: z.enum(["act", "fill"]),
    status: z.enum(["verified", "not_dispatched", "indeterminate"]),
    dispatchAttempted: z.boolean(),
    durationMs: z.number().nonnegative(),
    reasons: z.array(z.string().min(1)),
  }),
  z.object({
    index: z.number().int().nonnegative(),
    kind: z.literal("wait"),
    status: z.enum(["satisfied", "timed_out", "uncertain"]),
    dispatchAttempted: z.literal(false),
    durationMs: z.number().nonnegative(),
    reasons: z.array(z.string().min(1)),
  }),
]);

const uiWorkflowResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    outcome: z.enum([
      "verified",
      "not_dispatched",
      "indeterminate",
      "timed_out",
      "uncertain",
    ]),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime(),
    durationMs: z.number().nonnegative(),
    applicationMatchCount: z.number().int().nonnegative(),
    scope: z.object({ application: scopeApplicationSchema }).nullable(),
    completedStepCount: z.number().int().nonnegative(),
    stoppedAtStep: z.number().int().nonnegative().nullable(),
    steps: z.array(workflowStepResultSchema).max(8),
    reasons: z.array(z.string().min(1)),
  })
  .superRefine((value, context) => {
    const resolvedApplication = value.applicationMatchCount === 1;
    if (value.scope !== null && !resolvedApplication) {
      context.addIssue({
        code: "custom",
        path: ["scope"],
        message: "workflow scope requires exactly one application match",
      });
    }
    if (value.outcome === "verified" && value.scope === null) {
      context.addIssue({
        code: "custom",
        path: ["scope"],
        message: "verified workflow requires native-verified application scope",
      });
    }
    if (value.completedStepCount > value.steps.length) {
      context.addIssue({
        code: "custom",
        path: ["completedStepCount"],
        message: "completed workflow steps cannot exceed reported steps",
      });
    }
    if (value.outcome === "verified") {
      if (
        value.stoppedAtStep !== null ||
        value.completedStepCount !== value.steps.length ||
        value.reasons.length !== 0
      ) {
        context.addIssue({
          code: "custom",
          message: "verified workflows must complete all steps without reasons",
        });
      }
    } else if (value.stoppedAtStep === null || value.reasons.length === 0) {
      context.addIssue({
        code: "custom",
        message: "non-verified workflows require a stop step and reason",
      });
    }
  });

type UiWorkflowResult = z.infer<typeof uiWorkflowResultSchema>;
type WorkflowScope = z.infer<typeof scopeApplicationSchema>;
type WorkflowStepResult = z.infer<typeof workflowStepResultSchema>;

type StepOutcome = WorkflowStepResult extends infer _Ignored
  ? {
      status: WorkflowStepResult["status"];
      dispatchAttempted: boolean;
      durationMs: number;
      reasons: string[];
      application: WorkflowScope | null;
    }
  : never;

function elapsedMs(started: number): number {
  return performance.now() - started;
}

function result(value: UiWorkflowResult) {
  return {
    structuredContent: value,
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    ...(value.outcome === "verified" ? {} : { isError: true as const }),
  };
}

function stoppedResult(
  startedAt: string,
  started: number,
  applicationMatchCount: number,
  reason: string,
): UiWorkflowResult {
  return uiWorkflowResultSchema.parse({
    schemaVersion: 1,
    outcome: "not_dispatched",
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: elapsedMs(started),
    applicationMatchCount,
    scope: null,
    completedStepCount: 0,
    stoppedAtStep: null,
    steps: [],
    reasons: [reason],
  });
}

function remainingTimeout(
  deadline: number,
  ceiling: number,
): number | undefined {
  const remaining = deadline - performance.now();
  if (remaining <= 0) return undefined;
  return Math.min(ceiling, Math.floor(remaining));
}

function minimumBudget(step: UiWorkflowStep): number {
  return step.kind === "wait"
    ? step.pollIntervalMs
    : Math.max(step.pollIntervalMs, 250);
}

function scopeFor(
  application: z.infer<typeof applicationSchema>,
  nativeApplication: WorkflowScope,
): WorkflowScope | null {
  if (
    nativeApplication.processId !== application.processId ||
    (application.bundleIdentifier !== null &&
      nativeApplication.bundleIdentifier !== application.bundleIdentifier)
  ) {
    return null;
  }
  return {
    ...nativeApplication,
    bundleIdentifier: nativeApplication.bundleIdentifier || null,
  };
}

function sameScope(left: WorkflowScope, right: WorkflowScope): boolean {
  return (
    left.processId === right.processId &&
    left.processInstanceId === right.processInstanceId &&
    left.bundleIdentifier === right.bundleIdentifier &&
    left.launchDate === right.launchDate
  );
}

async function executeStep(
  native: NativeBridge,
  application: z.infer<typeof applicationSchema>,
  expectedBundleIdentifier: string | null,
  step: UiWorkflowStep,
  timeoutMs: number,
): Promise<StepOutcome> {
  const base = {
    processId: application.processId,
    expectedBundleIdentifier: expectedBundleIdentifier ?? undefined,
    contentPolicy: "redacted" as const,
  };
  if (step.kind === "act") {
    const value = accessibilityActSchema.parse(
      await native.request<unknown>("accessibility.act", {
        ...base,
        target: step.target,
        action: step.action,
        ...(step.expectedTargetFingerprint === undefined
          ? {}
          : { expectedTargetFingerprint: step.expectedTargetFingerprint }),
        ...(step.precondition === undefined
          ? {}
          : { precondition: step.precondition }),
        postcondition: step.postcondition,
        verificationTimeoutMs: Math.min(step.verificationTimeoutMs, timeoutMs),
        pollIntervalMs: step.pollIntervalMs,
      }),
    );
    return {
      status: value.outcome,
      dispatchAttempted: value.dispatchAttempted,
      durationMs: value.durationMs,
      reasons: value.reasons,
      application:
        value.application === null
          ? null
          : scopeFor(application, value.application),
    };
  }
  if (step.kind === "fill") {
    const value = accessibilityFillSchema.parse(
      await native.request<unknown>("accessibility.fill", {
        ...base,
        fields: step.fields,
        postcondition: step.postcondition,
        verificationTimeoutMs: Math.min(step.verificationTimeoutMs, timeoutMs),
        pollIntervalMs: step.pollIntervalMs,
      }),
    );
    return {
      status: value.outcome,
      dispatchAttempted: value.dispatchAttempted,
      durationMs: value.durationMs,
      reasons: value.reasons,
      application:
        value.application === null
          ? null
          : scopeFor(application, value.application),
    };
  }
  const value = accessibilityWaitSchema.parse(
    await native.request<unknown>("accessibility.wait", {
      ...base,
      condition: step.condition,
      timeoutMs: Math.min(step.timeoutMs, timeoutMs),
      pollIntervalMs: step.pollIntervalMs,
    }),
  );
  return {
    status: value.status,
    dispatchAttempted: false,
    durationMs: value.durationMs,
    reasons: value.reasons,
    application: scopeFor(application, value.application),
  };
}

function workflowFailure(
  startedAt: string,
  started: number,
  scope: WorkflowScope | null,
  stepResults: WorkflowStepResult[],
  completedStepCount: number,
  index: number,
  outcome: UiWorkflowResult["outcome"],
  reasons: string[],
): UiWorkflowResult {
  return uiWorkflowResultSchema.parse({
    schemaVersion: 1,
    outcome,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: elapsedMs(started),
    applicationMatchCount: 1,
    scope: scope === null ? null : { application: scope },
    completedStepCount,
    stoppedAtStep: index,
    steps: stepResults,
    reasons: reasons.length === 0 ? ["workflow_step_failed"] : reasons,
  });
}

export function registerUiWorkflowTool(
  server: McpServer,
  native: CoordinatedNativeBridge,
): void {
  server.registerTool(
    "ui_workflow",
    {
      title: "Run bounded semantic workflow",
      description:
        "Run up to 8 typed AX-only act, fill, and wait steps against one identity-pinned application. Prefer this for a known sequence of accessible controls with explicit postconditions; use separate calls when later steps depend on inspecting new results. Each action or fill retains its native re-resolve → dispatch → verification transaction. The workflow validates all steps first, stops on the first non-success, never retries after dispatch, and does not support physical input, keyboard, clipboard, or vision fallback. Inspect stoppedAtStep and completedStepCount before considering recovery; do not replay completed steps blindly.",
      inputSchema: uiWorkflowInputSchema,
      outputSchema: uiWorkflowResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ scope, steps, timeoutMs }) =>
      native.runExclusive(async () => {
        const startedAt = new Date().toISOString();
        const started = performance.now();
        const applications = applicationListResultSchema
          .parse(
            await native.request<unknown>("application.list", {
              includeBackground: true,
            }),
          )
          .applications.filter((application) =>
            "processId" in scope
              ? application.processId === scope.processId
              : application.bundleIdentifier === scope.bundleIdentifier,
          );
        if (applications.length === 0) {
          return result(
            stoppedResult(startedAt, started, 0, "application_not_found"),
          );
        }
        if (applications.length > 1) {
          return result(
            stoppedResult(
              startedAt,
              started,
              applications.length,
              "application_ambiguous",
            ),
          );
        }
        const application = applications[0];
        if (application === undefined)
          throw new Error("Resolved application disappeared before workflow");

        const deadline = started + timeoutMs;
        const stepResults: WorkflowStepResult[] = [];
        let pinnedScope: WorkflowScope | undefined;
        for (const [index, step] of steps.entries()) {
          const remaining = remainingTimeout(deadline, 30_000);
          if (remaining === undefined || remaining < minimumBudget(step)) {
            if (pinnedScope === undefined) {
              return result(
                uiWorkflowResultSchema.parse({
                  schemaVersion: 1,
                  outcome: "timed_out",
                  startedAt,
                  finishedAt: new Date().toISOString(),
                  durationMs: elapsedMs(started),
                  applicationMatchCount: 1,
                  scope: null,
                  completedStepCount: 0,
                  stoppedAtStep: index,
                  steps: [],
                  reasons: ["workflow_timeout"],
                }),
              );
            }
            return result(
              workflowFailure(
                startedAt,
                started,
                pinnedScope,
                stepResults,
                stepResults.length,
                index,
                "timed_out",
                ["workflow_timeout"],
              ),
            );
          }
          const stepStarted = performance.now();
          try {
            const outcome = await executeStep(
              native,
              application,
              pinnedScope?.bundleIdentifier ?? application.bundleIdentifier,
              step,
              remaining,
            );
            if (outcome.application === null) {
              const status =
                step.kind === "wait"
                  ? "uncertain"
                  : outcome.dispatchAttempted
                    ? "indeterminate"
                    : "not_dispatched";
              stepResults.push({
                index,
                kind: step.kind,
                status,
                dispatchAttempted: outcome.dispatchAttempted,
                durationMs: elapsedMs(stepStarted),
                reasons: ["application_changed"],
              } as WorkflowStepResult);
              return result(
                workflowFailure(
                  startedAt,
                  started,
                  pinnedScope ?? null,
                  stepResults,
                  stepResults.length - 1,
                  index,
                  status === "uncertain" ? "uncertain" : status,
                  ["application_changed"],
                ),
              );
            }
            if (pinnedScope === undefined) {
              pinnedScope = outcome.application;
            } else if (!sameScope(pinnedScope, outcome.application)) {
              stepResults.push({
                index,
                kind: step.kind,
                status: step.kind === "wait" ? "uncertain" : "indeterminate",
                dispatchAttempted: outcome.dispatchAttempted,
                durationMs: elapsedMs(stepStarted),
                reasons: ["application_changed"],
              } as WorkflowStepResult);
              return result(
                workflowFailure(
                  startedAt,
                  started,
                  pinnedScope,
                  stepResults,
                  stepResults.length - 1,
                  index,
                  outcome.dispatchAttempted
                    ? "indeterminate"
                    : "not_dispatched",
                  ["application_changed"],
                ),
              );
            }
            const record = workflowStepResultSchema.parse({
              index,
              kind: step.kind,
              status: outcome.status,
              dispatchAttempted: outcome.dispatchAttempted,
              durationMs: elapsedMs(stepStarted),
              reasons: outcome.reasons,
            });
            stepResults.push(record);
            if (
              outcome.status !== "verified" &&
              outcome.status !== "satisfied"
            ) {
              return result(
                workflowFailure(
                  startedAt,
                  started,
                  pinnedScope,
                  stepResults,
                  stepResults.length - 1,
                  index,
                  outcome.status === "indeterminate"
                    ? "indeterminate"
                    : outcome.status,
                  outcome.reasons,
                ),
              );
            }
          } catch (error) {
            if (!(error instanceof NativeError)) throw error;
            const isWait = step.kind === "wait";
            const preDispatch = error.code === "target_not_found";
            const status = isWait
              ? "uncertain"
              : preDispatch
                ? "not_dispatched"
                : "indeterminate";
            const record = workflowStepResultSchema.parse({
              index,
              kind: step.kind,
              status,
              dispatchAttempted: !isWait && !preDispatch,
              durationMs: elapsedMs(stepStarted),
              reasons: [
                preDispatch ? "application_changed" : `native_${error.code}`,
              ],
            });
            stepResults.push(record);
            const activeScope = pinnedScope ?? null;
            return result(
              workflowFailure(
                startedAt,
                started,
                activeScope,
                stepResults,
                stepResults.length - 1,
                index,
                preDispatch
                  ? "not_dispatched"
                  : isWait
                    ? "uncertain"
                    : "indeterminate",
                record.reasons,
              ),
            );
          }
        }
        if (pinnedScope === undefined) {
          return result(
            uiWorkflowResultSchema.parse({
              schemaVersion: 1,
              outcome: "uncertain",
              startedAt,
              finishedAt: new Date().toISOString(),
              durationMs: elapsedMs(started),
              applicationMatchCount: 1,
              scope: null,
              completedStepCount: stepResults.length,
              stoppedAtStep: stepResults.length,
              steps: stepResults,
              reasons: ["workflow_no_native_observation"],
            }),
          );
        }
        return result(
          uiWorkflowResultSchema.parse({
            schemaVersion: 1,
            outcome: "verified",
            startedAt,
            finishedAt: new Date().toISOString(),
            durationMs: elapsedMs(started),
            applicationMatchCount: 1,
            scope: { application: pinnedScope },
            completedStepCount: stepResults.length,
            stoppedAtStep: null,
            steps: stepResults,
            reasons: [],
          }),
        );
      }),
  );
}
