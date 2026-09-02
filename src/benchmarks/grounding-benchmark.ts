#!/usr/bin/env node

import { createInterface } from "node:readline";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { captureMetadataSchema, helperStatusSchema } from "../tools/capture.js";
import { consumeCaptureArtifact } from "../native/artifacts.js";
import {
  containsPoint,
  decodeFoundResult,
  scoreFoundResult,
} from "../grounding/geometry.js";
import {
  aggregateGroundingConfidence,
  deriveGroundingStatus,
  evaluateGroundingConfidence,
  type CandidateView,
  type GroundingDerivedStatus,
} from "../grounding/confidence.js";
import {
  LmStudioClient,
  LmStudioError,
} from "../grounding/lm-studio-client.js";
import { NativeClient } from "../native/client.js";
import { qwen3VlAdapter } from "../grounding/adapters/qwen3-vl.js";
import { qwen3VlCandidateAdapters } from "../grounding/adapters/qwen3-vl-candidates.js";
import { rectSchema, type Rect } from "../grounding/types.js";
import { z } from "zod";

const expectedStatusSchema = z.enum(["found", "not_found", "ambiguous"]);
const targetCaseSchema = z
  .object({
    id: z.string().min(1),
    suite: z.enum(["scored", "calibration"]),
    query: z.string().min(1),
    expectedStatus: expectedStatusSchema,
    targetBounds: rectSchema.optional(),
  })
  .superRefine(({ expectedStatus, targetBounds }, context) => {
    if ((expectedStatus === "found") !== (targetBounds !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["targetBounds"],
        message: "Only found cases must include targetBounds",
      });
    }
  });
const readyManifestSchema = z.object({
  type: z.literal("ready"),
  processId: z.number().int().positive(),
  window: z.object({ title: z.string().min(1), bounds: rectSchema }),
  cases: z.array(targetCaseSchema).min(1),
});

const windowListSchema = z.object({
  windows: z.array(
    z.object({
      windowId: z.string().regex(/^\d+$/),
      title: z.string(),
      bounds: rectSchema,
      owningApplication: z.object({
        processId: z.number().int().positive(),
        bundleIdentifier: z.string(),
      }),
    }),
  ),
});
const normalizedRectSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .refine(({ x, width }) => x + width <= 1, {
    path: ["width"],
    message: "Normalized bounds must fit horizontally",
  })
  .refine(({ y, height }) => y + height <= 1, {
    path: ["height"],
    message: "Normalized bounds must fit vertically",
  });
const realCaseSchema = z
  .object({
    id: z.string().min(1),
    bundleIdentifier: z.string().min(1),
    windowTitlePattern: z.string().min(1),
    referenceWindowSize: z.object({
      width: z.number().positive(),
      height: z.number().positive(),
    }),
    query: z.string().min(1),
    expectedStatus: expectedStatusSchema,
    targetBoundsNormalized: normalizedRectSchema.optional(),
  })
  .superRefine(({ expectedStatus, targetBoundsNormalized }, context) => {
    if (
      (expectedStatus === "found") !==
      (targetBoundsNormalized !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["targetBoundsNormalized"],
        message: "Only found real-app cases must include normalized bounds",
      });
    }
  });
const realCasesManifestSchema = z.object({
  schemaVersion: z.literal(1),
  cases: z.array(realCaseSchema).min(1),
});

const displayListSchema = z.object({
  displays: z.array(
    z.object({
      displayId: z.string().regex(/^\d+$/),
      bounds: rectSchema,
      pixelSize: z.object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      }),
      pixelsPerPoint: z.object({
        x: z.number().positive(),
        y: z.number().positive(),
      }),
      isMain: z.boolean(),
    }),
  ),
});

type ReadyManifest = z.infer<typeof readyManifestSchema>;
type TargetCase = z.infer<typeof targetCaseSchema>;
type CaptureMetadata = z.infer<typeof captureMetadataSchema>;

interface Options {
  widths: number[];
  accuracyRepetitions: number;
  latencyRepetitions: number;
  includeDisplayContext: boolean;
  realCasesPath?: string;
  outputPath: string;
  nativePath: string;
  targetPath: string;
  allowRemoteEndpoint: boolean;
  confidenceStrategy: boolean;
}

interface CapturedImage {
  requestedWidth: number;
  metadata: CaptureMetadata;
  base64: string;
  captureDurationMs: number;
  scope: "window-region" | "real-window" | "display";
}

interface TrialError {
  code: string;
  message: string;
}

