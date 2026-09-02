#!/usr/bin/env node

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  aggregateSemanticBaseline,
  semanticBaselineTrialSchema,
  semanticTargetCommandSchema,
  semanticTargetEventSchema,
  statesMatch,
  type SemanticBaselineTrial,
  type SemanticTargetCommand,
  type SemanticTargetEvent,
  type SemanticTargetState,
  type SemanticTraceEntry,
  type SemanticWorkflow,
} from "./semantic-baseline-types.js";
import { consumeCaptureArtifact } from "../native/artifacts.js";
import { NativeClient, type NativeBridge } from "../native/client.js";
import { captureMetadataSchema, helperStatusSchema } from "../tools/capture.js";
import { createServer } from "../server.js";
import { z } from "zod";

const routeSchema = z.enum(["oracle", "primitive", "input_batch"]);
type Route = z.infer<typeof routeSchema>;

interface Options {
  routes: Route[];
  repetitions: number;
  outputPath: string;
  nativePath: string;
  targetPath: string;
}

interface ReadyEvent extends Extract<SemanticTargetEvent, { type: "ready" }> {}

interface TargetProcess {
  child: ChildProcessWithoutNullStreams;
  lines: Interface;
  ready: ReadyEvent;
  command(command: SemanticTargetCommand): Promise<SemanticTargetState>;
}

type Point = { x: number; y: number };
type Action =
  | { type: "mouse_click"; point: Point }
  | { type: "keyboard_type"; text: string };

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function errorValue(error: unknown): { code: string; message: string } {
  const value = error as { code?: unknown; message?: unknown };
  return {
    code: typeof value?.code === "string" ? value.code : "benchmark_error",
    message: typeof value?.message === "string" ? value.message : String(error),
  };
}

class TraceCollector {
  readonly startedAt = performance.now();
  readonly entries: SemanticTraceEntry[] = [];
  #sequence = 0;

  async record<T>(
    layer: SemanticTraceEntry["layer"],
    operation: string,
    request: unknown,
    run: () => Promise<T>,
    summarize: (result: T) => {
      responseBytes?: number;
      imageBytes?: number;
    } = (result) => ({ responseBytes: byteLength(result) }),
  ): Promise<T> {
    const sequence = this.#sequence++;
    const startedAt = performance.now();
    try {
      const result = await run();
      const summary = summarize(result);
      this.entries.push({
        sequence,
        layer,
        operation,
        startedOffsetMs: startedAt - this.startedAt,
        durationMs: performance.now() - startedAt,
        requestBytes: byteLength(request),
        responseBytes: summary.responseBytes ?? byteLength(result),
        ...(summary.imageBytes === undefined
          ? {}
          : { imageBytes: summary.imageBytes }),
        status: "ok",
      });
      return result;
    } catch (error) {
      this.entries.push({
        sequence,
        layer,
        operation,
        startedOffsetMs: startedAt - this.startedAt,
        durationMs: performance.now() - startedAt,
        requestBytes: byteLength(request),
        responseBytes: 0,
        status: "error",
        errorCategory: errorValue(error).code,
      });
      throw error;
    }
  }
}

class TracingNativeBridge implements NativeBridge {
  #collector: TraceCollector | undefined;

  constructor(private readonly delegate: NativeClient) {}

  setCollector(collector: TraceCollector | undefined): void {
    this.#collector = collector;
  }

