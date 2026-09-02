import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NativeBridge } from "../native/client.js";

import { applicationSchema } from "./discovery.js";
import {
  accessibilityQuerySchema,
  uiQueryInputSchema,
  uiQueryResultSchema,
  type AccessibilityNode,
  type UiQueryResult,
} from "../semantic/contracts.js";
import { z } from "zod";

const applicationListResultSchema = z.object({
  applications: z.array(applicationSchema),
});

function toolResult(value: UiQueryResult) {
  return {
    structuredContent: value,
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function candidate(node: AccessibilityNode) {
  return {
    id: node.id,
    fingerprint: node.fingerprint,
    role: node.role,
    subrole: node.subrole,
    names: node.names,
    frame: node.frame,
    actions: node.actions,
    enabled: node.enabled,
    focused: node.focused,
    selected: node.selected,
    expanded: node.expanded,
    visible: node.visible,
  };
}

function unresolvedApplicationResult(
  status: "not_found" | "ambiguous",
  applicationMatchCount: number,
): UiQueryResult {
  return uiQueryResultSchema.parse({
    schemaVersion: 1,
    status,
    applicationMatchCount,
    scope: null,
    observation: null,
    matchCount: 0,
    candidates: [],
    candidatesTruncated: false,
    reasons: [
      status === "not_found"
        ? "application_not_found"
        : "application_ambiguous",
    ],
  });
}

export function registerUiQueryTool(
  server: McpServer,
  native: NativeBridge,
): void {
  server.registerTool(
    "ui_query",
    {
      title: "Query semantic UI",
      description:
        "Resolve exactly one running application and query its macOS Accessibility tree using bounded role, name, action, state, and ancestor constraints. Returns compact matched candidates and observation identity without taking input, invoking vision, capturing the screen, exposing values, or returning a full UI tree.",
      inputSchema: uiQueryInputSchema,
      outputSchema: uiQueryResultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ scope, target, maxCandidates }) => {
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
        return toolResult(unresolvedApplicationResult("not_found", 0));
      }
      if (applications.length > 1) {
        return toolResult(
          unresolvedApplicationResult("ambiguous", applications.length),
        );
      }

      const application = applications[0];
      if (application === undefined) {
        throw new Error("Resolved application disappeared before AX query");
      }

      const query = accessibilityQuerySchema.parse(
        await native.request<unknown>("accessibility.query", {
          processId: application.processId,
          expectedBundleIdentifier: application.bundleIdentifier ?? undefined,
          contentPolicy: "matched",
          predicate: target,
          maxMatches: maxCandidates,
        }),
      );
      if (query.application.processId !== application.processId) {
        throw new Error("AX query returned a different application process");
      }
      const observedBundleIdentifier =
        query.application.bundleIdentifier || null;
      if (observedBundleIdentifier !== application.bundleIdentifier) {
        throw new Error("AX query returned a different application bundle");
      }

      const candidates = query.matches.slice(0, maxCandidates).map(candidate);
      const candidatesTruncated =
        query.matchesTruncated || candidates.length < query.matchCount;
      const status = query.status === "incomplete" ? "uncertain" : query.status;
      const reasons = [
        ...query.completion.reasons,
        ...(candidatesTruncated ? ["candidate_limit"] : []),
      ];
      const result = uiQueryResultSchema.parse({
        schemaVersion: 1,
        status,
        applicationMatchCount: 1,
        scope: {
          application: {
            processId: application.processId,
            processInstanceId: query.application.processInstanceId,
            bundleIdentifier: observedBundleIdentifier,
            launchDate: query.application.launchDate,
          },
        },
        observation: {
          observationId: query.observationId,
          source: query.source,
          observedAtStart: query.observedAtStart,
          observedAtEnd: query.observedAtEnd,
          consistency: query.consistency,
          completion: query.completion,
          durationMs: query.metrics.durationMs,
        },
        matchCount: query.matchCount,
        candidates,
        candidatesTruncated,
        reasons,
      });
      return toolResult(result);
    },
  );
}
