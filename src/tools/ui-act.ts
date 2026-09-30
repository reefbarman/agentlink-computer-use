import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NativeBridge } from "../native/client.js";
import type { CoordinatedNativeBridge } from "../semantic/operation-coordinator.js";

import { consumeCaptureArtifact } from "../native/artifacts.js";
import { NativeError } from "../native/protocol.js";
import { screenToImage } from "../grounding/geometry.js";
import type { CaptureMapping, Rect } from "../grounding/types.js";
import type { CandidateVisionSelector } from "../semantic/lm-studio-candidate-selector.js";
import {
  accessibilityActSchema,
  accessibilityQuerySchema,
  uiActInputSchema,
  uiActResultSchema,
  type AccessibilityQuery,
  type AccessibilityNode,
  type UiAction,
  type UiActResult,
} from "../semantic/contracts.js";
import { captureMetadataSchema, helperStatusSchema } from "./capture.js";
import { applicationSchema, displaySchema } from "./discovery.js";
import { z } from "zod";

const applicationListResultSchema = z.object({
  applications: z.array(applicationSchema),
});
const displayListResultSchema = z.object({ displays: z.array(displaySchema) });
const maximumCandidateVisionEvidenceAgeMs = 30_000;

function toolResult(value: UiActResult) {
  return {
    structuredContent: value,
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    ...(value.outcome === "verified" ? {} : { isError: true as const }),
  };
}

function unresolvedApplicationResult(
  action: UiAction,
  applicationMatchCount: number,
  reason:
    | "application_not_found"
    | "application_ambiguous"
    | "application_changed",
): UiActResult {
  const now = new Date().toISOString();
  return uiActResultSchema.parse({
    schemaVersion: 1,
    outcome: "not_dispatched",
    phase: "pre_dispatch",
    action,
    dispatchAttempted: false,
    dispatchAcknowledged: false,
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    applicationMatchCount,
    scope: null,
    observation: null,
    target: null,
    preconditionEvaluations: [],
    postcondition: { status: "not_evaluated", pollCount: 0, evaluations: [] },
    journal: [],
    reasons: [reason],
  });
}

function preDispatchVisionResult(
  action: UiAction,
  application: z.infer<typeof applicationSchema>,
  query: AccessibilityQuery,
  reasons: string[],
): UiActResult {
  const now = new Date().toISOString();
  return uiActResultSchema.parse({
    schemaVersion: 1,
    outcome: "not_dispatched",
    phase: "pre_dispatch",
    action,
    dispatchAttempted: false,
    dispatchAcknowledged: false,
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    applicationMatchCount: 1,
    scope: {
      application: {
        processId: application.processId,
        processInstanceId: query.application.processInstanceId,
        bundleIdentifier: query.application.bundleIdentifier || null,
        launchDate: query.application.launchDate,
      },
    },
    observation: query,
    target: null,
    preconditionEvaluations: [],
    postcondition: { status: "not_evaluated", pollCount: 0, evaluations: [] },
    journal: [],
    reasons,
  });
}

function normaliseCandidateBox(
  frame: Rect,
  mapping: CaptureMapping,
): { xMin: number; yMin: number; xMax: number; yMax: number } | undefined {
  const topLeft = screenToImage({ x: frame.x, y: frame.y }, mapping);
  const bottomRight = screenToImage(
    { x: frame.x + frame.width, y: frame.y + frame.height },
    mapping,
  );
  const bounds = mapping.imageContentBounds;
  if (
    topLeft.x < bounds.x ||
    topLeft.y < bounds.y ||
    bottomRight.x > bounds.x + bounds.width ||
    bottomRight.y > bounds.y + bounds.height
  ) {
    return undefined;
  }
  const xMin = Math.floor(((topLeft.x - bounds.x) / bounds.width) * 1000);
  const yMin = Math.floor(((topLeft.y - bounds.y) / bounds.height) * 1000);
  const xMax = Math.min(
    999,
    Math.ceil(((bottomRight.x - bounds.x) / bounds.width) * 1000),
  );
  const yMax = Math.min(
    999,
    Math.ceil(((bottomRight.y - bounds.y) / bounds.height) * 1000),
  );
  if (xMin < 0 || yMin < 0 || xMin >= xMax || yMin >= yMax) {
    return undefined;
  }
  return { xMin, yMin, xMax, yMax };
}

function containsFrame(bounds: Rect, frame: Rect): boolean {
  return (
    frame.x >= bounds.x &&
    frame.y >= bounds.y &&
    frame.x + frame.width <= bounds.x + bounds.width &&
    frame.y + frame.height <= bounds.y + bounds.height
  );
}

async function queryCandidateVisionEvidence(
  native: NativeBridge,
  application: z.infer<typeof applicationSchema>,
  target: z.infer<typeof uiActInputSchema>["target"],
): Promise<AccessibilityQuery> {
  return accessibilityQuerySchema.parse(
    await native.request<unknown>("accessibility.query", {
      processId: application.processId,
      expectedBundleIdentifier: application.bundleIdentifier ?? undefined,
      contentPolicy: "matched",
      predicate: target,
      maxMatches: 32,
    }),
  );
}

