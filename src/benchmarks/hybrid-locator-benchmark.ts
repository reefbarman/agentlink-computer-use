#!/usr/bin/env node

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";

import {
  accessibilityQuerySchema,
  type AccessibilityPredicate,
  type AccessibilityQuery,
} from "./ax-discovery-types.js";
import {
  createQwen3VlSelectorAdapter,
  evaluateCandidateSelections,
  type CandidateSelection,
  type SelectorCandidate,
} from "../grounding/adapters/qwen3-vl-selector.js";
import { qwen3VlCandidateAdapters } from "../grounding/adapters/qwen3-vl-candidates.js";
import {
  deriveGroundingStatus,
  evaluateGroundingConfidence,
  type CandidateView,
} from "../grounding/confidence.js";
import { containsPoint } from "../grounding/geometry.js";
import {
  decideHybridLocator,
  type HybridLocatorDecision,
  type HybridLocatorInput,
} from "../grounding/hybrid-locator.js";
import { LmStudioClient } from "../grounding/lm-studio-client.js";
import { rectSchema, type Rect } from "../grounding/types.js";
import { consumeCaptureArtifact } from "../native/artifacts.js";
import { NativeClient } from "../native/client.js";
import { captureMetadataSchema, helperStatusSchema } from "../tools/capture.js";
import { z } from "zod";

const expectedStatusSchema = z.enum(["found", "not_found", "ambiguous"]);
const readyManifestSchema = z.object({
  type: z.literal("ready"),
  processId: z.number().int().positive(),
  window: z.object({ title: z.string().min(1), bounds: rectSchema }),
  cases: z.array(
    z.object({
      id: z.string().min(1),
      suite: z.enum(["scored", "calibration"]),
      query: z.string().min(1),
      expectedStatus: expectedStatusSchema,
      targetBounds: rectSchema.optional(),
    }),
  ),
});

type ReadyManifest = z.infer<typeof readyManifestSchema>;
type FixtureCase = ReadyManifest["cases"][number];
type ExpectedStatus = z.infer<typeof expectedStatusSchema>;

interface Options {
  outputPath: string;
  nativePath: string;
  targetPath: string;
  baseUrl: string;
  model?: string;
}

interface TargetProcess {
  child: ChildProcessWithoutNullStreams;
  lines: Interface;
  manifest: ReadyManifest;
}

interface CapturedImage {
  requestedWidth: number;
  metadata: z.infer<typeof captureMetadataSchema>;
  base64: string;
}

type Strategy = "ax_direct" | "candidate_selector" | "open_vision";

interface CaseSpec {
  id: string;
  strategy: Strategy;
  predicate: AccessibilityPredicate;
  expectedMode?: HybridLocatorDecision["mode"];
}

interface CaseResult {
  caseId: string;
  query: string;
  strategy: Strategy;
  expectedStatus: ExpectedStatus;
  actualStatus: HybridLocatorDecision["status"];
  mode: HybridLocatorDecision["mode"];
  clickEligible: boolean;
  passed: boolean;
  pointInExpectedTarget: boolean | null;
  score: number;
  selectedAxCandidateId: string | null;
  rejectionReasons: string[];
  ax: {
    status: AccessibilityQuery["status"];
    durationMs: number;
    matchCount: number;
    completionStatus: AccessibilityQuery["completion"]["status"];
  };
  vision: {
    calls: number;
    durationMs: number;
    status: string;
    evidenceScore: number | null;
  };
  totalDurationMs: number;
}

const limits = {
  deadlineMs: 1_500,
  messageTimeoutMs: 100,
  maxDepth: 12,
  maxNodes: 1_000,
  maxChildren: 100,
  maxStringLength: 512,
  maxResultBytes: 1_048_576,
};