interface AccuracyTrial {
  kind: "accuracy";
  corpus: "deterministic" | "exploratory";
  scope: "window-region" | "real-window" | "display";
  caseId: string;
  query: string;
  expectedStatus: z.infer<typeof expectedStatusSchema>;
  expectedBounds?: Rect;
  repetition: number;
  requestedWidth: number;
  actualSize: { width: number; height: number };
  imageByteLength: number;
  sharedCaptureDurationMs: number;
  inferenceDurationMs?: number;
  trialDurationMs: number;
  prediction?: unknown;
  decoded?: unknown;
  score?: unknown;
  passed: boolean;
  error?: TrialError;
}

interface LatencyTrial {
  kind: "latency";
  scope: "window-region";
  caseId: string;
  repetition: number;
  requestedWidth: number;
  actualSize?: { width: number; height: number };
  imageByteLength?: number;
  captureDurationMs?: number;
  inferenceDurationMs?: number;
  endToEndDurationMs: number;
  passed: boolean;
  error?: TrialError;
}

interface CandidateConfidenceResult {
  caseId: string;
  query: string;
  expectedStatus: z.infer<typeof expectedStatusSchema>;
  expectedBounds?: Rect;
  derivedStatus: GroundingDerivedStatus;
  passed: boolean;
  confidence: ReturnType<typeof evaluateGroundingConfidence>;
  views: Array<{
    adapterId: string;
    requestedWidth: number;
    actualSize: { width: number; height: number };
    durationMs?: number;
    candidates?: unknown[];
    error?: TrialError;
  }>;
}