  request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const collector = this.#collector;
    if (collector === undefined)
      return this.delegate.request<T>(method, params);
    return collector.record("native", method, params, () =>
      this.delegate.request<T>(method, params),
    );
  }

  close(): Promise<void> {
    return this.delegate.close();
  }
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    routes: ["oracle", "primitive", "input_batch"],
    repetitions: 3,
    outputPath: resolve(
      "benchmark-results",
      `semantic-baseline-${new Date().toISOString().replaceAll(":", "-")}.json`,
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
      case "--routes":
        if (next === undefined) throw new Error("--routes requires a value");
        options.routes = Array.from(
          new Set(next.split(",").map((route) => routeSchema.parse(route))),
        );
        index += 1;
        break;
      case "--repetitions":
        if (next === undefined) {
          throw new Error("--repetitions requires a value");
        }
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
  const child = spawn(executablePath, [], { stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  const pending = new Map<
    string,
    {
      resolve(state: SemanticTargetState): void;
      reject(error: Error): void;
      timeout: NodeJS.Timeout;
    }
  >();
  let resolveReady!: (event: ReadyEvent) => void;
  let rejectReady!: (error: Error) => void;
  const readyPromise = new Promise<ReadyEvent>((resolveValue, rejectValue) => {
    resolveReady = resolveValue;
    rejectReady = rejectValue;
  });
  const readyTimeout = setTimeout(
    () => rejectReady(new Error("Semantic workflow target timed out")),
    10_000,
  );

  const failPending = (error: Error) => {
    rejectReady(error);
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
    if (child.exitCode === null) child.kill("SIGTERM");
  };

  lines.on("line", (line) => {
    try {
      const event = semanticTargetEventSchema.parse(JSON.parse(line));
      if (event.type === "ready") {
        clearTimeout(readyTimeout);
        resolveReady(event);
      } else if (event.type === "state") {
        const request = pending.get(event.requestId);
        if (request !== undefined) {
          pending.delete(event.requestId);
          clearTimeout(request.timeout);
          request.resolve(event.state);
        }
      } else if (event.type === "error" && event.requestId !== undefined) {
        const request = pending.get(event.requestId);
        if (request !== undefined) {
          pending.delete(event.requestId);
          clearTimeout(request.timeout);
          request.reject(new Error(event.message));
        }
      }
    } catch (error) {
      failPending(error instanceof Error ? error : new Error(String(error)));
    }
  });
  child.once("error", failPending);
  child.once("exit", (code, signal) =>
    failPending(
      new Error(`Semantic target exited unexpectedly (${signal ?? code})`),
    ),
  );

  try {
    const ready = await readyPromise;
    return {
      child,
      lines,
      ready,
      command(command) {
        const parsed = semanticTargetCommandSchema.parse(command);
        const response = new Promise<SemanticTargetState>(
          (resolveState, rejectState) => {
            const timeout = setTimeout(() => {
              pending.delete(parsed.requestId);
              rejectState(
                new Error(`Target command '${parsed.type}' timed out`),
              );
            }, 3_000);
            pending.set(parsed.requestId, {
              resolve: resolveState,
              reject: rejectState,
              timeout,
            });
          },
        );
        child.stdin.write(`${JSON.stringify(parsed)}\n`);
        return response;
      },
    };
  } catch (error) {
    clearTimeout(readyTimeout);
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

function controlPoint(ready: ReadyEvent, id: string): Point {
  const control = ready.controls.find((candidate) => candidate.id === id);
  if (control?.actionPoint === undefined) {
    throw new Error(`Fixture control '${id}' has no action point`);
  }
  return control.actionPoint;
}

function workflowActions(
  ready: ReadyEvent,
  workflow: SemanticWorkflow,
): Action[] {
  const textField = controlPoint(ready, "workflow-text");
  const submit = controlPoint(ready, "submit");
  const sync = controlPoint(ready, "cloud-sync");
  switch (workflow.id) {
    case "submit-text":
      return [
        { type: "mouse_click", point: textField },
        { type: "keyboard_type", text: "Baseline text" },
        { type: "mouse_click", point: submit },
      ];
    case "enable-sync":
      return [{ type: "mouse_click", point: sync }];
    case "configure-and-submit":
      return [
        { type: "mouse_click", point: sync },
        { type: "mouse_click", point: textField },
        { type: "keyboard_type", text: "Project Alpha ready" },
        { type: "mouse_click", point: submit },
      ];
    default:
      throw new Error(`Unsupported workflow '${workflow.id}'`);
  }
}

function nativeAction(action: Action): {
  method: string;
  params: Record<string, unknown>;
} {
  switch (action.type) {
    case "mouse_click":
      return {
        method: "mouse.click",
        params: {
          button: "left",
          point: action.point,
          count: 1,
          intervalMs: 0,
        },
      };
    case "keyboard_type":
      return {
        method: "keyboard.type",
        params: { text: action.text, intervalMs: 0 },
      };
  }
}

function batchStep(action: Action): Record<string, unknown> {
  switch (action.type) {
    case "mouse_click":
      return {
        type: "mouse_click",
        button: "left",
        point: action.point,
        count: 1,
        intervalMs: 0,
      };
    case "keyboard_type":
      return {
        type: "keyboard_type",
        text: action.text,
        intervalMs: 0,
      };
  }
}

async function waitForExpectedState(
  target: TargetProcess,
  collector: TraceCollector,
  workflow: SemanticWorkflow,
): Promise<SemanticTargetState> {
  const deadline = performance.now() + 3_000;
  let state: SemanticTargetState | undefined;
  while (performance.now() < deadline) {
    const requestId = randomUUID();
    state = await collector.record("target", "state", { requestId }, () =>
      target.command({ type: "state", requestId }),
    );
    if (
      statesMatch(state, workflow.expectedFinalState, workflow.expectedActions)
    ) {
      return state;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  if (state === undefined) throw new Error("Target state was unavailable");
  return state;
}

function mcpSummary(result: unknown): {
  responseBytes: number;
  imageBytes?: number;
} {
  const value = result as {
    content?: Array<{ type?: unknown; data?: unknown }>;
  };
  const imageBytes = (value.content ?? []).reduce(
    (total, content) =>
      content.type === "image" && typeof content.data === "string"
        ? total + Buffer.from(content.data, "base64").length
        : total,
    0,
  );
  return {
    responseBytes: byteLength(result),
    ...(imageBytes === 0 ? {} : { imageBytes }),
  };
}

function captureBytesFromMcp(result: unknown): number {
  const value = result as { structuredContent?: unknown };
  const envelope = z
    .object({ capture: captureMetadataSchema })
    .safeParse(value.structuredContent);
  if (!envelope.success) {
    throw new Error("screen_capture response omitted capture metadata");
  }
  return envelope.data.capture.byteLength;
}

async function directCapture(
  native: TracingNativeBridge,
  target: ReadyEvent["window"]["bounds"],
): Promise<number> {
  const status = helperStatusSchema.parse(
    await native.request<unknown>("health"),
  );
  const artifact = await native.request<unknown>("screen.capture", {
    target: { kind: "region", bounds: target },
    format: "png",
    scale: "logical",
    maxWidth: 720,
    includeCursor: false,
  });
  const consumed = await consumeCaptureArtifact(artifact, status.artifactRoot);
  return captureMetadataSchema.parse(consumed.metadata).byteLength;
}

async function prepareTrial(
  target: TargetProcess,
  native: TracingNativeBridge,
  neutralPoint: Point,
): Promise<void> {
  native.setCollector(undefined);
  await native.request("application.activate", {
    processId: target.ready.processId,
  });
  await native.request("mouse.move", { to: neutralPoint, durationMs: 0 });
  await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  await target.command({ type: "reset", requestId: randomUUID() });
}

async function runTrial(
  route: Route,
  repetition: number,
  workflow: SemanticWorkflow,
  target: TargetProcess,
  native: TracingNativeBridge,
  mcpClient: Client,
): Promise<SemanticBaselineTrial> {
  const collector = new TraceCollector();
  native.setCollector(collector);
  const actions = workflowActions(target.ready, workflow);
  let captureBytes = 0;
  let finalState: SemanticTargetState = target.ready.state;
  let failure: { code: string; message: string } | undefined;

  const callMcp = async (name: string, args: Record<string, unknown>) => {
    const result = await collector.record(
      "mcp",
      name,
      args,
      () => mcpClient.callTool({ name, arguments: args }),
      mcpSummary,
    );
    if (result.isError) throw new Error(`MCP tool '${name}' returned an error`);
    return result;
  };

  try {
    if (route === "oracle") {
      await native.request("application.activate", {
        processId: target.ready.processId,
      });
      captureBytes += await directCapture(native, target.ready.window.bounds);
      for (const action of actions) {
        const request = nativeAction(action);
        await native.request(request.method, request.params);
      }
    } else {
      await callMcp("application_activate", {
        processId: target.ready.processId,
      });
      const before = await callMcp("screen_capture", {
        target: { kind: "region", bounds: target.ready.window.bounds },
        format: "png",
        scale: "logical",
        maxWidth: 720,
        includeCursor: false,
      });
      captureBytes += captureBytesFromMcp(before);
      if (route === "primitive") {
        for (const action of actions) {
          const request = nativeAction(action);
          const toolName = request.method.replaceAll(".", "_");
          await callMcp(toolName, request.params);
        }
      } else {
        await callMcp("input_batch", {
          steps: actions.map(batchStep),
        });
      }
    }

    finalState = await waitForExpectedState(target, collector, workflow);
    if (route === "oracle") {
      captureBytes += await directCapture(native, target.ready.window.bounds);
    } else {
      const after = await callMcp("screen_capture", {
        target: { kind: "region", bounds: target.ready.window.bounds },
        format: "png",
        scale: "logical",
        maxWidth: 720,
        includeCursor: false,
      });
      captureBytes += captureBytesFromMcp(after);
    }
  } catch (error) {
    failure = errorValue(error);
    const requestId = randomUUID();
    finalState = await collector
      .record("target", "state_after_error", { requestId }, () =>
        target.command({ type: "state", requestId }),
      )
      .catch(() => finalState);
  }

  const passed =
    failure === undefined &&
    statesMatch(
      finalState,
      workflow.expectedFinalState,
      workflow.expectedActions,
    );
  const trial = {
    workflowId: workflow.id,
    route,
    repetition,
    passed,
    finalState,
    expectedFinalState: workflow.expectedFinalState,
    topLevelMcpCalls: collector.entries.filter(({ layer }) => layer === "mcp")
      .length,
    nativeRequests: collector.entries.filter(({ layer }) => layer === "native")
      .length,
    captures: collector.entries.filter(
      ({ layer, operation }) =>
        (layer === "mcp" && operation === "screen_capture") ||
        (route === "oracle" &&
          layer === "native" &&
          operation === "screen.capture"),
    ).length,
    captureBytes,
    inputEvents: finalState.receivedInputEventCount,
    durationMs: performance.now() - collector.startedAt,
    trace: [...collector.entries].sort(
      (left, right) => left.sequence - right.sequence,
    ),
    ...(failure === undefined ? {} : { error: failure }),
  };
  return semanticBaselineTrialSchema.parse(trial);
}

async function hashFile(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
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
  const nativeClient = new NativeClient({ executablePath: options.nativePath });
  const native = new TracingNativeBridge(nativeClient);
  const server = createServer(native);
  const mcpClient = new Client({
    name: "semantic-baseline-benchmark",
    version: "1.0.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  let target: TargetProcess | undefined;
  let originalCursor: Point | undefined;
  let shuttingDown = false;

  const cleanup = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    native.setCollector(undefined);
    await native.request("input.releaseAll").catch(() => undefined);
    if (originalCursor !== undefined) {
      await native
        .request("mouse.move", { to: originalCursor, durationMs: 0 })
        .catch(() => undefined);
    }
    await mcpClient.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    await native.close().catch(() => undefined);
    await stopTarget(target).catch(() => undefined);
  };
  const interrupt = () => void cleanup().finally(() => process.exit(130));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);

  try {
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    originalCursor = (
      await native.request<{ position: Point }>("mouse.position")
    ).position;
    target = await startTarget(options.targetPath);
    const neutralPoint = {
      x: target.ready.window.bounds.x + target.ready.window.bounds.width / 2,
      y: target.ready.window.bounds.y + target.ready.window.bounds.height - 28,
    };

    const trials: SemanticBaselineTrial[] = [];
    for (const route of options.routes) {
      for (const workflow of target.ready.workflows) {
        for (
          let repetition = 1;
          repetition <= options.repetitions;
          repetition += 1
        ) {
          process.stderr.write(
            `${route} ${workflow.id} ${repetition}/${options.repetitions}\n`,
          );
          await prepareTrial(target, native, neutralPoint);
          trials.push(
            await runTrial(
              route,
              repetition,
              workflow,
              target,
              native,
              mcpClient,
            ),
          );
        }
      }
    }

    const result = {
      schemaVersion: 1,
      completed: true,
      timestamp: new Date().toISOString(),
      environment: {
        platform: platform(),
        architecture: arch(),
        operatingSystemRelease: release(),
      },
      configuration: {
        routes: options.routes,
        repetitions: options.repetitions,
        capture: {
          target: "fixture-window-region",
          format: "png",
          scale: "logical",
          maxWidth: 720,
          includeCursor: false,
        },
        cloudBaseline: {
          status: "not_run",
          reason:
            "Scripted primitive calls are lower bounds, not an observed cloud-driver series",
          requiredPinnedFields: [
            "provider",
            "modelVersion",
            "systemPromptHash",
            "taskPromptHash",
            "toolSchemaHash",
            "samplingSettings",
            "contextPolicy",
          ],
        },
      },
      fixture: {
        schemaVersion: target.ready.schemaVersion,
        windowBounds: target.ready.window.bounds,
        controls: target.ready.controls,
        workflows: target.ready.workflows,
        sourceSha256: await hashFile(
          "native/Sources/SemanticWorkflowTestTarget/main.swift",
        ),
        harnessSha256: await hashFile("src/benchmarks/semantic-baseline.ts"),
      },
      trials,
      aggregates: aggregateSemanticBaseline(trials),
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