const caseSpecs: CaseSpec[] = [
  {
    id: "submit-large",
    strategy: "ax_direct",
    predicate: {
      roles: ["AXButton"],
      name: "Submit",
      nameMatch: "exact",
      requiredActions: ["AXPress"],
      enabled: true,
    },
    expectedMode: "ax_action",
  },
  {
    id: "settings-gear-small",
    strategy: "ax_direct",
    predicate: {
      roles: ["AXButton"],
      name: "Settings",
      nameMatch: "exact",
      requiredActions: ["AXPress"],
      enabled: true,
    },
    expectedMode: "ax_action",
  },
  {
    id: "enable-cloud-sync-checkbox",
    strategy: "ax_direct",
    predicate: {
      roles: ["AXCheckBox"],
      name: "Enable cloud sync",
      nameMatch: "exact",
      requiredActions: ["AXPress"],
      enabled: true,
    },
    expectedMode: "ax_action",
  },
  {
    id: "prompt-injection-continue-safely",
    strategy: "ax_direct",
    predicate: {
      roles: ["AXButton"],
      name: "Continue Safely",
      nameMatch: "exact",
      requiredActions: ["AXPress"],
      enabled: true,
    },
    expectedMode: "ax_action",
  },
  {
    id: "account-email-field",
    strategy: "candidate_selector",
    predicate: { name: "name@example.com", nameMatch: "exact" },
  },
  {
    id: "save-project-alpha",
    strategy: "candidate_selector",
    predicate: {
      roles: ["AXButton"],
      name: "Save",
      nameMatch: "exact",
      requiredActions: ["AXPress"],
      enabled: true,
    },
    expectedMode: "candidate_constrained",
  },
  {
    id: "save-project-beta",
    strategy: "candidate_selector",
    predicate: {
      roles: ["AXButton"],
      name: "Save",
      nameMatch: "exact",
      requiredActions: ["AXPress"],
      enabled: true,
    },
    expectedMode: "candidate_constrained",
  },
  {
    id: "save-unlabeled-ambiguous",
    strategy: "candidate_selector",
    predicate: {
      roles: ["AXButton"],
      name: "Save",
      nameMatch: "exact",
      requiredActions: ["AXPress"],
      enabled: true,
    },
  },
  {
    id: "save-unspecified-ambiguous",
    strategy: "candidate_selector",
    predicate: {
      roles: ["AXButton"],
      name: "Save",
      nameMatch: "exact",
      requiredActions: ["AXPress"],
      enabled: true,
    },
  },
  {
    id: "delete-account-absent",
    strategy: "open_vision",
    predicate: {
      roles: ["AXButton"],
      name: "Delete Account",
      nameMatch: "exact",
    },
  },
  {
    id: "calibration-center",
    strategy: "open_vision",
    predicate: { name: "CENTER TARGET", nameMatch: "exact" },
    expectedMode: "visual_point",
  },
  {
    id: "calibration-corner",
    strategy: "open_vision",
    predicate: { name: "CORNER TARGET", nameMatch: "exact" },
    expectedMode: "visual_point",
  },
];

function parseOptions(argv: string[]): Options {
  const options: Options = {
    outputPath: resolve(
      "benchmark-results",
      `hybrid-locator-${new Date().toISOString().replaceAll(":", "-")}.json`,
    ),
    nativePath: resolve(
      process.env.COMPUTER_USE_NATIVE_PATH ??
        "native/.build/release/ComputerUseNative",
    ),
    targetPath: resolve(
      process.env.GROUNDING_TARGET_PATH ??
        "native/.build/release/GroundingTestTarget",
    ),
    baseUrl: process.env.LM_STUDIO_BASE_URL ?? "http://127.0.0.1:1234/v1",
    ...(process.env.LM_STUDIO_MODEL === undefined
      ? {}
      : { model: process.env.LM_STUDIO_MODEL }),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if (flag === "--output") {
      if (next === undefined) throw new Error("--output requires a value");
      options.outputPath = resolve(next);
      index += 1;
    } else {
      throw new Error(`Unknown argument '${flag}'`);
    }
  }
  return options;
}

async function startTarget(executablePath: string): Promise<TargetProcess> {
  const child = spawn(executablePath, [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GROUNDING_TARGET_PASSIVE: "1" },
  });
  const lines = createInterface({ input: child.stdout });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  try {
    const manifest = await new Promise<ReadyManifest>(
      (resolveReady, rejectReady) => {
        const timeout = setTimeout(
          () => rejectReady(new Error("Grounding target timed out")),
          10_000,
        );
        const finish = (callback: () => void) => {
          clearTimeout(timeout);
          callback();
        };
        lines.once("line", (line) => {
          try {
            finish(() =>
              resolveReady(readyManifestSchema.parse(JSON.parse(line))),
            );
          } catch (error) {
            finish(() =>
              rejectReady(
                error instanceof Error ? error : new Error(String(error)),
              ),
            );
          }
        });
        child.once("error", (error) => finish(() => rejectReady(error)));
        child.once("exit", (code, signal) =>
          finish(() =>
            rejectReady(
              new Error(
                `Grounding target exited before readiness (${signal ?? code})`,
              ),
            ),
          ),
        );
      },
    );
    return { child, lines, manifest };
  } catch (error) {
    lines.close();
    if (child.exitCode === null) child.kill("SIGKILL");
    throw error;
  }
}

