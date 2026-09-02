import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NativeBridge } from "../native/client.js";
import type { CoordinatedNativeBridge } from "../semantic/operation-coordinator.js";

import { NativeError } from "../native/protocol.js";
import {
  accessibilityFillSchema,
  uiFillInputSchema,
  uiFillResultSchema,
  type UiFillResult,
} from "../semantic/contracts.js";
import { applicationSchema } from "./discovery.js";
import { z } from "zod";

const applicationListResultSchema = z.object({
  applications: z.array(applicationSchema),
});

function toolResult(value: UiFillResult) {
  return {
    structuredContent: value,
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    ...(value.outcome === "verified" ? {} : { isError: true as const }),
  };
}

function unresolvedApplicationResult(
  fieldCount: number,
  applicationMatchCount: number,
  reason:
    | "application_not_found"
    | "application_ambiguous"
    | "application_changed",
): UiFillResult {
  const now = new Date().toISOString();
  return uiFillResultSchema.parse({
    schemaVersion: 1,
    outcome: "not_dispatched",
    phase: "pre_dispatch",
    dispatchAttempted: false,
    dispatchAcknowledged: false,
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    applicationMatchCount,
    scope: null,
    observation: null,
    fields: Array.from({ length: fieldCount }, (_, index) => ({
      index,
      target: null,
      valueStatus: "not_evaluated",
      reason: null,
    })),
    postcondition: { status: "not_evaluated", pollCount: 0, evaluations: [] },
    journal: [],
    reasons: [reason],
  });
}

function indeterminateResult(
  fieldCount: number,
  startedAt: string,
  reason: string,
): UiFillResult {
  return uiFillResultSchema.parse({
    schemaVersion: 1,
    outcome: "indeterminate",
    phase: "dispatch_attempted",
    dispatchAttempted: true,
    dispatchAcknowledged: false,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: 0,
    applicationMatchCount: 1,
    scope: null,
    observation: null,
    fields: Array.from({ length: fieldCount }, (_, index) => ({
      index,
      target: null,
      valueStatus: "uncertain",
      reason: "native_unavailable",
    })),
    postcondition: { status: "uncertain", pollCount: 0, evaluations: [] },
    journal: [],
    reasons: [reason],
  });
}

export function registerUiFillTool(
  server: McpServer,
  native: CoordinatedNativeBridge,
): void {
  server.registerTool(
    "ui_fill",
    {
      title: "Fill verified semantic fields",
      description:
        "Resolve one application and fill 1 through 8 distinct, enabled non-secure macOS Accessibility string fields in a single native transaction. AX value assignment is the only supported method: no keyboard, clipboard, physical input, vision, or automatic retry fallback. Field values are never returned; every written value and a required semantic postcondition must verify.",
      inputSchema: uiFillInputSchema,
      outputSchema: uiFillResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({
      scope,
      fields,
      postcondition,
      verificationTimeoutMs,
      pollIntervalMs,
    }) =>
      native.runExclusive(async () => {
        const startedAt = new Date().toISOString();
        const applicationList = applicationListResultSchema.parse(
          await native.request<unknown>("application.list", {
            includeBackground: true,
          }),
        );
        const applications = applicationList.applications.filter(
          (application) =>
            "processId" in scope
              ? application.processId === scope.processId
              : application.bundleIdentifier === scope.bundleIdentifier,
        );
        if (applications.length === 0) {
          return toolResult(
            unresolvedApplicationResult(
              fields.length,
              0,
              "application_not_found",
            ),
          );
        }
        if (applications.length > 1) {
          return toolResult(
            unresolvedApplicationResult(
              fields.length,
              applications.length,
              "application_ambiguous",
            ),
          );
        }
        const application = applications[0];
        if (application === undefined) {
          throw new Error("Resolved application disappeared before UI fill");
        }

        let fill: z.infer<typeof accessibilityFillSchema>;
        try {
          fill = accessibilityFillSchema.parse(
            await native.request<unknown>("accessibility.fill", {
              processId: application.processId,
              expectedBundleIdentifier:
                application.bundleIdentifier ?? undefined,
              contentPolicy: "redacted",
              fields,
              postcondition,
              verificationTimeoutMs,
              pollIntervalMs,
            }),
          );
        } catch (error) {
          if (
            error instanceof NativeError &&
            error.code === "target_not_found"
          ) {
            return toolResult(
              unresolvedApplicationResult(
                fields.length,
                0,
                "application_changed",
              ),
            );
          }
          if (
            error instanceof NativeError &&
            (error.code === "timeout" || error.code === "native_unavailable")
          ) {
            return toolResult(
              indeterminateResult(
                fields.length,
                startedAt,
                `native_${error.code}`,
              ),
            );
          }
          throw error;
        }

        if (
          fill.application === null ||
          fill.application.processId !== application.processId ||
          (fill.application.bundleIdentifier || null) !==
            application.bundleIdentifier
        ) {
          if (!fill.dispatchAttempted) {
            return toolResult(
              unresolvedApplicationResult(
                fields.length,
                0,
                "application_changed",
              ),
            );
          }
          return toolResult(
            uiFillResultSchema.parse({
              schemaVersion: fill.schemaVersion,
              outcome: "indeterminate",
              phase: fill.phase,
              dispatchAttempted: true,
              dispatchAcknowledged: fill.dispatchAcknowledged,
              startedAt: fill.startedAt,
              finishedAt: fill.finishedAt,
              durationMs: fill.durationMs,
              applicationMatchCount: 1,
              scope: null,
              observation: null,
              fields: fill.fields,
              postcondition: fill.postcondition,
              journal: fill.journal,
              reasons: ["application_changed"],
            }),
          );
        }

        return toolResult(
          uiFillResultSchema.parse({
            schemaVersion: fill.schemaVersion,
            outcome: fill.outcome,
            phase: fill.phase,
            dispatchAttempted: fill.dispatchAttempted,
            dispatchAcknowledged: fill.dispatchAcknowledged,
            startedAt: fill.startedAt,
            finishedAt: fill.finishedAt,
            durationMs: fill.durationMs,
            applicationMatchCount: 1,
            scope: {
              application: {
                processId: fill.application.processId,
                processInstanceId: fill.application.processInstanceId,
                bundleIdentifier: fill.application.bundleIdentifier || null,
                launchDate: fill.application.launchDate,
              },
            },
            observation: fill.observation,
            fields: fill.fields,
            postcondition: fill.postcondition,
            journal: fill.journal,
            reasons: fill.reasons,
          }),
        );
      }),
  );
}