function evidenceIsStale(observedAt: string): boolean {
  const age = Date.now() - Date.parse(observedAt);
  return (
    !Number.isFinite(age) ||
    age < 0 ||
    age > maximumCandidateVisionEvidenceAgeMs
  );
}

async function selectCandidateWithVision(
  native: NativeBridge,
  selector: CandidateVisionSelector | undefined,
  application: z.infer<typeof applicationSchema>,
  target: z.infer<typeof uiActInputSchema>["target"],
  description: string,
): Promise<
  | { query: AccessibilityQuery; selectedFingerprint: string }
  | { query: AccessibilityQuery; reasons: string[] }
> {
  const query = await queryCandidateVisionEvidence(native, application, target);
  if (query.completion.status !== "complete") {
    return { query, reasons: ["candidate_vision_ax_incomplete"] };
  }
  if (query.status === "found") return { query, selectedFingerprint: "" };
  if (query.status !== "ambiguous") {
    return { query, reasons: ["candidate_vision_not_applicable"] };
  }
  if (query.matchesTruncated || query.matches.length !== query.matchCount) {
    return { query, reasons: ["candidate_vision_candidates_truncated"] };
  }
  if (selector === undefined) {
    return { query, reasons: ["candidate_vision_unavailable"] };
  }
  const candidates = query.matches.filter(
    (node) => node.enabled !== false && node.frame !== null,
  );
  if (candidates.length !== query.matches.length) {
    return { query, reasons: ["candidate_vision_invalid_ax_candidate"] };
  }
  const readinessFailure = await selector.checkSelectionReadiness?.();
  if (readinessFailure) {
    return {
      query,
      reasons: [
        "candidate_vision_unavailable",
        `candidate_vision_${readinessFailure}`,
      ],
    };
  }
  const displays = displayListResultSchema.parse(
    await native.request<unknown>("display.list"),
  ).displays;
  const display = displays.find((candidate) =>
    candidates.every((node) =>
      containsFrame(candidate.bounds, node.frame as Rect),
    ),
  );
  if (display === undefined) {
    return { query, reasons: ["candidate_vision_capture_scope_unavailable"] };
  }
  try {
    const status = helperStatusSchema.parse(
      await native.request<unknown>("health"),
    );
    const artifact = await native.request<unknown>("screen.capture", {
      target: { kind: "display", displayId: display.displayId },
      format: "jpeg",
      scale: "logical",
      includeCursor: false,
    });
    const capture = await consumeCaptureArtifact(artifact, status.artifactRoot);
    const metadata = captureMetadataSchema.parse(capture.metadata);
    if (
      evidenceIsStale(query.observedAtEnd) ||
      evidenceIsStale(metadata.capturedAt)
    ) {
      return { query, reasons: ["candidate_vision_evidence_stale"] };
    }
    const selectorCandidates = candidates.map((node) => {
      const normalizedBox = normaliseCandidateBox(
        node.frame as Rect,
        metadata.mapping,
      );
      if (normalizedBox === undefined) {
        throw new Error("candidate frame was outside the selected capture");
      }
      return {
        id: node.id,
        role: node.role,
        names: node.names,
        normalizedBox,
      };
    });
    const selection = await selector.select({
      targetDescription: description,
      candidates: selectorCandidates,
      image: {
        base64: capture.data,
        mimeType: metadata.mimeType,
        size: metadata.outputPixelSize,
        capturedAt: metadata.capturedAt,
      },
    });
    if (
      !selection.clickEligible ||
      selection.status !== "found" ||
      selection.selectedAxCandidateIds.length !== 1
    ) {
      return {
        query,
        reasons: [
          `candidate_vision_${selection.status}`,
          ...selection.rejectionReasons.map(
            (reason) => `candidate_vision_${reason}`,
          ),
        ],
      };
    }
    const selected = candidates.find(
      (node) => node.id === selection.selectedAxCandidateIds[0],
    );
    if (selected === undefined || selected.fingerprint === undefined) {
      return { query, reasons: ["candidate_vision_selection_invalid"] };
    }
    if (evidenceIsStale(metadata.capturedAt)) {
      return { query, reasons: ["candidate_vision_evidence_stale"] };
    }
    const refreshed = await queryCandidateVisionEvidence(
      native,
      application,
      target,
    );
    if (
      refreshed.completion.status !== "complete" ||
      refreshed.status !== "ambiguous" ||
      refreshed.matchesTruncated ||
      refreshed.matches.length !== refreshed.matchCount ||
      evidenceIsStale(refreshed.observedAtEnd)
    ) {
      return {
        query: refreshed,
        reasons: ["candidate_vision_evidence_changed"],
      };
    }
    const refreshedFingerprints = refreshed.matches
      .map(({ fingerprint }) => fingerprint)
      .sort();
    const originalFingerprints = candidates
      .map(({ fingerprint }) => fingerprint)
      .sort();
    if (
      refreshedFingerprints.length !== originalFingerprints.length ||
      refreshedFingerprints.some(
        (fingerprint, index) => fingerprint !== originalFingerprints[index],
      )
    ) {
      return {
        query: refreshed,
        reasons: ["candidate_vision_evidence_changed"],
      };
    }
    return { query: refreshed, selectedFingerprint: selected.fingerprint };
  } catch {
    return { query, reasons: ["candidate_vision_capture_failed"] };
  }
}

