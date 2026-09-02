#!/usr/bin/env node

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";

import {
  accessibilityQuerySchema,
  accessibilitySnapshotSchema,
  aggregateAxDiscovery,
  axDiscoveryCaseSchema,
  axDiscoveryTrialSchema,
  type AxDiscoveryCase,
  type AxDiscoveryTrial,
} from "./ax-discovery-types.js";
import { semanticTargetEventSchema } from "./semantic-baseline-types.js";
import { NativeClient } from "../native/client.js";

interface Options {
  repetitions: number;
  outputPath: string;
  nativePath: string;
  targetPath: string;
}

interface TargetProcess {
  child: ChildProcessWithoutNullStreams;
  lines: Interface;
  processId: number;
}

const defaultLimits = {
  deadlineMs: 1_500,
  messageTimeoutMs: 100,
  maxDepth: 12,
  maxNodes: 1_000,
  maxChildren: 100,
  maxStringLength: 512,
  maxResultBytes: 1_048_576,
};

const cases: AxDiscoveryCase[] = [
  {
    id: "exact-button",
    expectedStatus: "found",
    predicate: {
      roles: ["AXButton"],
      name: "Submit workflow",
      nameMatch: "exact",
      requiredActions: ["AXPress"],
      enabled: true,
    },
  },
  {
    id: "normalized-checkbox",
    expectedStatus: "found",
    predicate: {
      roles: ["AXCheckBox"],
      name: "enable-cloud SYNC",
      nameMatch: "normalized",
      requiredActions: ["AXPress"],
      enabled: true,
    },
  },
  {
    id: "ancestor-qualified-text-field",
    expectedStatus: "found",
    predicate: {
      roles: ["AXTextField"],
      name: "Workflow text",
      nameMatch: "exact",
      ancestor: {
        roles: ["AXWindow"],
        name: "Computer Use Semantic Workflow Target",
        nameMatch: "exact",
      },
    },
  },
  {
    id: "ambiguous-button-role",
    expectedStatus: "ambiguous",
    predicate: {
      roles: ["AXButton"],
      requiredActions: ["AXPress"],
      enabled: true,
    },
  },
  {
    id: "absent-target",
    expectedStatus: "not_found",
    predicate: {
      name: "Control that does not exist",
      nameMatch: "exact",
    },
  },
  {
    id: "forced-incomplete",
    expectedStatus: "incomplete",
    predicate: {
      name: "Submit workflow",
      nameMatch: "exact",
    },
    limits: { maxNodes: 1 },
  },
].map((value) => axDiscoveryCaseSchema.parse(value));

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    repetitions: 3,
    outputPath: resolve(
      "benchmark-results",
      `ax-discovery-${new Date().toISOString().replaceAll(":", "-")}.json`,
    ),
    nativePath: resolve(
      process.env.COMPUTER_USE_NATIVE_PATH ??
        "native/.build/release/ComputerUseNative",
    ),
    targetPath: resolve(
      process.env.SEMANTIC_WORKFLOW_TARGET_PATH ??
        "native/.build/release/SemanticWorkflowTestTarget",
    ),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    switch (flag) {
      case "--repetitions":
        if (next === undefined)
          throw new Error("--repetitions requires a value");
        options.repetitions = parsePositiveInteger(next, "--repetitions");
        index += 1;
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
  return options;
}