async function stopTarget(target: TargetProcess | undefined): Promise<void> {
  if (target === undefined) return;
  target.lines.close();
  if (target.child.exitCode !== null) return;
  target.child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolveExit) =>
      target.child.once("exit", () => resolveExit()),
    ),
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
  ]);
  if (target.child.exitCode === null) target.child.kill("SIGKILL");
}

async function capture(
  native: NativeClient,
  artifactRoot: string,
  bounds: Rect,
  requestedWidth: number,
): Promise<CapturedImage> {
  const artifact = await native.request<unknown>("screen.capture", {
    target: { kind: "region", bounds },
    format: "png",
    scale: 4,
    maxWidth: requestedWidth,
    includeCursor: false,
  });
  const consumed = await consumeCaptureArtifact(artifact, artifactRoot);
  return {
    requestedWidth,
    metadata: captureMetadataSchema.parse(consumed.metadata),
    base64: consumed.data,
  };
}

function fixtureCase(manifest: ReadyManifest, id: string): FixtureCase {
  const value = manifest.cases.find((candidate) => candidate.id === id);
  if (value === undefined) throw new Error(`Fixture case '${id}' is missing`);
  return value;
}

function axEvidence(query: AccessibilityQuery): HybridLocatorInput["ax"] {
  return {
    status: query.status,
    observationId: query.observationId,
    processId: query.application.processId,
    launchDate: query.application.launchDate,
    observedAtEnd: query.observedAtEnd,
    candidates: query.matches.map(({ id, frame, actions, enabled }) => ({
      id,
      frame,
      actions,
      enabled,
    })),
  };
}

function normalizeFrame(
  frame: Rect,
  captureValue: CapturedImage,
): SelectorCandidate["normalizedBox"] {
  const bounds = captureValue.metadata.mapping.screenBounds;
  const normalize = (value: number, origin: number, extent: number) =>
    Math.max(0, Math.min(999, Math.round(((value - origin) / extent) * 999)));
  const xMin = normalize(frame.x, bounds.x, bounds.width);
  const yMin = normalize(frame.y, bounds.y, bounds.height);
  const xMax = normalize(frame.x + frame.width, bounds.x, bounds.width);
  const yMax = normalize(frame.y + frame.height, bounds.y, bounds.height);
  if (xMin >= xMax || yMin >= yMax) {
    throw new Error("AX candidate frame collapsed after normalization");
  }
  return { xMin, yMin, xMax, yMax };
}

function selectorCandidates(
  query: AccessibilityQuery,
  captureValue: CapturedImage,
): SelectorCandidate[] {
  return query.matches.flatMap((node) =>
    node.frame === null
      ? []
      : [
          {
            id: node.id,
            role: node.role,
            names: node.names,
            normalizedBox: normalizeFrame(node.frame, captureValue),
          },
        ],
  );
}

async function selectorVision(
  client: LmStudioClient,
  model: string,
  captureValue: CapturedImage,
  queryText: string,
  candidates: SelectorCandidate[],
): Promise<{
  evidence: NonNullable<HybridLocatorInput["vision"]>;
  calls: number;
  durationMs: number;
}> {
  const startedAt = performance.now();
  const selections: CandidateSelection[] = [];
  for (const variant of ["semantic", "visual-check"] as const) {
    const adapter = createQwen3VlSelectorAdapter(candidates, variant);
    const prediction = await client.ground(
      adapter,
      model,
      queryText,
      { base64: captureValue.base64, mimeType: captureValue.metadata.mimeType },
      captureValue.metadata.outputPixelSize,
    );
    selections.push(prediction.result);
  }
  const confidence = evaluateCandidateSelections(selections, 2);
  return {
    evidence: {
      status: confidence.status,
      clickEligible: confidence.clickEligible,
      evidenceScore: null,
      viewCount: confidence.responseCount,
      expectedViewCount: confidence.expectedResponseCount,
      captureObservedAt: captureValue.metadata.capturedAt,
      candidate: null,
      selectedAxCandidateIds: confidence.selectedIds,
    },
    calls: selections.length,
    durationMs: performance.now() - startedAt,
  };
}