interface CalibrationResult {
  passed: boolean;
  requestedWidth: number;
  actualSize: { width: number; height: number };
  cases: AccuracyTrial[];
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseOptions(argv: string[]): Options {
  let widthsSpecified = false;
  const options: Options = {
    widths: [512, 768, 1024, 1280, 1600],
    accuracyRepetitions: 3,
    latencyRepetitions: 10,
    includeDisplayContext: false,
    outputPath: resolve(
      "benchmark-results",
      `grounding-${new Date().toISOString().replaceAll(":", "-")}.json`,
    ),
    nativePath: resolve(
      process.env.COMPUTER_USE_NATIVE_PATH ??
        "native/.build/release/ComputerUseNative",
    ),
    targetPath: resolve(
      process.env.GROUNDING_TARGET_PATH ??
        "native/.build/release/GroundingTestTarget",
    ),
    allowRemoteEndpoint: false,
    confidenceStrategy: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    switch (flag) {
      case "--widths":
        if (next === undefined) throw new Error("--widths requires a value");
        widthsSpecified = true;
        options.widths = Array.from(
          new Set(
            next
              .split(",")
              .map((value) => parsePositiveInteger(value.trim(), "--widths")),
          ),
        );
        index += 1;
        break;
      case "--accuracy-repetitions":
        if (next === undefined) {
          throw new Error("--accuracy-repetitions requires a value");
        }
        options.accuracyRepetitions = parsePositiveInteger(
          next,
          "--accuracy-repetitions",
        );
        index += 1;
        break;
      case "--latency-repetitions":
        if (next === undefined) {
          throw new Error("--latency-repetitions requires a value");
        }
        options.latencyRepetitions = parsePositiveInteger(
          next,
          "--latency-repetitions",
        );
        index += 1;
        break;
      case "--include-display-context":
        options.includeDisplayContext = true;
        break;
      case "--real-cases":
        if (next === undefined)
          throw new Error("--real-cases requires a value");
        options.realCasesPath = resolve(next);
        index += 1;
        break;
      case "--allow-remote-endpoint":
        options.allowRemoteEndpoint = true;
        break;
      case "--confidence-strategy":
        options.confidenceStrategy = true;
        break;
      case "--output":
        if (next === undefined) throw new Error("--output requires a value");
        options.outputPath = resolve(next);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument '${flag}'`);
    }
  }
  if (options.confidenceStrategy) {
    const requiredWidths = [768, 1024];
    if (
      widthsSpecified &&
      (options.widths.length !== requiredWidths.length ||
        options.widths.some((width, index) => width !== requiredWidths[index]))
    ) {
      throw new Error(
        "--confidence-strategy requires --widths 768,1024 when widths are specified",
      );
    }
    if (options.includeDisplayContext || options.realCasesPath !== undefined) {
      throw new Error(
        "--confidence-strategy does not support display-context or real-app cases",
      );
    }
    options.widths = requiredWidths;
  }
  return options;
}

async function startTarget(executablePath: string): Promise<{
  child: ChildProcessWithoutNullStreams;
  manifest: ReadyManifest;
  lines: ReturnType<typeof createInterface>;
}> {
  const child = spawn(executablePath, [], { stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  const manifest = await new Promise<ReadyManifest>(
    (resolveReady, rejectReady) => {
      const timeout = setTimeout(
        () => rejectReady(new Error("Grounding test target timed out")),
        10_000,
      );
      const finish = (callback: () => void) => {
        clearTimeout(timeout);
        callback();
      };
      lines.once("line", (line) => {
        try {
          const ready = readyManifestSchema.parse(JSON.parse(line));
          finish(() => resolveReady(ready));
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
              `Grounding test target exited before readiness (${signal ?? code})`,
            ),
          ),
        ),
      );
    },
  );
  return { child, manifest, lines };
}

async function stopTarget(
  target:
    | {
        child: ChildProcessWithoutNullStreams;
        lines: ReturnType<typeof createInterface>;
      }
    | undefined,
): Promise<void> {
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

function containsRect(container: Rect, candidate: Rect): boolean {
  return (
    candidate.x >= container.x &&
    candidate.y >= container.y &&
    candidate.x + candidate.width <= container.x + container.width &&
    candidate.y + candidate.height <= container.y + container.height
  );
}

function redactLocalPaths(message: string): string {
  const workspace = resolve(".");
  const temporaryDirectory = tmpdir();
  return message
    .replaceAll(workspace, "<workspace>")
    .replaceAll(temporaryDirectory, "<tmp>");
}

function errorValue(error: unknown): TrialError {
  return {
    code:
      error instanceof LmStudioError
        ? error.code
        : error instanceof z.ZodError
          ? "validation"
          : "unexpected",
    message: redactLocalPaths(
      error instanceof Error ? error.message : String(error),
    ),
  };
}

async function captureImage(
  native: NativeClient,
  artifactRoot: string,
  target: Record<string, unknown>,
  requestedWidth: number,
  scope: CapturedImage["scope"],
): Promise<CapturedImage> {
  const startedAt = performance.now();
  const artifact = await native.request<unknown>("screen.capture", {
    target,
    format: "png",
    scale: scope === "display" ? "native" : 4,
    maxWidth: requestedWidth,
    includeCursor: false,
  });
  const consumed = await consumeCaptureArtifact(artifact, artifactRoot);
  const metadata = captureMetadataSchema.parse(consumed.metadata);
  return {
    requestedWidth,
    metadata,
    base64: consumed.data,
    captureDurationMs: performance.now() - startedAt,
    scope,
  };
}

async function warmCapture(
  native: NativeClient,
  artifactRoot: string,
  target: Record<string, unknown>,
  requestedWidth: number,
): Promise<{ attempts: number; firstError?: TrialError }> {
  try {
    await captureImage(
      native,
      artifactRoot,
      target,
      requestedWidth,
      "window-region",
    );
    return { attempts: 1 };
  } catch (error) {
    const firstError = errorValue(error);
    process.stderr.write(
      `Initial ScreenCaptureKit warm-up failed (${firstError.message}); retrying once after 500 ms\n`,
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    await captureImage(
      native,
      artifactRoot,
      target,
      requestedWidth,
      "window-region",
    );
    return { attempts: 2, firstError };
  }
}

async function captureDistinctWidths(
  native: NativeClient,
  artifactRoot: string,
  target: Record<string, unknown>,
  widths: number[],
  scope: CapturedImage["scope"],
): Promise<{
  captures: CapturedImage[];
  duplicates: Array<{ requestedWidth: number; actualKey: string }>;
}> {
  const captures: CapturedImage[] = [];
  const duplicates: Array<{ requestedWidth: number; actualKey: string }> = [];
  const actualSizes = new Set<string>();
  for (const requestedWidth of widths) {
    const capture = await captureImage(
      native,
      artifactRoot,
      target,
      requestedWidth,
      scope,
    );
    const actualKey = `${capture.metadata.outputPixelSize.width}x${capture.metadata.outputPixelSize.height}`;
    if (actualSizes.has(actualKey)) {
      duplicates.push({ requestedWidth, actualKey });
      continue;
    }
    actualSizes.add(actualKey);
    captures.push(capture);
  }
  return { captures, duplicates };
}

async function runAccuracyTrial(
  client: LmStudioClient,
  model: string,
  capture: CapturedImage,
  targetCase: TargetCase,
  repetition: number,
  corpus: AccuracyTrial["corpus"] = "deterministic",
): Promise<AccuracyTrial> {
  const startedAt = performance.now();
  const base: Omit<AccuracyTrial, "passed" | "trialDurationMs"> = {
    kind: "accuracy",
    corpus,
    scope: capture.scope,
    caseId: targetCase.id,
    query: targetCase.query,
    expectedStatus: targetCase.expectedStatus,
    ...(targetCase.targetBounds === undefined
      ? {}
      : { expectedBounds: targetCase.targetBounds }),
    repetition,
    requestedWidth: capture.requestedWidth,
    actualSize: capture.metadata.outputPixelSize,
    imageByteLength: capture.metadata.byteLength,
    sharedCaptureDurationMs: capture.captureDurationMs,
  };
  try {
    const prediction = await client.ground(
      qwen3VlAdapter,
      model,
      targetCase.query,
      { base64: capture.base64, mimeType: capture.metadata.mimeType },
      capture.metadata.outputPixelSize,
    );
    let passed = prediction.result.status === targetCase.expectedStatus;
    let score: unknown;
    let decoded: unknown;
    if (prediction.result.status === "found") {
      decoded = decodeFoundResult(
        prediction.result,
        capture.metadata.outputPixelSize,
        qwen3VlAdapter.coordinateDenominator,
      );
      if (targetCase.targetBounds !== undefined) {
        score = scoreFoundResult(
          prediction.result,
          targetCase.targetBounds,
          capture.metadata.outputPixelSize,
          capture.metadata.mapping,
          qwen3VlAdapter.coordinateDenominator,
        );
        passed = passed && (score as { pointInTarget: boolean }).pointInTarget;
      } else {
        passed = false;
      }
    }
    return {
      ...base,
      inferenceDurationMs: prediction.durationMs,
      trialDurationMs: performance.now() - startedAt,
      prediction: prediction.result,
      ...(decoded === undefined ? {} : { decoded }),
      ...(score === undefined ? {} : { score }),
      passed,
    };
  } catch (error) {
    return {
      ...base,
      trialDurationMs: performance.now() - startedAt,
      passed: false,
      error: errorValue(error),
    };
  }
}

async function runCalibration(
  client: LmStudioClient,
  model: string,
  capture: CapturedImage,
  cases: TargetCase[],
): Promise<CalibrationResult> {
  const trials: AccuracyTrial[] = [];
  for (const targetCase of cases) {
    trials.push(await runAccuracyTrial(client, model, capture, targetCase, 1));
  }
  return {
    passed: trials.every(({ passed }) => passed),
    requestedWidth: capture.requestedWidth,
    actualSize: capture.metadata.outputPixelSize,
    cases: trials,
  };
}

function groupBy<T>(
  values: T[],
  keyFor: (value: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [value]);
    } else {
      group.push(value);
    }
  }
  return groups;
}

function percentileSummary(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
      : (sorted[middle] ?? 0);
  return {
    count: sorted.length,
    min: sorted[0] ?? null,
    median,
    max: sorted.at(-1) ?? null,
  };
}

function selectConfidenceCaptures(
  captures: CapturedImage[],
  targetWidths = [768, 1024],
): CapturedImage[] {
  if (captures.length < targetWidths.length) {
    throw new Error(
      "Confidence strategy requires at least two distinct actual capture sizes",
    );
  }
  const available = [...captures];
  const selected = targetWidths.map((targetWidth) => {
    const closest = available.reduce((best, capture) =>
      Math.abs(capture.metadata.outputPixelSize.width - targetWidth) <
      Math.abs(best.metadata.outputPixelSize.width - targetWidth)
        ? capture
        : best,
    );
    available.splice(available.indexOf(closest), 1);
    return closest;
  });
  if (
    new Set(
      selected.map(
        ({ metadata }) =>
          `${metadata.outputPixelSize.width}x${metadata.outputPixelSize.height}`,
      ),
    ).size !== targetWidths.length
  ) {
    throw new Error(
      "Confidence strategy requires two distinct actual capture sizes",
    );
  }
  return selected.sort(
    (left, right) =>
      left.metadata.outputPixelSize.width -
      right.metadata.outputPixelSize.width,
  );
}

function aggregateAccuracy(trials: AccuracyTrial[]) {
  return Array.from(
    groupBy(
      trials,
      ({ scope, actualSize }) =>
        `${scope}:${actualSize.width}x${actualSize.height}`,
    ),
    ([key, group]) => ({
      key,
      total: group.length,
      passed: group.filter(({ passed }) => passed).length,
      unsafeFalsePositives: group.filter(
        ({ expectedStatus, prediction }) =>
          expectedStatus !== "found" &&
          (prediction as { status?: unknown } | undefined)?.status === "found",
      ).length,
      structuredOutputFailures: group.filter(
        ({ error }) => error?.code === "structured_output",
      ).length,
    }),
  );
}

async function runCandidateConfidenceCases(
  client: LmStudioClient,
  model: string,
  captures: CapturedImage[],
  cases: TargetCase[],
): Promise<CandidateConfidenceResult[]> {
  if (captures.length !== 2) {
    throw new Error(
      "Confidence strategy requires exactly two selected captures",
    );
  }
  const expectedViewCount = captures.length * qwen3VlCandidateAdapters.length;
  const results: CandidateConfidenceResult[] = [];

  for (const targetCase of cases) {
    const candidateViews: CandidateView[] = [];
    const views: CandidateConfidenceResult["views"] = [];
    for (const capture of captures) {
      for (const adapter of qwen3VlCandidateAdapters) {
        process.stderr.write(
          `Confidence ${capture.metadata.outputPixelSize.width}px ${adapter.id} ${targetCase.id}\n`,
        );
        try {
          const prediction = await client.ground(
            adapter,
            model,
            targetCase.query,
            { base64: capture.base64, mimeType: capture.metadata.mimeType },
            capture.metadata.outputPixelSize,
          );
          candidateViews.push({
            adapterId: adapter.id,
            requestedWidth: capture.requestedWidth,
            imageSize: capture.metadata.outputPixelSize,
            mapping: capture.metadata.mapping,
            coordinateDenominator: adapter.coordinateDenominator,
            candidates: prediction.result.candidates,
          });
          views.push({
            adapterId: adapter.id,
            requestedWidth: capture.requestedWidth,
            actualSize: capture.metadata.outputPixelSize,
            durationMs: prediction.durationMs,
            candidates: prediction.result.candidates,
          });
        } catch (error) {
          views.push({
            adapterId: adapter.id,
            requestedWidth: capture.requestedWidth,
            actualSize: capture.metadata.outputPixelSize,
            error: errorValue(error),
          });
        }
      }
    }

    const confidence = evaluateGroundingConfidence(
      candidateViews,
      expectedViewCount,
    );
    const derivedStatus = deriveGroundingStatus(confidence);
    const foundPointPasses =
      targetCase.expectedStatus !== "found" ||
      (targetCase.targetBounds !== undefined &&
        confidence.agreedPoint !== null &&
        containsPoint(targetCase.targetBounds, confidence.agreedPoint));
    const passed =
      derivedStatus === targetCase.expectedStatus && foundPointPasses;
    results.push({
      caseId: targetCase.id,
      query: targetCase.query,
      expectedStatus: targetCase.expectedStatus,
      ...(targetCase.targetBounds === undefined
        ? {}
        : { expectedBounds: targetCase.targetBounds }),
      derivedStatus,
      passed,
      confidence,
      views,
    });
  }
  return results;
}

function normalizedToScreenBounds(normalized: Rect, windowBounds: Rect): Rect {
  return {
    x: windowBounds.x + normalized.x * windowBounds.width,
    y: windowBounds.y + normalized.y * windowBounds.height,
    width: normalized.width * windowBounds.width,
    height: normalized.height * windowBounds.height,
  };
}

async function runRealCases(
  path: string,
  native: NativeClient,
  artifactRoot: string,
  client: LmStudioClient,
  model: string,
  requestedWidth: number,
): Promise<{
  trials: AccuracyTrial[];
  skipped: Array<{ caseId: string; reason: string }>;
}> {
  const manifest = realCasesManifestSchema.parse(
    JSON.parse(await readFile(path, "utf8")),
  );
  const windows = windowListSchema.parse(
    await native.request<unknown>("window.list", {
      onScreenOnly: true,
      includeUntitled: false,
    }),
  );
  const trials: AccuracyTrial[] = [];
  const skipped: Array<{ caseId: string; reason: string }> = [];

  for (const realCase of manifest.cases) {
    let titlePattern: RegExp;
    try {
      titlePattern = new RegExp(realCase.windowTitlePattern);
    } catch (error) {
      skipped.push({
        caseId: realCase.id,
        reason: `Invalid windowTitlePattern: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    const matches = windows.windows.filter(
      ({ title, owningApplication }) =>
        owningApplication.bundleIdentifier === realCase.bundleIdentifier &&
        titlePattern.test(title),
    );
    if (matches.length !== 1) {
      skipped.push({
        caseId: realCase.id,
        reason: `Expected one matching on-screen window, found ${matches.length}`,
      });
      continue;
    }
    const window = matches[0];
    if (window === undefined) continue;
    const sizeDelta = Math.max(
      Math.abs(window.bounds.width - realCase.referenceWindowSize.width),
      Math.abs(window.bounds.height - realCase.referenceWindowSize.height),
    );
    if (sizeDelta > 1) {
      skipped.push({
        caseId: realCase.id,
        reason: `Window size changed from reference (maximum delta ${sizeDelta})`,
      });
      continue;
    }
    try {
      const capture = await captureImage(
        native,
        artifactRoot,
        { kind: "window", windowId: window.windowId },
        requestedWidth,
        "real-window",
      );
      const targetCase: TargetCase = {
        id: realCase.id,
        suite: "scored",
        query: realCase.query,
        expectedStatus: realCase.expectedStatus,
        ...(realCase.targetBoundsNormalized === undefined
          ? {}
          : {
              targetBounds: normalizedToScreenBounds(
                realCase.targetBoundsNormalized,
                window.bounds,
              ),
            }),
      };
      trials.push(
        await runAccuracyTrial(
          client,
          model,
          capture,
          targetCase,
          1,
          "exploratory",
        ),
      );
    } catch (error) {
      skipped.push({
        caseId: realCase.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { trials, skipped };
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const directory = resolve(path, "..");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const client = new LmStudioClient({
    ...(process.env.LM_STUDIO_BASE_URL === undefined
      ? {}
      : { baseUrl: process.env.LM_STUDIO_BASE_URL }),
    ...(process.env.LM_STUDIO_API_KEY === undefined
      ? {}
      : { apiKey: process.env.LM_STUDIO_API_KEY }),
    ...(process.env.LM_STUDIO_MODEL === undefined
      ? {}
      : { model: process.env.LM_STUDIO_MODEL }),
    allowRemoteEndpoint: options.allowRemoteEndpoint,
  });
  const model = await client.selectModel(qwen3VlAdapter);
  process.stderr.write(`Using LM Studio model ${model}\n`);

  const native = new NativeClient({ executablePath: options.nativePath });
  let target: Awaited<ReturnType<typeof startTarget>> | undefined;
  let shuttingDown = false;
  const cleanup = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await native.close().catch(() => undefined);
    await stopTarget(target).catch(() => undefined);
  };
  const interrupt = () => void cleanup().finally(() => process.exit(130));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);

  try {
    const status = helperStatusSchema.parse(
      await native.request<unknown>("health"),
    );
    const initialDisplays = displayListSchema.parse(
      await native.request<unknown>("display.list"),
    );
    target = await startTarget(options.targetPath);
    const manifestBounds = target.manifest.window.bounds;
    const containingDisplays = initialDisplays.displays.filter(({ bounds }) =>
      containsRect(bounds, manifestBounds),
    );
    if (containingDisplays.length !== 1) {
      throw new Error(
        `Expected the grounding target region to fit one display, found ${containingDisplays.length}`,
      );
    }
    const containingDisplay = containingDisplays[0];
    if (containingDisplay === undefined) {
      throw new Error("Grounding target display disappeared");
    }

    const regionTarget = { kind: "region", bounds: manifestBounds };
    const captureWarmup = await warmCapture(
      native,
      status.artifactRoot,
      regionTarget,
      Math.min(...options.widths),
    );
    const windowMatrix = await captureDistinctWidths(
      native,
      status.artifactRoot,
      regionTarget,
      options.widths,
      "window-region",
    );
    if (windowMatrix.captures.length < 3) {
      process.stderr.write(
        `Warning: requested widths produced only ${windowMatrix.captures.length} distinct window sizes\n`,
      );
    }

    const calibrationCapture =
      windowMatrix.captures.find(
        ({ metadata }) => metadata.outputPixelSize.width >= 1024,
      ) ?? windowMatrix.captures.at(-1);
    if (calibrationCapture === undefined) {
      throw new Error("No window captures were produced");
    }
    const calibration = await runCalibration(
      client,
      model,
      calibrationCapture,
      target.manifest.cases.filter(({ suite }) => suite === "calibration"),
    );
    if (!calibration.passed) {
      const failed = calibration.cases
        .filter(({ passed }) => !passed)
        .map(({ caseId, error }) => `${caseId}: ${error?.message ?? "miss"}`)
        .join("; ");
      throw new Error(`Coordinate calibration failed: ${failed}`);
    }

    const matrices: CapturedImage[] = [...windowMatrix.captures];
    let displayDuplicates: Array<{
      requestedWidth: number;
      actualKey: string;
    }> = [];
    if (options.includeDisplayContext) {
      const displayMatrix = await captureDistinctWidths(
        native,
        status.artifactRoot,
        { kind: "display", displayId: containingDisplay.displayId },
        options.widths,
        "display",
      );
      matrices.push(...displayMatrix.captures);
      displayDuplicates = displayMatrix.duplicates;
    }

    const scoredCases = target.manifest.cases.filter(
      ({ suite }) => suite === "scored",
    );
    if (options.confidenceStrategy) {
      const selectedCaptures = selectConfidenceCaptures(windowMatrix.captures);
      const plannedConfidenceCalls =
        scoredCases.length *
        selectedCaptures.length *
        qwen3VlCandidateAdapters.length;
      process.stderr.write(
        `Planned confidence model requests after calibration: ${plannedConfidenceCalls}\n`,
      );
      const confidenceResults = await runCandidateConfidenceCases(
        client,
        model,
        selectedCaptures,
        scoredCases,
      );
      const result = {
        schemaVersion: 1,
        completed: true,
        timestamp: new Date().toISOString(),
        packageVersion: "0.1.0",
        environment: {
          platform: process.platform,
          architecture: process.arch,
          lmStudioEndpointHost: client.endpointHost,
          model,
          adapters: qwen3VlCandidateAdapters.map((adapter) => ({
            id: adapter.id,
            version: adapter.version,
            maxCoordinate: adapter.maxCoordinate,
            coordinateDenominator: adapter.coordinateDenominator,
          })),
          backend: process.env.LM_STUDIO_BACKEND ?? null,
          quantization: process.env.LM_STUDIO_QUANTIZATION ?? null,
        },
        configuration: {
          confidenceStrategy: true,
          requestedWidths: options.widths,
          promptVariants: qwen3VlCandidateAdapters.map(({ id }) => id),
          expectedEvidenceViewsPerCase:
            selectedCaptures.length * qwen3VlCandidateAdapters.length,
          baselineAccuracySkipped: true,
          latencyTrialsSkipped: true,
          format: "png",
          windowScale: 4,
          includeCursor: false,
        },
        captureWarmup,
        captureMatrix: {
          window: selectedCaptures.map(({ requestedWidth, metadata }) => ({
            requestedWidth,
            actualSize: metadata.outputPixelSize,
            mapping: metadata.mapping,
          })),
          windowDuplicates: windowMatrix.duplicates,
        },
        calibration,
        confidenceResults,
        confidenceAggregates: aggregateGroundingConfidence(confidenceResults),
      };
      await writeJsonAtomic(options.outputPath, result);
      process.stdout.write(`${options.outputPath}\n`);
      return;
    }

    const displayCaseIds = new Set([
      "submit-large",
      "settings-gear-small",
      "delete-account-absent",
      "prompt-injection-continue-safely",
    ]);
    const plannedAccuracyCalls = matrices.reduce(
      (total, capture) =>
        total +
        (capture.scope === "window-region"
          ? scoredCases.length
          : scoredCases.filter(({ id }) => displayCaseIds.has(id)).length) *
          options.accuracyRepetitions,
      0,
    );
    const plannedLatencyCalls =
      windowMatrix.captures.length * options.latencyRepetitions;
    process.stderr.write(
      `Planned scored model requests after calibration: ${plannedAccuracyCalls} accuracy + ${plannedLatencyCalls} latency = ${plannedAccuracyCalls + plannedLatencyCalls}\n`,
    );

    const accuracyTrials: AccuracyTrial[] = [];
    for (const capture of matrices) {
      const cases =
        capture.scope === "window-region"
          ? scoredCases
          : scoredCases.filter(({ id }) => displayCaseIds.has(id));
      for (const targetCase of cases) {
        for (
          let repetition = 1;
          repetition <= options.accuracyRepetitions;
          repetition += 1
        ) {
          process.stderr.write(
            `Accuracy ${capture.scope} ${capture.metadata.outputPixelSize.width}px ${targetCase.id} ${repetition}/${options.accuracyRepetitions}\n`,
          );
          accuracyTrials.push(
            await runAccuracyTrial(
              client,
              model,
              capture,
              targetCase,
              repetition,
            ),
          );
        }
      }
    }

    const latencyCase = scoredCases.find(({ id }) => id === "submit-large");
    if (latencyCase === undefined)
      throw new Error("Submit latency case is missing");
    const latencyTrials: LatencyTrial[] = [];
    for (const referenceCapture of windowMatrix.captures) {
      for (
        let repetition = 1;
        repetition <= options.latencyRepetitions;
        repetition += 1
      ) {
        process.stderr.write(
          `Latency window-region ${referenceCapture.metadata.outputPixelSize.width}px ${repetition}/${options.latencyRepetitions}\n`,
        );
        const startedAt = performance.now();
        try {
          const capture = await captureImage(
            native,
            status.artifactRoot,
            regionTarget,
            referenceCapture.requestedWidth,
            "window-region",
          );
          const prediction = await client.ground(
            qwen3VlAdapter,
            model,
            latencyCase.query,
            { base64: capture.base64, mimeType: capture.metadata.mimeType },
            capture.metadata.outputPixelSize,
          );
          latencyTrials.push({
            kind: "latency",
            scope: "window-region",
            caseId: latencyCase.id,
            repetition,
            requestedWidth: referenceCapture.requestedWidth,
            actualSize: capture.metadata.outputPixelSize,
            imageByteLength: capture.metadata.byteLength,
            captureDurationMs: capture.captureDurationMs,
            inferenceDurationMs: prediction.durationMs,
            endToEndDurationMs: performance.now() - startedAt,
            passed: prediction.result.status === "found",
          });
        } catch (error) {
          latencyTrials.push({
            kind: "latency",
            scope: "window-region",
            caseId: latencyCase.id,
            repetition,
            requestedWidth: referenceCapture.requestedWidth,
            endToEndDurationMs: performance.now() - startedAt,
            passed: false,
            error: errorValue(error),
          });
        }
      }
    }

    const exploratory =
      options.realCasesPath === undefined
        ? {
            trials: [] as AccuracyTrial[],
            skipped: [] as Array<{ caseId: string; reason: string }>,
          }
        : await runRealCases(
            options.realCasesPath,
            native,
            status.artifactRoot,
            client,
            model,
            Math.max(...options.widths),
          );

    const result = {
      schemaVersion: 1,
      completed: true,
      timestamp: new Date().toISOString(),
      packageVersion: "0.1.0",
      environment: {
        platform: process.platform,
        architecture: process.arch,
        lmStudioEndpointHost: client.endpointHost,
        model,
        adapter: {
          id: qwen3VlAdapter.id,
          version: qwen3VlAdapter.version,
          maxCoordinate: qwen3VlAdapter.maxCoordinate,
          coordinateDenominator: qwen3VlAdapter.coordinateDenominator,
          endpointSensitivityDenominator: 999,
        },
        backend: process.env.LM_STUDIO_BACKEND ?? null,
        quantization: process.env.LM_STUDIO_QUANTIZATION ?? null,
      },
      configuration: {
        confidenceStrategy: false,
        requestedWidths: options.widths,
        accuracyRepetitions: options.accuracyRepetitions,
        latencyRepetitions: options.latencyRepetitions,
        includeDisplayContext: options.includeDisplayContext,
        realCasesEnabled: options.realCasesPath !== undefined,
        format: "png",
        windowScale: 4,
        displayScale: "native",
        includeCursor: false,
      },
      captureWarmup,
      captureMatrix: {
        window: windowMatrix.captures.map(({ requestedWidth, metadata }) => ({
          requestedWidth,
          actualSize: metadata.outputPixelSize,
          mapping: metadata.mapping,
        })),
        windowDuplicates: windowMatrix.duplicates,
        displayDuplicates,
      },
      calibration,
      trials: {
        accuracy: accuracyTrials,
        latency: latencyTrials,
        exploratory: exploratory.trials,
      },
      skippedExploratoryCases: exploratory.skipped,
      aggregates: {
        accuracy: aggregateAccuracy(accuracyTrials),
        exploratoryAccuracy: aggregateAccuracy(exploratory.trials),
        warmedLatency: Array.from(
          groupBy(
            latencyTrials.filter(({ passed }) => passed),
            ({ actualSize, requestedWidth }) =>
              actualSize === undefined
                ? `requested:${requestedWidth}`
                : `${actualSize.width}x${actualSize.height}`,
          ),
          ([key, group]) => ({
            key,
            captureMs: percentileSummary(
              group.flatMap(({ captureDurationMs }) =>
                captureDurationMs === undefined ? [] : [captureDurationMs],
              ),
            ),
            inferenceMs: percentileSummary(
              group.flatMap(({ inferenceDurationMs }) =>
                inferenceDurationMs === undefined ? [] : [inferenceDurationMs],
              ),
            ),
            endToEndMs: percentileSummary(
              group.map(({ endToEndDurationMs }) => endToEndDurationMs),
            ),
          }),
        ),
      },
    };
    await writeJsonAtomic(options.outputPath, result);
    process.stdout.write(`${options.outputPath}\n`);
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await cleanup();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