function indeterminateResult(
  action: UiAction,
  startedAt: string,
  reason: string,
): UiActResult {
  return uiActResultSchema.parse({
    schemaVersion: 1,
    outcome: "indeterminate",
    phase: "dispatch_attempted",
    action,
    dispatchAttempted: true,
    dispatchAcknowledged: false,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: 0,
    applicationMatchCount: 1,
    scope: null,
    observation: null,
    target: null,
    preconditionEvaluations: [],
    postcondition: { status: "uncertain", pollCount: 0, evaluations: [] },
    journal: [],
    reasons: [reason],
  });
}

export function registerUiActTool(
  server: McpServer,
  native: CoordinatedNativeBridge,
  candidateVisionSelector?: CandidateVisionSelector,
): void {
  server.registerTool(
    "ui_act",
    {
      title: "Perform verified semantic UI action",
      description:
        "Resolve one macOS Accessibility control, perform a single allowlisted AX action, and verify a typed postcondition inside one native transaction. AX-only is the default; explicit candidate_vision may use a fresh screenshot to select only among complete, non-truncated AX candidates, otherwise it abstains. Never retries after dispatch or falls back to physical input.",
      inputSchema: uiActInputSchema,
      outputSchema: uiActResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({
      scope,
      target,
      action,
      expectedTargetFingerprint,
      fallback,
      visionTargetDescription,
      precondition,
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
            unresolvedApplicationResult(action, 0, "application_not_found"),
          );
        }
        if (applications.length > 1) {
          return toolResult(
            unresolvedApplicationResult(
              action,
              applications.length,
              "application_ambiguous",
            ),
          );
        }

        const application = applications[0];
        if (application === undefined) {
          throw new Error("Resolved application disappeared before UI action");
        }

        let selectedTargetFingerprint: string | undefined;
        if (fallback === "candidate_vision") {
          const selection = await selectCandidateWithVision(
            native,
            candidateVisionSelector,
            application,
            target,
            visionTargetDescription!,
          );
          if ("reasons" in selection) {
            return toolResult(
              preDispatchVisionResult(
                action,
                application,
                selection.query,
                selection.reasons,
              ),
            );
          }
          if (selection.selectedFingerprint) {
            selectedTargetFingerprint = selection.selectedFingerprint;
          }
        }

        let act: z.infer<typeof accessibilityActSchema>;
        try {
          act = accessibilityActSchema.parse(
            await native.request<unknown>("accessibility.act", {
              processId: application.processId,
              expectedBundleIdentifier:
                application.bundleIdentifier ?? undefined,
              contentPolicy: "redacted",
              target,
              action,
              ...(expectedTargetFingerprint === undefined
                ? {}
                : { expectedTargetFingerprint }),
              ...(selectedTargetFingerprint === undefined
                ? {}
                : { selectedTargetFingerprint }),
              ...(precondition === undefined ? {} : { precondition }),
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
              unresolvedApplicationResult(action, 0, "application_changed"),
            );
          }
          // The transaction request already entered the helper, so a timeout or
          // helper loss cannot prove the action was never dispatched.
          if (
            error instanceof NativeError &&
            (error.code === "timeout" || error.code === "native_unavailable")
          ) {
            return toolResult(
              indeterminateResult(action, startedAt, `native_${error.code}`),
            );
          }
          throw error;
        }

        if (
          act.application === null ||
          act.application.processId !== application.processId ||
          (act.application.bundleIdentifier || null) !==
            application.bundleIdentifier
        ) {
          return toolResult(
            unresolvedApplicationResult(action, 0, "application_changed"),
          );
        }

        return toolResult(
          uiActResultSchema.parse({
            schemaVersion: act.schemaVersion,
            outcome: act.outcome,
            phase: act.phase,
            action: act.action,
            dispatchAttempted: act.dispatchAttempted,
            dispatchAcknowledged: act.dispatchAcknowledged,
            startedAt: act.startedAt,
            finishedAt: act.finishedAt,
            durationMs: act.durationMs,
            applicationMatchCount: 1,
            scope: {
              application: {
                processId: act.application.processId,
                processInstanceId: act.application.processInstanceId,
                bundleIdentifier: act.application.bundleIdentifier || null,
                launchDate: act.application.launchDate,
              },
            },
            observation: act.observation,
            target: act.target,
            preconditionEvaluations: act.preconditionEvaluations,
            postcondition: act.postcondition,
            journal: act.journal,
            reasons: act.reasons,
          }),
        );
      }),
  );
}