async function startTarget(executablePath: string): Promise<TargetProcess> {
  const child = spawn(executablePath, [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, SEMANTIC_WORKFLOW_PASSIVE: "1" },
  });
  const lines = createInterface({ input: child.stdout });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  let resolveReady!: (processId: number) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<number>((resolveValue, rejectValue) => {
    resolveReady = resolveValue;
    rejectReady = rejectValue;
  });
  const timeout = setTimeout(
    () => rejectReady(new Error("Semantic workflow target timed out")),
    10_000,
  );
  const fail = (error: Error) => {
    clearTimeout(timeout);
    rejectReady(error);
  };

  lines.on("line", (line) => {
    try {
      const event = semanticTargetEventSchema.parse(JSON.parse(line));
      if (event.type === "ready") {
        clearTimeout(timeout);
        resolveReady(event.processId);
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
  child.once("error", fail);
  child.once("exit", (code, signal) =>
    fail(
      new Error(`Semantic target exited (${signal ?? code}) before readiness`),
    ),
  );

  try {
    return { child, lines, processId: await ready };
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

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  let target: TargetProcess | undefined;
  let native: NativeClient | undefined;
  const trials: AxDiscoveryTrial[] = [];

  try {
    target = await startTarget(options.targetPath);
    native = new NativeClient({ executablePath: options.nativePath });
    const baseParameters = {
      processId: target.processId,
      contentPolicy: "fixture",
      limits: defaultLimits,
    };

    const snapshotStartedAt = performance.now();
    const snapshot = accessibilitySnapshotSchema.parse(
      await native.request("accessibility.snapshot", baseParameters),
    );
    const snapshotDurationMs = performance.now() - snapshotStartedAt;
    if (snapshot.completion.status !== "complete") {
      throw new Error(
        `Initial AX snapshot was partial: ${snapshot.completion.reasons.join(", ")}`,
      );
    }

    for (
      let repetition = 1;
      repetition <= options.repetitions;
      repetition += 1
    ) {
      for (const benchmarkCase of cases) {
        const startedAt = performance.now();
        const response = accessibilityQuerySchema.parse(
          await native.request("accessibility.query", {
            ...baseParameters,
            predicate: benchmarkCase.predicate,
            limits: { ...defaultLimits, ...benchmarkCase.limits },
          }),
        );
        trials.push(
          axDiscoveryTrialSchema.parse({
            caseId: benchmarkCase.id,
            repetition,
            expectedStatus: benchmarkCase.expectedStatus,
            actualStatus: response.status,
            passed: response.status === benchmarkCase.expectedStatus,
            durationMs: performance.now() - startedAt,
            nativeDurationMs: response.metrics.durationMs,
            responseBytes: byteLength(response),
            nodesVisited: response.metrics.nodesVisited,
            axCalls: response.metrics.axCalls,
            matchCount: response.matchCount,
            completionStatus: response.completion.status,
            completionReasons: response.completion.reasons,
          }),
        );
      }
    }

    const aggregate = aggregateAxDiscovery(trials);
    const result = {
      schemaVersion: 1,
      benchmark: "accessibility-discovery-spike",
      generatedAt: new Date().toISOString(),
      safety: {
        readOnly: true,
        inputEventsSent: 0,
        mcpToolsRegistered: 0,
        captures: 0,
      },
      environment: {
        platform: platform(),
        architecture: arch(),
        osRelease: release(),
        nativeExecutable: basename(options.nativePath),
        targetExecutable: basename(options.targetPath),
      },
      configuration: {
        repetitions: options.repetitions,
        caseCount: cases.length,
        limits: defaultLimits,
      },
      snapshot: {
        durationMs: snapshotDurationMs,
        nativeDurationMs: snapshot.metrics.durationMs,
        responseBytes: byteLength(snapshot),
        nodesVisited: snapshot.metrics.nodesVisited,
        nodesReturned: snapshot.metrics.nodesReturned,
        axCalls: snapshot.metrics.axCalls,
        completionStatus: snapshot.completion.status,
        completionReasons: snapshot.completion.reasons,
        errorsByCategory: snapshot.metrics.errorsByCategory,
      },
      aggregate,
      trials,
    };
    await writeJsonAtomic(options.outputPath, result);

    process.stdout.write(
      `${JSON.stringify({
        output: options.outputPath,
        passed: aggregate.passed,
        total: aggregate.total,
        snapshotNodes: snapshot.metrics.nodesReturned,
        queryP50Ms: aggregate.durationMs.p50,
      })}\n`,
    );
    if (aggregate.passed !== aggregate.total) process.exitCode = 1;
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