async function openVision(
  client: LmStudioClient,
  model: string,
  captures: CapturedImage[],
  queryText: string,
): Promise<{
  evidence: NonNullable<HybridLocatorInput["vision"]>;
  calls: number;
  durationMs: number;
}> {
  const startedAt = performance.now();
  const views: CandidateView[] = [];
  for (const captureValue of captures) {
    for (const adapter of qwen3VlCandidateAdapters) {
      const prediction = await client.ground(
        adapter,
        model,
        queryText,
        {
          base64: captureValue.base64,
          mimeType: captureValue.metadata.mimeType,
        },
        captureValue.metadata.outputPixelSize,
      );
      views.push({
        adapterId: adapter.id,
        requestedWidth: captureValue.requestedWidth,
        imageSize: captureValue.metadata.outputPixelSize,
        mapping: captureValue.metadata.mapping,
        coordinateDenominator: adapter.coordinateDenominator,
        candidates: prediction.result.candidates,
      });
    }
  }
  const confidence = evaluateGroundingConfidence(views, captures.length * 2);
  return {
    evidence: {
      status: deriveGroundingStatus(confidence),
      clickEligible: confidence.clickEligible,
      evidenceScore: confidence.evidenceScore,
      viewCount: confidence.viewCount,
      expectedViewCount: confidence.expectedViewCount,
      captureObservedAt: captures
        .map(({ metadata }) => metadata.capturedAt)
        .sort()[0],
      candidate:
        confidence.agreedPoint === null || confidence.agreedBox === null
          ? null
          : { point: confidence.agreedPoint, box: confidence.agreedBox },
      geometryValidated: confidence.clickEligible,
    },
    calls: views.length,
    durationMs: performance.now() - startedAt,
  };
}

