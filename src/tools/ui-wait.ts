import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NativeBridge } from "../native/client.js";

import { NativeError } from "../native/protocol.js";
import {
  accessibilityWaitSchema,
  uiWaitInputSchema,
  uiWaitResultSchema,
  type UiWaitResult,
} from "../semantic/contracts.js";
import { applicationSchema } from "./discovery.js";
import { z } from "zod";

const applicationListResultSchema = z.object({
  applications: z.array(applicationSchema),
});

function toolResult(value: UiWaitResult) {
  return {
    structuredContent: value,
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function unresolvedApplicationResult(
  applicationMatchCount: number,
  reason:
    | "application_not_found"
    | "application_ambiguous"
    | "application_changed",
): UiWaitResult {
  const now = new Date().toISOString();
  return uiWaitResultSchema.parse({
    schemaVersion: 1,
    status: "uncertain",
    applicationMatchCount,
    scope: null,
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    pollCount: 0,
    observation: null,
    evaluations: [],
    reasons: [reason],
  });
}

export function registerUiWaitTool(
  server: McpServer,
  native: NativeBridge,
): void {
  server.registerTool(
    "ui_wait",
    {
      title: "Wait for semantic UI condition",
      description:
        "Wait locally for bounded macOS Accessibility element or application-window conditions, including appearance, disappearance, and unique boolean state. Supports one condition or a flat allOf/anyOf group without taking input, invoking vision, capturing the screen, or returning a full UI tree.",
      inputSchema: uiWaitInputSchema,
      outputSchema: uiWaitResultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ scope, condition, timeoutMs, pollIntervalMs }) => {
      const applicationList = applicationListResultSchema.parse(
        await native.request<unknown>("application.list", {
          includeBackground: true,
        }),
      );
      const applications = applicationList.applications.filter((application) =>
        "processId" in scope
          ? application.processId === scope.processId
          : application.bundleIdentifier === scope.bundleIdentifier,
      );
      if (applications.length === 0) {
        return toolResult(
          unresolvedApplicationResult(0, "application_not_found"),
        );
      }
      if (applications.length > 1) {
        return toolResult(
          unresolvedApplicationResult(
            applications.length,
            "application_ambiguous",
          ),
        );
      }

      const application = applications[0];
      if (application === undefined) {
        throw new Error("Resolved application disappeared before UI wait");
      }

      let wait: z.infer<typeof accessibilityWaitSchema>;
      try {
        wait = accessibilityWaitSchema.parse(
          await native.request<unknown>("accessibility.wait", {
            processId: application.processId,
            expectedBundleIdentifier: application.bundleIdentifier ?? undefined,
            contentPolicy: "redacted",
            condition,
            timeoutMs,
            pollIntervalMs,
          }),
        );
      } catch (error) {
        if (error instanceof NativeError && error.code === "target_not_found") {
          return toolResult(
            unresolvedApplicationResult(0, "application_changed"),
          );
        }
        throw error;
      }

      if (wait.application.processId !== application.processId) {
        return toolResult(
          unresolvedApplicationResult(0, "application_changed"),
        );
      }
      const observedBundleIdentifier =
        wait.application.bundleIdentifier || null;
      if (observedBundleIdentifier !== application.bundleIdentifier) {
        return toolResult(
          unresolvedApplicationResult(0, "application_changed"),
        );
      }

      return toolResult(
        uiWaitResultSchema.parse({
          schemaVersion: wait.schemaVersion,
          status: wait.status,
          applicationMatchCount: 1,
          scope: {
            application: {
              processId: wait.application.processId,
              processInstanceId: wait.application.processInstanceId,
              bundleIdentifier: observedBundleIdentifier,
              launchDate: wait.application.launchDate,
            },
          },
          startedAt: wait.startedAt,
          finishedAt: wait.finishedAt,
          durationMs: wait.durationMs,
          pollCount: wait.pollCount,
          observation: wait.observation,
          evaluations: wait.evaluations,
          reasons: wait.reasons,
        }),
      );
    },
  );
}