function scoreCase(
  fixture: FixtureCase,
  spec: CaseSpec,
  decision: HybridLocatorDecision,
): { passed: boolean; pointInExpectedTarget: boolean | null } {
  const pointInExpectedTarget =
    fixture.targetBounds === undefined || decision.point === null
      ? null
      : containsPoint(fixture.targetBounds, decision.point);
  const statusPasses = decision.status === fixture.expectedStatus;
  const safeNegative =
    fixture.expectedStatus === "found" || decision.clickEligible === false;
  const foundPasses =
    fixture.expectedStatus !== "found" ||
    (decision.clickEligible && pointInExpectedTarget === true);
  const modePasses =
    spec.expectedMode === undefined || decision.mode === spec.expectedMode;
  return {
    passed: statusPasses && safeNegative && foundPasses && modePasses,
    pointInExpectedTarget,
  };
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const lmStudio = new LmStudioClient({
    baseUrl: options.baseUrl,
    ...(options.model === undefined ? {} : { model: options.model }),
  });
  const probeAdapter = createQwen3VlSelectorAdapter(
    [
      {
        id: "probe",
        role: "AXButton",
        names: ["Probe"],
        normalizedBox: { xMin: 1, yMin: 1, xMax: 2, yMax: 2 },
      },
    ],
    "semantic",
  );
  const model = await lmStudio.selectModel(probeAdapter);
  let target: TargetProcess | undefined;
  let native: NativeClient | undefined;
  const results: CaseResult[] = [];

  try {
    target = await startTarget(options.targetPath);
    native = new NativeClient({ executablePath: options.nativePath });
    const status = helperStatusSchema.parse(await native.request("health"));
    const freshCapture = (width: number) =>
      capture(
        native!,
        status.artifactRoot,
        target!.manifest.window.bounds,
        width,
      );

    for (const spec of caseSpecs) {
      const fixture = fixtureCase(target.manifest, spec.id);
      process.stderr.write(`Hybrid ${spec.strategy} ${spec.id}\n`);
      const startedAt = performance.now();
      const axStartedAt = performance.now();
      const query = accessibilityQuerySchema.parse(
        await native.request("accessibility.query", {
          processId: target.manifest.processId,
          contentPolicy: "fixture",
          predicate: spec.predicate,
          limits,
        }),
      );
      const axDurationMs = performance.now() - axStartedAt;
      let vision:
        | Awaited<ReturnType<typeof selectorVision>>
        | Awaited<ReturnType<typeof openVision>>
        | undefined;

      if (spec.strategy === "candidate_selector") {
        const captureValue = await freshCapture(1024);
        const candidates = selectorCandidates(query, captureValue);
        if (candidates.length > 0) {
          vision = await selectorVision(
            lmStudio,
            model,
            captureValue,
            fixture.query,
            candidates,
          );
        }
      } else if (spec.strategy === "open_vision") {
        const widths =
          fixture.expectedStatus === "not_found" ? [1024] : [768, 1024];
        const captureValues: CapturedImage[] = [];
        for (const width of widths)
          captureValues.push(await freshCapture(width));
        vision = await openVision(
          lmStudio,
          model,
          captureValues,
          fixture.query,
        );
      }

      const evaluatedAt = new Date().toISOString();
      const decision = decideHybridLocator({
        evaluatedAt,
        maximumEvidenceAgeMs: 30_000,
        target: {
          processId: query.application.processId,
          launchDate: query.application.launchDate,
        },
        requiredAction: "AXPress",
        ax: axEvidence(query),
        ...(vision === undefined ? {} : { vision: vision.evidence }),
      });
      const scored = scoreCase(fixture, spec, decision);
      results.push({
        caseId: fixture.id,
        query: fixture.query,
        strategy: spec.strategy,
        expectedStatus: fixture.expectedStatus,
        actualStatus: decision.status,
        mode: decision.mode,
        clickEligible: decision.clickEligible,
        passed: scored.passed,
        pointInExpectedTarget: scored.pointInExpectedTarget,
        score: decision.score,
        selectedAxCandidateId: decision.selectedAxCandidateId,
        rejectionReasons: decision.rejectionReasons,
        ax: {
          status: query.status,
          durationMs: axDurationMs,
          matchCount: query.matchCount,
          completionStatus: query.completion.status,
        },
        vision: {
          calls: vision?.calls ?? 0,
          durationMs: vision?.durationMs ?? 0,
          status: vision?.evidence.status ?? "not_run",
          evidenceScore: vision?.evidence.evidenceScore ?? null,
        },
        totalDurationMs: performance.now() - startedAt,
      });
    }

    const aggregate = {
      total: results.length,
      passed: results.filter(({ passed }) => passed).length,
      unsafeFalsePositives: results.filter(
        ({ expectedStatus, clickEligible }) =>
          expectedStatus !== "found" && clickEligible,
      ).length,
      clickEligible: results.filter(({ clickEligible }) => clickEligible)
        .length,
      modelCalls: results.reduce(
        (total, result) => total + result.vision.calls,
        0,
      ),
      routes: Object.fromEntries(
        (["ax_direct", "candidate_selector", "open_vision"] as const).map(
          (strategy) => {
            const group = results.filter(
              (result) => result.strategy === strategy,
            );
            return [
              strategy,
              {
                total: group.length,
                passed: group.filter(({ passed }) => passed).length,
                modelCalls: group.reduce(
                  (total, result) => total + result.vision.calls,
                  0,
                ),
                meanDurationMs:
                  group.reduce(
                    (total, result) => total + result.totalDurationMs,
                    0,
                  ) / Math.max(1, group.length),
              },
            ];
          },
        ),
      ),
    };
    await writeJsonAtomic(options.outputPath, {
      schemaVersion: 1,
      benchmark: "hybrid-locator-spike",
      generatedAt: new Date().toISOString(),
      safety: {
        readOnly: true,
        inputEventsSent: 0,
        axActionsPerformed: 0,
        mcpToolsRegistered: 0,
      },
      environment: {
        platform: platform(),
        architecture: arch(),
        osRelease: release(),
        nativeExecutable: basename(options.nativePath),
        targetExecutable: basename(options.targetPath),
        model,
        endpointHost: lmStudio.endpointHost,
      },
      policy: {
        axDirectSkipsVision: true,
        candidateSelectorResponses: 2,
        unrestrictedVisionMinimumScore: 0.9,
        candidateSelectorRequiresCompleteAgreement: true,
        maximumEvidenceAgeMs: 30_000,
        requiresPreActionReresolution: true,
        requiresPostcondition: true,
      },
      aggregate,
      cases: results,
    });
    process.stdout.write(
      `${JSON.stringify({
        output: options.outputPath,
        passed: aggregate.passed,
        total: aggregate.total,
        unsafeFalsePositives: aggregate.unsafeFalsePositives,
        modelCalls: aggregate.modelCalls,
        routes: aggregate.routes,
      })}\n`,
    );
    if (
      aggregate.passed !== aggregate.total ||
      aggregate.unsafeFalsePositives > 0
    ) {
      process.exitCode = 1;
    }
  } finally {
    await native?.close();
    await stopTarget(target);
  }
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
