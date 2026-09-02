/// <reference types="node" />

import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";

import type { CandidateVisionSelector } from "../src/semantic/lm-studio-candidate-selector.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { NativeBridge } from "../src/native/client.js";
import { NativeError } from "../src/native/protocol.js";
import { createServer } from "../src/server.js";
import { join } from "node:path";
import { tmpdir } from "node:os";

const status = {
  artifactRoot: "/tmp/computer-use-mcp/test-session",
  control: {
    inputEnabled: true,
    indicatorAvailable: true,
    state: "idle",
  },
  permissions: {
    accessibility: true,
    "post-event": true,
    "screen-capture": true,
  },
  process: {
    pid: 123,
  },
  system: {
    operatingSystemVersion: "Version 26.5.1",
    architecture: "arm64",
  },
};

const application = {
  processId: 123,
  bundleIdentifier: "com.microsoft.VSCode",
  name: "Code",
  bundlePath: "/Applications/Visual Studio Code.app",
  isActive: true,
  isHidden: false,
  activationPolicy: 0,
};

const mouseState = {
  position: { x: 100, y: 200 },
  heldButtons: [] as Array<"left" | "right" | "middle">,
};

const keyboardState = {
  heldKeys: [] as string[],
  heldModifiers: [] as string[],
};

const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01,
]);

const processInstanceId = `sha256:${"a".repeat(64)}`;

const accessibilityNode = {
  id: "n3",
  parentId: "n1",
  depth: 2,
  childIndex: 0,
  role: "AXButton",
  subrole: null,
  names: ["Submit workflow"],
  frame: { x: 100, y: 200, width: 120, height: 32 },
  actions: ["AXPress"],
  enabled: true,
  focused: false,
  selected: null,
  expanded: null,
  visible: true,
  valueType: "string",
  attributeStatus: { value: "secure_value_omitted" },
  fingerprint: `sha256:${"c".repeat(64)}`,
};

function accessibilityQuery(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    observationId: "observation-1",
    source: "accessibility",
    observedAtStart: "2026-07-22T10:00:00Z",
    observedAtEnd: "2026-07-22T10:00:00Z",
    application: {
      processId: application.processId,
      processInstanceId,
      bundleIdentifier: application.bundleIdentifier,
      launchDate: "2026-07-22T09:59:00Z",
    },
    consistency: "best_effort",
    completion: { status: "complete", reasons: [] },
    metrics: {
      durationMs: 4,
      nodesVisited: 8,
      nodesReturned: 8,
      axCalls: 100,
      errorsByCategory: {},
      serializedBytes: 1_000,
    },
    limits: {
      deadlineMs: 1_500,
      messageTimeoutMs: 100,
      maxDepth: 12,
      maxNodes: 1_000,
      maxChildren: 100,
      maxStringLength: 512,
      maxResultBytes: 1_048_576,
    },
    status: "found",
    matchCount: 1,
    matches: [accessibilityNode],
    matchesTruncated: false,
    ...overrides,
  };
}

function accessibilityWait(overrides: Record<string, unknown> = {}) {
  const observation = accessibilityQuery();
  return {
    schemaVersion: 1,
    status: "satisfied",
    startedAt: "2026-07-22T10:00:00Z",
    finishedAt: "2026-07-22T10:00:00Z",
    durationMs: 4,
    pollCount: 1,
    application: observation.application,
    observation,
    evaluations: [
      {
        index: 0,
        kind: "element",
        state: "appears",
        status: "satisfied",
        matchCount: 1,
        observedValue: true,
        reason: null,
      },
    ],
    reasons: [],
    ...overrides,
  };
}

function accessibilityFill(overrides: Record<string, unknown> = {}) {
  const observation = accessibilityQuery();
  return {
    schemaVersion: 1,
    outcome: "verified",
    phase: "complete",
    dispatchAttempted: true,
    dispatchAcknowledged: true,
    startedAt: "2026-07-22T10:00:00Z",
    finishedAt: "2026-07-22T10:00:01Z",
    durationMs: 12,
    application: observation.application,
    observation,
    fields: [
      {
        index: 0,
        target: {
          id: "n3",
          fingerprint: `sha256:${"c".repeat(64)}`,
          role: "AXTextField",
          subrole: null,
          names: ["Workflow text"],
          frame: { x: 100, y: 200, width: 120, height: 32 },
          actions: [],
          enabled: true,
          focused: true,
        },
        valueStatus: "verified",
        reason: null,
      },
    ],
    postcondition: {
      status: "satisfied",
      pollCount: 1,
      evaluations: [],
    },
    journal: [
      {
        phase: "dispatch_attempted",
        detail: "dispatch_boundary",
        at: "2026-07-22T10:00:00Z",
      },
    ],
    reasons: [],
    ...overrides,
  };
}

function accessibilityAct(overrides: Record<string, unknown> = {}) {
  const observation = accessibilityQuery();
  return {
    schemaVersion: 1,
    outcome: "verified",
    phase: "complete",
    action: "press",
    dispatchAttempted: true,
    dispatchAcknowledged: true,
    startedAt: "2026-07-22T10:00:00Z",
    finishedAt: "2026-07-22T10:00:01Z",
    durationMs: 12,
    application: observation.application,
    observation,
    target: {
      id: "n3",
      fingerprint: `sha256:${"c".repeat(64)}`,
      role: "AXButton",
      subrole: null,
      names: ["Submit workflow"],
      frame: { x: 100, y: 200, width: 120, height: 32 },
      actions: ["AXPress"],
      enabled: true,
      focused: false,
    },
    preconditionEvaluations: [],
    postcondition: {
      status: "satisfied",
      pollCount: 1,
      evaluations: [
        {
          index: 0,
          kind: "element",
          state: "appears",
          status: "satisfied",
          matchCount: 1,
          observedValue: true,
          reason: null,
        },
      ],
    },
    journal: [
      {
        phase: "dispatch_attempted",
        detail: "dispatch_boundary",
        at: "2026-07-22T10:00:00Z",
      },
    ],
    reasons: [],
    ...overrides,
  };
}

const window = {
  windowId: "456",
  title: "project — Code",
  bounds: { x: -1512, y: 879, width: 1512, height: 949 },
  isOnScreen: true,
  isActive: true,
  owningApplication: {
    processId: 123,
    bundleIdentifier: "com.microsoft.VSCode",
    name: "Code",
  },
};

interface NativeRequestRecord {
  method: string;
  params: Record<string, unknown>;
}

class StubNativeBridge implements NativeBridge {
  requests: NativeRequestRecord[] = [];
  responses: Record<
    string,
    unknown | ((params: Record<string, unknown>) => unknown | Promise<unknown>)
  > = {
    health: status,
    "display.list": {
      displays: [
        {
          displayId: "5",
          name: "Studio Display",
          bounds: { x: 0, y: 0, width: 5120, height: 1440 },
          pixelSize: { width: 5120, height: 1440 },
          pixelsPerPoint: { x: 1, y: 1 },
          isMain: true,
          coreGraphicsBoundsMatch: true,
        },
      ],
    },
    "application.list": { applications: [application] },
    "application.activate": { application, verified: true },
    "accessibility.query": accessibilityQuery(),
    "accessibility.wait": accessibilityWait(),
    "accessibility.act": accessibilityAct(),
    "accessibility.fill": accessibilityFill(),
    "window.list": { windows: [window] },
    "window.focus": {
      windowId: window.windowId,
      title: window.title,
      application: window.owningApplication,
      raiseResult: 0,
      verified: true,
    },
    "mouse.position": mouseState,
    "mouse.move": mouseState,
    "mouse.button": { ...mouseState, heldButtons: ["left"] },
    "mouse.click": mouseState,
    "mouse.drag": mouseState,
    "mouse.scroll": mouseState,
    "keyboard.type": keyboardState,
    "keyboard.key": keyboardState,
    "keyboard.shortcut": keyboardState,
    "input.releaseAll": {
      ...mouseState,
      ...keyboardState,
      releasedButtons: ["left"],
      releasedKeys: ["a"],
      releasedModifiers: ["command"],
    },
    "input.batch": {
      completed: true,
      completedCount: 2,
      results: [
        { index: 0, type: "wait", result: { waitedMs: 0 } },
        { index: 1, type: "keyboard_key", result: keyboardState },
      ],
    },
  };

  async request<T>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    this.requests.push({ method, params });
    const response = this.responses[method];
    return (
      typeof response === "function" ? await response(params) : response
    ) as T;
  }

  async close(): Promise<void> {}
}

interface TestContext {
  native: StubNativeBridge;
  client: Client;
}

const cleanup: Array<() => Promise<void>> = [];

async function createArtifactRoot(): Promise<string> {
  const base = join(tmpdir(), "computer-use-mcp");
  await mkdir(base, { recursive: true, mode: 0o700 });
  await chmod(base, 0o700);
  const root = await mkdtemp(join(base, "server-test-"));
  await chmod(root, 0o700);
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function createCaptureArtifact(
  root: string,
  overrides: Record<string, unknown> = {},
) {
  const artifactPath = join(root, `${randomUUID()}.png`);
  await writeFile(artifactPath, pngBytes, { mode: 0o600 });
  await chmod(artifactPath, 0o600);
  return {
    captureId: randomUUID(),
    artifactRoot: root,
    artifactPath,
    byteLength: pngBytes.length,
    target: { kind: "window", windowId: "456" },
    mimeType: "image/png",
    nativePixelSize: { width: 100, height: 100 },
    outputPixelSize: { width: 100, height: 100 },
    mapping: {
      kind: "linear",
      imageContentBounds: { x: 0, y: 0, width: 100, height: 100 },
      screenBounds: { x: 0, y: 0, width: 100, height: 100 },
      pixelsPerPoint: { x: 1, y: 1 },
    },
    sha256: createHash("sha256").update(pngBytes).digest("hex"),
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

async function createTestContext(
  candidateVisionSelector?: CandidateVisionSelector,
): Promise<TestContext> {
  const native = new StubNativeBridge();
  const server = createServer(native, candidateVisionSelector);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(
    async () => client.close(),
    async () => server.close(),
  );
  return { native, client };
}

describe("MCP tools", () => {
  it("registers the status and discovery tool surface", async () => {
    const { client } = await createTestContext();
    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "application_activate",
      "application_list",
      "computer_status",
      "display_list",
      "input_batch",
      "input_release_all",
      "keyboard_key",
      "keyboard_shortcut",
      "keyboard_type",
      "mouse_button",
      "mouse_click",
      "mouse_drag",
      "mouse_move",
      "mouse_position",
      "mouse_scroll",
      "screen_capture",
      "ui_act",
      "ui_fill",
      "ui_query",
      "ui_wait",
      "ui_workflow",
      "window_focus",
      "window_list",
    ]);
    const statusTool = tools.tools.find(
      (tool) => tool.name === "computer_status",
    );
    expect(statusTool?.description).toContain("input");
    expect(statusTool?.description).toContain("activity-indicator");
  });

  it("returns structured computer status", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "computer_status",
      arguments: {},
    });

    expect(result.isError).not.toBe(true);
    const { artifactRoot: _artifactRoot, ...visibleStatus } = status;
    expect(result.structuredContent).toEqual(visibleStatus);
    expect(result.structuredContent).toMatchObject({
      control: {
        inputEnabled: true,
        indicatorAvailable: true,
        state: "idle",
      },
    });
    expect(native.requests).toEqual([{ method: "health", params: {} }]);
  });

  it("rejects computer status without control state", async () => {
    const { client, native } = await createTestContext();
    const { control: _control, ...statusWithoutControl } = status;
    native.responses.health = statusWithoutControl;

    const result = await client.callTool({
      name: "computer_status",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(native.requests).toEqual([{ method: "health", params: {} }]);
  });

  it("lists displays", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "display_list",
      arguments: {},
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      displays: [{ displayId: "5" }],
    });
    expect(native.requests).toEqual([{ method: "display.list", params: {} }]);
  });

  it("applies application-list defaults", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "application_list",
      arguments: {},
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ applications: [application] });
    expect(native.requests).toEqual([
      { method: "application.list", params: { includeBackground: false } },
    ]);
  });

  it("forwards includeBackground to application listing", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "application_list",
      arguments: { includeBackground: true },
    });

    expect(result.isError).not.toBe(true);
    expect(native.requests).toEqual([
      { method: "application.list", params: { includeBackground: true } },
    ]);
  });

  it("activates an application using exactly one selector", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "application_activate",
      arguments: { bundleIdentifier: "com.microsoft.VSCode" },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ application, verified: true });
    expect(native.requests).toEqual([
      {
        method: "application.activate",
        params: { bundleIdentifier: "com.microsoft.VSCode" },
      },
    ]);
  });

  it("rejects ambiguous application selectors before native execution", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "application_activate",
      arguments: {
        processId: 123,
        bundleIdentifier: "com.microsoft.VSCode",
      },
    });

    expect(result.isError).toBe(true);
    expect(native.requests).toEqual([]);
  });

  it("applies window-list defaults and optional app filters", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "window_list",
      arguments: { bundleIdentifier: "com.microsoft.VSCode" },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ windows: [window] });
    expect(native.requests).toEqual([
      {
        method: "window.list",
        params: {
          bundleIdentifier: "com.microsoft.VSCode",
          onScreenOnly: true,
          includeUntitled: false,
        },
      },
    ]);
  });

  it("returns a compact semantic UI query with process identity", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "ui_query",
      arguments: {
        scope: { bundleIdentifier: application.bundleIdentifier },
        target: {
          roles: ["AXButton"],
          name: "Submit workflow",
          requiredActions: ["AXPress"],
          enabled: true,
        },
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      schemaVersion: 1,
      status: "found",
      applicationMatchCount: 1,
      scope: {
        application: {
          processId: application.processId,
          processInstanceId,
          bundleIdentifier: application.bundleIdentifier,
        },
      },
      observation: { observationId: "observation-1" },
      matchCount: 1,
      candidates: [
        {
          id: "n3",
          fingerprint: `sha256:${"c".repeat(64)}`,
          role: "AXButton",
          names: ["Submit workflow"],
          actions: ["AXPress"],
        },
      ],
      candidatesTruncated: false,
      reasons: [],
    });
    expect(result.structuredContent).not.toHaveProperty(
      "candidates.0.valueType",
    );
    expect(result.structuredContent).not.toHaveProperty(
      "candidates.0.attributeStatus",
    );
    expect(native.requests).toEqual([
      { method: "application.list", params: { includeBackground: true } },
      {
        method: "accessibility.query",
        params: {
          processId: application.processId,
          expectedBundleIdentifier: application.bundleIdentifier,
          contentPolicy: "matched",
          predicate: {
            roles: ["AXButton"],
            name: "Submit workflow",
            nameMatch: "normalized",
            requiredActions: ["AXPress"],
            enabled: true,
          },
          maxMatches: 20,
        },
      },
    ]);
  });

  it("does not invoke AX for missing or ambiguous application scope", async () => {
    const missing = await createTestContext();
    const missingResult = await missing.client.callTool({
      name: "ui_query",
      arguments: {
        scope: { bundleIdentifier: "com.example.missing" },
        target: { name: "Submit" },
      },
    });
    expect(missingResult.isError).not.toBe(true);
    expect(missingResult.structuredContent).toMatchObject({
      status: "not_found",
      applicationMatchCount: 0,
      scope: null,
      observation: null,
      reasons: ["application_not_found"],
    });
    expect(missing.native.requests).toEqual([
      { method: "application.list", params: { includeBackground: true } },
    ]);

    const ambiguous = await createTestContext();
    ambiguous.native.responses["application.list"] = {
      applications: [
        application,
        { ...application, processId: application.processId + 1 },
      ],
    };
    const ambiguousResult = await ambiguous.client.callTool({
      name: "ui_query",
      arguments: {
        scope: { bundleIdentifier: application.bundleIdentifier },
        target: { name: "Submit" },
      },
    });
    expect(ambiguousResult.isError).not.toBe(true);
    expect(ambiguousResult.structuredContent).toMatchObject({
      status: "ambiguous",
      applicationMatchCount: 2,
      reasons: ["application_ambiguous"],
    });
    expect(ambiguous.native.requests).toEqual([
      { method: "application.list", params: { includeBackground: true } },
    ]);
  });

  it("maps incomplete AX traversal to uncertain and bounds candidates", async () => {
    const { client, native } = await createTestContext();
    native.responses["accessibility.query"] = accessibilityQuery({
      completion: { status: "partial", reasons: ["node_limit"] },
      status: "incomplete",
      matchCount: 2,
      matches: [accessibilityNode],
      matchesTruncated: true,
    });

    const result = await client.callTool({
      name: "ui_query",
      arguments: {
        scope: { processId: application.processId },
        target: { roles: ["AXButton"] },
        maxCandidates: 1,
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "uncertain",
      matchCount: 2,
      candidates: [{ id: "n3" }],
      candidatesTruncated: true,
      reasons: ["node_limit", "candidate_limit"],
    });
  });

  it("waits for a semantic element condition without input or capture", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "ui_wait",
      arguments: {
        scope: { processId: application.processId },
        condition: {
          kind: "element",
          target: { name: "Submit workflow" },
          state: "appears",
        },
        timeoutMs: 500,
        pollIntervalMs: 50,
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      schemaVersion: 1,
      status: "satisfied",
      applicationMatchCount: 1,
      scope: {
        application: {
          processId: application.processId,
          processInstanceId,
          bundleIdentifier: application.bundleIdentifier,
        },
      },
      pollCount: 1,
      evaluations: [
        {
          index: 0,
          kind: "element",
          state: "appears",
          status: "satisfied",
          matchCount: 1,
        },
      ],
      reasons: [],
    });
    expect(native.requests).toEqual([
      { method: "application.list", params: { includeBackground: true } },
      {
        method: "accessibility.wait",
        params: {
          processId: application.processId,
          expectedBundleIdentifier: application.bundleIdentifier,
          contentPolicy: "redacted",
          condition: {
            kind: "element",
            target: {
              name: "Submit workflow",
              nameMatch: "normalized",
            },
            state: "appears",
          },
          timeoutMs: 500,
          pollIntervalMs: 50,
        },
      },
    ]);
  });

  it("preserves timed-out and uncertain native wait outcomes", async () => {
    const timedOut = await createTestContext();
    timedOut.native.responses["accessibility.wait"] = accessibilityWait({
      status: "timed_out",
      durationMs: 50,
      evaluations: [
        {
          index: 0,
          kind: "element",
          state: "disappears",
          status: "unsatisfied",
          matchCount: 1,
          observedValue: true,
          reason: null,
        },
      ],
      reasons: ["timeout"],
    });
    const timedOutResult = await timedOut.client.callTool({
      name: "ui_wait",
      arguments: {
        scope: { processId: application.processId },
        condition: {
          kind: "element",
          target: { name: "Submit workflow" },
          state: "disappears",
        },
        timeoutMs: 0,
      },
    });
    expect(timedOutResult.isError).not.toBe(true);
    expect(timedOutResult.structuredContent).toMatchObject({
      status: "timed_out",
      reasons: ["timeout"],
    });

    const uncertain = await createTestContext();
    uncertain.native.responses["accessibility.wait"] = accessibilityWait({
      status: "uncertain",
      observation: {
        ...accessibilityQuery(),
        completion: { status: "partial", reasons: ["node_limit"] },
      },
      evaluations: [],
      reasons: ["node_limit"],
    });
    const uncertainResult = await uncertain.client.callTool({
      name: "ui_wait",
      arguments: {
        scope: { processId: application.processId },
        condition: {
          kind: "window",
          state: "appears",
        },
      },
    });
    expect(uncertainResult.isError).not.toBe(true);
    expect(uncertainResult.structuredContent).toMatchObject({
      status: "uncertain",
      evaluations: [],
      reasons: ["node_limit"],
    });
  });

  it("runs bounded semantic workflow steps in order", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "ui_workflow",
      arguments: {
        scope: { processId: application.processId },
        timeoutMs: 20_000,
        steps: [
          {
            kind: "fill",
            fields: [{ target: { roles: ["AXTextField"] }, value: "private" }],
            postcondition: { kind: "window", state: "appears" },
          },
          {
            kind: "act",
            target: { roles: ["AXButton"], name: "Submit workflow" },
            action: "press",
            postcondition: { kind: "window", state: "appears" },
          },
          {
            kind: "wait",
            condition: { kind: "window", state: "appears" },
          },
        ],
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      outcome: "verified",
      completedStepCount: 3,
      stoppedAtStep: null,
      steps: [
        { index: 0, kind: "fill", status: "verified" },
        { index: 1, kind: "act", status: "verified" },
        { index: 2, kind: "wait", status: "satisfied" },
      ],
    });
    expect(native.requests.map(({ method }) => method)).toEqual([
      "application.list",
      "accessibility.fill",
      "accessibility.act",
      "accessibility.wait",
    ]);
  });

  it("rejects oversized workflow fill values before native execution", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "ui_workflow",
      arguments: {
        scope: { processId: application.processId },
        steps: [
          {
            kind: "fill",
            fields: [
              { target: { roles: ["AXTextField"] }, value: "a".repeat(4096) },
              {
                target: { roles: ["AXTextField"], name: "Second" },
                value: "b".repeat(4096),
              },
              { target: { roles: ["AXTextField"], name: "Third" }, value: "c" },
            ],
            postcondition: { kind: "window", state: "appears" },
          },
        ],
      },
    });
    expect(result.isError).toBe(true);
    expect(native.requests).toEqual([]);
  });

  it("stops a workflow immediately after a non-successful transaction", async () => {
    const { client, native } = await createTestContext();
    native.responses["accessibility.act"] = accessibilityAct({
      outcome: "not_dispatched",
      phase: "pre_dispatch",
      dispatchAttempted: false,
      dispatchAcknowledged: false,
      target: null,
      postcondition: { status: "not_evaluated", pollCount: 0, evaluations: [] },
      journal: [],
      reasons: ["target_disabled"],
    });
    const result = await client.callTool({
      name: "ui_workflow",
      arguments: {
        scope: { processId: application.processId },
        steps: [
          {
            kind: "act",
            target: { roles: ["AXButton"] },
            action: "press",
            postcondition: { kind: "window", state: "appears" },
          },
          { kind: "wait", condition: { kind: "window", state: "appears" } },
        ],
      },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      outcome: "not_dispatched",
      completedStepCount: 0,
      stoppedAtStep: 0,
      steps: [{ status: "not_dispatched", reasons: ["target_disabled"] }],
    });
    expect(native.requests.map(({ method }) => method)).toEqual([
      "application.list",
      "accessibility.act",
    ]);
  });

  it("fills verified AX fields without returning their values", async () => {
    const { client, native } = await createTestContext();
    const secret = "Project Alpha ready";
    const result = await client.callTool({
      name: "ui_fill",
      arguments: {
        scope: { processId: application.processId },
        fields: [
          {
            target: { roles: ["AXTextField"], name: "Workflow text" },
            value: secret,
          },
        ],
        postcondition: {
          kind: "element",
          target: { name: "Submitted" },
          state: "appears",
        },
      },
    });

    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.structuredContent)).not.toContain(secret);
    expect(result.structuredContent).toMatchObject({
      outcome: "verified",
      fields: [{ index: 0, valueStatus: "verified", reason: null }],
      postcondition: { status: "satisfied" },
    });
    expect(native.requests).toEqual([
      { method: "application.list", params: { includeBackground: true } },
      {
        method: "accessibility.fill",
        params: {
          processId: application.processId,
          expectedBundleIdentifier: application.bundleIdentifier,
          contentPolicy: "redacted",
          fields: [
            {
              target: {
                roles: ["AXTextField"],
                name: "Workflow text",
                nameMatch: "normalized",
              },
              value: secret,
            },
          ],
          postcondition: {
            kind: "element",
            target: { name: "Submitted", nameMatch: "normalized" },
            state: "appears",
          },
          verificationTimeoutMs: 3000,
          pollIntervalMs: 150,
        },
      },
    ]);
  });

  it("preserves post-dispatch ui_fill identity loss as indeterminate", async () => {
    const { client, native } = await createTestContext();
    native.responses["accessibility.fill"] = accessibilityFill({
      application: {
        ...accessibilityQuery().application,
        processId: 999,
      },
      outcome: "indeterminate",
      phase: "verifying",
      dispatchAttempted: true,
      fields: [
        {
          ...accessibilityFill().fields[0],
          valueStatus: "uncertain",
          reason: "verification_observation_failed",
        },
      ],
      postcondition: { status: "uncertain", pollCount: 0, evaluations: [] },
      reasons: ["verification_observation_failed"],
    });
    const result = await client.callTool({
      name: "ui_fill",
      arguments: {
        scope: { processId: application.processId },
        fields: [{ target: { roles: ["AXTextField"] }, value: "private" }],
        postcondition: { kind: "window", state: "appears" },
      },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      outcome: "indeterminate",
      dispatchAttempted: true,
      reasons: ["application_changed"],
    });
  });

  it("rejects malformed ui_fill requests before native execution", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "ui_fill",
      arguments: {
        scope: { processId: application.processId },
        fields: [],
        postcondition: { kind: "window", state: "appears" },
      },
    });
    expect(result.isError).toBe(true);
    expect(native.requests).toEqual([]);
  });

  it("performs a verified AX action through one native transaction", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "ui_act",
      arguments: {
        scope: { processId: application.processId },
        target: { roles: ["AXButton"], name: "Submit workflow" },
        action: "press",
        postcondition: {
          kind: "element",
          target: { name: "Submitted" },
          state: "appears",
        },
        verificationTimeoutMs: 500,
        pollIntervalMs: 50,
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      schemaVersion: 1,
      outcome: "verified",
      phase: "complete",
      action: "press",
      dispatchAttempted: true,
      dispatchAcknowledged: true,
      applicationMatchCount: 1,
      scope: {
        application: { processId: application.processId, processInstanceId },
      },
      postcondition: { status: "satisfied", pollCount: 1 },
      reasons: [],
    });
    expect(native.requests).toEqual([
      { method: "application.list", params: { includeBackground: true } },
      {
        method: "accessibility.act",
        params: {
          processId: application.processId,
          expectedBundleIdentifier: application.bundleIdentifier,
          contentPolicy: "redacted",
          target: {
            roles: ["AXButton"],
            name: "Submit workflow",
            nameMatch: "normalized",
          },
          action: "press",
          postcondition: {
            kind: "element",
            target: { name: "Submitted", nameMatch: "normalized" },
            state: "appears",
          },
          verificationTimeoutMs: 500,
          pollIntervalMs: 50,
        },
      },
    ]);
  });

  it("selects one ambiguous AX candidate through local vision before the native transaction", async () => {
    const selector: CandidateVisionSelector = {
      select: async ({ candidates }) => ({
        status: "found",
        clickEligible: true,
        selectedAxCandidateIds: [candidates[1]!.id],
        viewCount: 2,
        expectedViewCount: 2,
        captureObservedAt: "2026-09-02T02:00:00Z",
        model: "qwen/qwen3-vl-8b",
        durationMs: 10,
        rejectionReasons: [],
      }),
    };
    const { client, native } = await createTestContext(selector);
    const root = await createArtifactRoot();
    native.responses.health = { ...status, artifactRoot: root };
    native.responses["accessibility.query"] = () => {
      const observedAt = new Date().toISOString();
      return accessibilityQuery({
        observedAtStart: observedAt,
        observedAtEnd: observedAt,
        status: "ambiguous",
        matchCount: 2,
        matches: [
          accessibilityNode,
          {
            ...accessibilityNode,
            id: "n4",
            fingerprint: `sha256:${"d".repeat(64)}`,
            frame: { x: 300, y: 200, width: 120, height: 32 },
          },
        ],
      });
    };
    native.responses["screen.capture"] = await createCaptureArtifact(root, {
      target: { kind: "display", displayId: "5" },
      outputPixelSize: { width: 5120, height: 1440 },
      mapping: {
        kind: "linear",
        imageContentBounds: { x: 0, y: 0, width: 5120, height: 1440 },
        screenBounds: { x: 0, y: 0, width: 5120, height: 1440 },
        pixelsPerPoint: { x: 1, y: 1 },
      },
    });

    const result = await client.callTool({
      name: "ui_act",
      arguments: {
        scope: { processId: application.processId },
        target: { roles: ["AXButton"] },
        action: "press",
        fallback: "candidate_vision",
        visionTargetDescription: "the Save button for Project Alpha",
        postcondition: { kind: "window", state: "appears" },
      },
    });

    expect(result.isError).not.toBe(true);
    expect(native.requests.map(({ method }) => method)).toEqual([
      "application.list",
      "accessibility.query",
      "display.list",
      "health",
      "screen.capture",
      "accessibility.query",
      "accessibility.act",
    ]);
    expect(native.requests.at(-1)).toMatchObject({
      method: "accessibility.act",
      params: { selectedTargetFingerprint: `sha256:${"d".repeat(64)}` },
    });
  });

  it("keeps a unique AX action model-free when candidate vision is requested", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "ui_act",
      arguments: {
        scope: { processId: application.processId },
        target: { roles: ["AXButton"], name: "Submit workflow" },
        action: "press",
        fallback: "candidate_vision",
        visionTargetDescription: "the Submit workflow button",
        postcondition: { kind: "window", state: "appears" },
      },
    });

    expect(result.isError).not.toBe(true);
    expect(native.requests.map(({ method }) => method)).toEqual([
      "application.list",
      "accessibility.query",
      "accessibility.act",
    ]);
    expect(native.requests.at(-1)?.params).not.toHaveProperty(
      "selectedTargetFingerprint",
    );
  });

  it("abstains before dispatch when candidate vision is disabled, uncertain, or truncated", async () => {
    const { client, native } = await createTestContext();
    native.responses["accessibility.query"] = accessibilityQuery({
      status: "ambiguous",
      matchCount: 2,
      matches: [
        accessibilityNode,
        {
          ...accessibilityNode,
          id: "n4",
          fingerprint: `sha256:${"d".repeat(64)}`,
        },
      ],
    });

    const result = await client.callTool({
      name: "ui_act",
      arguments: {
        scope: { processId: application.processId },
        target: { roles: ["AXButton"] },
        action: "press",
        fallback: "candidate_vision",
        visionTargetDescription: "the Save button for Project Alpha",
        postcondition: { kind: "window", state: "appears" },
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      outcome: "not_dispatched",
      reasons: ["candidate_vision_unavailable"],
    });
    expect(native.requests.map(({ method }) => method)).toEqual([
      "application.list",
      "accessibility.query",
    ]);

    const truncated = await createTestContext({
      select: async () => {
        throw new Error("must not call selector for truncated candidates");
      },
    });
    truncated.native.responses["accessibility.query"] = accessibilityQuery({
      status: "ambiguous",
      matchCount: 33,
      matchesTruncated: true,
      matches: [accessibilityNode],
    });
    const truncatedResult = await truncated.client.callTool({
      name: "ui_act",
      arguments: {
        scope: { processId: application.processId },
        target: { roles: ["AXButton"] },
        action: "press",
        fallback: "candidate_vision",
        visionTargetDescription: "the Save button for Project Alpha",
        postcondition: { kind: "window", state: "appears" },
      },
    });
    expect(truncatedResult.structuredContent).toMatchObject({
      outcome: "not_dispatched",
      reasons: ["candidate_vision_candidates_truncated"],
    });
    expect(truncated.native.requests.map(({ method }) => method)).toEqual([
      "application.list",
      "accessibility.query",
    ]);
  });

  it("preserves not_dispatched and indeterminate action outcomes as errors", async () => {
    const notDispatched = await createTestContext();
    notDispatched.native.responses["accessibility.act"] = accessibilityAct({
      outcome: "not_dispatched",
      phase: "pre_dispatch",
      dispatchAttempted: false,
      dispatchAcknowledged: false,
      target: null,
      postcondition: {
        status: "not_evaluated",
        pollCount: 0,
        evaluations: [],
      },
      journal: [],
      reasons: ["target_ambiguous"],
    });
    const notDispatchedResult = await notDispatched.client.callTool({
      name: "ui_act",
      arguments: {
        scope: { processId: application.processId },
        target: { roles: ["AXButton"] },
        action: "press",
        postcondition: { kind: "window", state: "appears" },
      },
    });
    expect(notDispatchedResult.isError).toBe(true);
    expect(notDispatchedResult.structuredContent).toMatchObject({
      outcome: "not_dispatched",
      phase: "pre_dispatch",
      dispatchAttempted: false,
      reasons: ["target_ambiguous"],
    });

    const indeterminate = await createTestContext();
    indeterminate.native.responses["accessibility.act"] = accessibilityAct({
      outcome: "indeterminate",
      phase: "verifying",
      postcondition: {
        status: "unsatisfied",
        pollCount: 3,
        evaluations: [
          {
            index: 0,
            kind: "element",
            state: "appears",
            status: "unsatisfied",
            matchCount: 0,
            observedValue: false,
            reason: null,
          },
        ],
      },
      reasons: ["postcondition_unsatisfied"],
    });
    const indeterminateResult = await indeterminate.client.callTool({
      name: "ui_act",
      arguments: {
        scope: { processId: application.processId },
        target: { roles: ["AXButton"] },
        action: "press",
        postcondition: { kind: "window", state: "appears" },
      },
    });
    expect(indeterminateResult.isError).toBe(true);
    expect(indeterminateResult.structuredContent).toMatchObject({
      outcome: "indeterminate",
      phase: "verifying",
      dispatchAttempted: true,
      dispatchAcknowledged: true,
      reasons: ["postcondition_unsatisfied"],
    });
  });

  it("maps post-submission helper loss to indeterminate without retrying", async () => {
    const { client, native } = await createTestContext();
    let actCalls = 0;
    native.responses["accessibility.act"] = () => {
      actCalls += 1;
      throw new NativeError("timeout", "Native request timed out");
    };

    const result = await client.callTool({
      name: "ui_act",
      arguments: {
        scope: { processId: application.processId },
        target: { roles: ["AXButton"] },
        action: "press",
        postcondition: { kind: "window", state: "appears" },
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      outcome: "indeterminate",
      phase: "dispatch_attempted",
      dispatchAttempted: true,
      dispatchAcknowledged: false,
      reasons: ["native_timeout"],
    });
    expect(actCalls).toBe(1);
  });

  it("rejects unsupported ui_act actions before native execution", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "ui_act",
      arguments: {
        scope: { processId: application.processId },
        target: { roles: ["AXButton"] },
        action: "double_click",
        postcondition: { kind: "window", state: "appears" },
      },
    });

    expect(result.isError).toBe(true);
    expect(native.requests).toEqual([]);
  });

  it("maps ui_wait identity mismatch to structured application_changed", async () => {
    const { client, native } = await createTestContext();
    native.responses["accessibility.wait"] = accessibilityWait({
      application: {
        ...accessibilityQuery().application,
        processId: application.processId + 1,
      },
      observation: null,
      status: "uncertain",
      evaluations: [],
      reasons: ["process_identity_changed"],
    });

    const result = await client.callTool({
      name: "ui_wait",
      arguments: {
        scope: { processId: application.processId },
        condition: { kind: "window", state: "appears" },
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "uncertain",
      applicationMatchCount: 0,
      scope: null,
      observation: null,
      reasons: ["application_changed"],
    });
  });

  it("returns uncertain without AX for missing or ambiguous ui_wait scope", async () => {
    const missing = await createTestContext();
    const missingResult = await missing.client.callTool({
      name: "ui_wait",
      arguments: {
        scope: { bundleIdentifier: "com.example.missing" },
        condition: { kind: "window", state: "appears" },
      },
    });
    expect(missingResult.isError).not.toBe(true);
    expect(missingResult.structuredContent).toMatchObject({
      status: "uncertain",
      applicationMatchCount: 0,
      scope: null,
      pollCount: 0,
      reasons: ["application_not_found"],
    });
    expect(missing.native.requests).toEqual([
      { method: "application.list", params: { includeBackground: true } },
    ]);

    const ambiguous = await createTestContext();
    ambiguous.native.responses["application.list"] = {
      applications: [
        application,
        { ...application, processId: application.processId + 1 },
      ],
    };
    const ambiguousResult = await ambiguous.client.callTool({
      name: "ui_wait",
      arguments: {
        scope: { bundleIdentifier: application.bundleIdentifier },
        condition: { kind: "window", state: "appears" },
      },
    });
    expect(ambiguousResult.isError).not.toBe(true);
    expect(ambiguousResult.structuredContent).toMatchObject({
      status: "uncertain",
      applicationMatchCount: 2,
      reasons: ["application_ambiguous"],
    });
  });

  it("rejects invalid ui_wait conditions before native execution", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "ui_wait",
      arguments: {
        scope: { processId: application.processId },
        condition: {
          kind: "element",
          target: { name: "Submit workflow" },
          state: "focused",
        },
      },
    });

    expect(result.isError).toBe(true);
    expect(native.requests).toEqual([]);
  });

  it("rejects invalid ui_query scope before native execution", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "ui_query",
      arguments: {
        scope: {
          processId: application.processId,
          bundleIdentifier: application.bundleIdentifier,
        },
        target: { name: "Submit" },
      },
    });

    expect(result.isError).toBe(true);
    expect(native.requests).toEqual([]);
  });

  it("rejects non-numeric window IDs before native execution", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "window_focus",
      arguments: { windowId: "not-a-window" },
    });

    expect(result.isError).toBe(true);
    expect(native.requests).toEqual([]);
  });

  it("focuses a window by opaque session ID", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "window_focus",
      arguments: { windowId: "456" },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      windowId: "456",
      verified: true,
    });
    expect(native.requests).toEqual([
      { method: "window.focus", params: { windowId: "456" } },
    ]);
  });

  it("returns mouse position without parameters", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "mouse_position",
      arguments: {},
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(mouseState);
    expect(native.requests).toEqual([{ method: "mouse.position", params: {} }]);
  });

  it("applies mouse move defaults", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "mouse_move",
      arguments: { to: { x: 100, y: 200 } },
    });

    expect(result.isError).not.toBe(true);
    expect(native.requests).toEqual([
      {
        method: "mouse.move",
        params: { to: { x: 100, y: 200 }, durationMs: 0 },
      },
    ]);
  });

  it("tracks explicit mouse button state", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "mouse_button",
      arguments: { action: "down", point: { x: 100, y: 200 } },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      position: mouseState.position,
      heldButtons: ["left"],
    });
    expect(native.requests).toEqual([
      {
        method: "mouse.button",
        params: {
          action: "down",
          button: "left",
          point: { x: 100, y: 200 },
        },
      },
    ]);
  });

  it("applies click and drag defaults", async () => {
    const { client, native } = await createTestContext();
    await client.callTool({
      name: "mouse_click",
      arguments: { point: { x: 100, y: 200 } },
    });
    await client.callTool({
      name: "mouse_drag",
      arguments: { to: { x: 120, y: 220 } },
    });

    expect(native.requests).toEqual([
      {
        method: "mouse.click",
        params: {
          button: "left",
          point: { x: 100, y: 200 },
          count: 1,
          intervalMs: 100,
        },
      },
      {
        method: "mouse.drag",
        params: {
          button: "left",
          to: { x: 120, y: 220 },
          durationMs: 500,
        },
      },
    ]);
  });

  it("forwards signed pixel scroll deltas", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "mouse_scroll",
      arguments: { deltaX: -25, deltaY: 50, unit: "pixel" },
    });

    expect(result.isError).not.toBe(true);
    expect(native.requests).toEqual([
      {
        method: "mouse.scroll",
        params: { deltaX: -25, deltaY: 50, unit: "pixel" },
      },
    ]);
  });

  it("rejects invalid mouse inputs before native execution", async () => {
    const { client, native } = await createTestContext();
    const invalidCount = await client.callTool({
      name: "mouse_click",
      arguments: { count: 4 },
    });
    const incompletePoint = await client.callTool({
      name: "mouse_move",
      arguments: { to: { x: 100 } },
    });
    const zeroScroll = await client.callTool({
      name: "mouse_scroll",
      arguments: {},
    });

    expect(invalidCount.isError).toBe(true);
    expect(incompletePoint.isError).toBe(true);
    expect(zeroScroll.isError).toBe(true);
    expect(native.requests).toEqual([]);
  });

  it("types Unicode text and applies defaults", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "keyboard_type",
      arguments: { text: "Hello, 世界 👋" },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(keyboardState);
    expect(native.requests).toEqual([
      {
        method: "keyboard.type",
        params: { text: "Hello, 世界 👋", intervalMs: 0 },
      },
    ]);
  });

  it("returns a post-action capture image without exposing artifact paths", async () => {
    const root = await createArtifactRoot();
    const { client, native } = await createTestContext();
    native.responses.health = { ...status, artifactRoot: root };
    native.responses["keyboard.type"] = async () => ({
      interaction: keyboardState,
      capture: await createCaptureArtifact(root),
    });

    const result = await client.callTool({
      name: "keyboard_type",
      arguments: {
        text: "verified",
        captureAfter: {
          target: { kind: "window", windowId: "456" },
          maxWidth: 640,
        },
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      interaction: keyboardState,
      capture: {
        target: { kind: "window", windowId: "456" },
        byteLength: pngBytes.length,
      },
    });
    expect(result.structuredContent).not.toHaveProperty("capture.artifactRoot");
    expect(result.structuredContent).not.toHaveProperty("capture.artifactPath");
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "image",
          data: pngBytes.toString("base64"),
          mimeType: "image/png",
        }),
      ]),
    );
    expect(native.requests).toEqual([
      { method: "health", params: {} },
      {
        method: "keyboard.type",
        params: {
          text: "verified",
          intervalMs: 0,
          captureAfter: {
            target: { kind: "window", windowId: "456" },
            format: "jpeg",
            scale: "logical",
            maxWidth: 640,
            includeCursor: false,
            settleMs: 100,
          },
        },
      },
    ]);
  });

  it("consumes a capture artifact before rejecting malformed interaction data", async () => {
    const root = await createArtifactRoot();
    const { client, native } = await createTestContext();
    const artifact = await createCaptureArtifact(root);
    native.responses.health = { ...status, artifactRoot: root };
    native.responses["keyboard.type"] = {
      interaction: { heldKeys: "invalid", heldModifiers: [] },
      capture: artifact,
    };

    const result = await client.callTool({
      name: "keyboard_type",
      arguments: {
        text: "once",
        captureAfter: {
          target: { kind: "window", windowId: "456" },
          settleMs: 0,
        },
      },
    });

    expect(result.isError).toBe(true);
    await expect(access(artifact.artifactPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves a successful interaction when artifact validation fails", async () => {
    const root = await createArtifactRoot();
    const { client, native } = await createTestContext();
    native.responses.health = { ...status, artifactRoot: root };
    native.responses["keyboard.type"] = async () => ({
      interaction: keyboardState,
      capture: await createCaptureArtifact(root, { sha256: "0".repeat(64) }),
    });

    const result = await client.callTool({
      name: "keyboard_type",
      arguments: {
        text: "once",
        captureAfter: {
          target: { kind: "window", windowId: "456" },
          settleMs: 0,
        },
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      interaction: keyboardState,
      captureError: {
        code: "native_unavailable",
        message: expect.any(String),
      },
    });
    expect(result.structuredContent).not.toHaveProperty("capture");
    expect(result.content).toHaveLength(1);
    expect(
      native.requests.filter(({ method }) => method === "keyboard.type"),
    ).toHaveLength(1);
  });

  it("forwards key presses and ordered shortcuts", async () => {
    const { client, native } = await createTestContext();
    await client.callTool({
      name: "keyboard_key",
      arguments: {
        key: "a",
        modifiers: ["command", "shift"],
        repeat: 2,
      },
    });
    await client.callTool({
      name: "keyboard_shortcut",
      arguments: { keys: ["command", "shift", "p"] },
    });

    expect(native.requests).toEqual([
      {
        method: "keyboard.key",
        params: {
          key: "a",
          action: "press",
          modifiers: ["command", "shift"],
          repeat: 2,
        },
      },
      {
        method: "keyboard.shortcut",
        params: { keys: ["command", "shift", "p"], holdMs: 0 },
      },
    ]);
  });

  it("tracks held keyboard state", async () => {
    const { client, native } = await createTestContext();
    native.responses["keyboard.key"] = {
      heldKeys: [],
      heldModifiers: ["shift"],
    };

    const result = await client.callTool({
      name: "keyboard_key",
      arguments: { key: "shift", action: "down" },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      heldKeys: [],
      heldModifiers: ["shift"],
    });
  });

  it("rejects invalid keyboard input before native execution", async () => {
    const { client, native } = await createTestContext();
    const duplicateShortcut = await client.callTool({
      name: "keyboard_shortcut",
      arguments: { keys: ["command", "command"] },
    });
    const heldWithModifiers = await client.callTool({
      name: "keyboard_key",
      arguments: { key: "a", action: "down", modifiers: ["shift"] },
    });
    const excessiveDelay = await client.callTool({
      name: "keyboard_type",
      arguments: { text: "abc", intervalMs: 10_000 },
    });
    const heldCapsLock = await client.callTool({
      name: "keyboard_key",
      arguments: { key: "caps-lock", action: "down" },
    });
    const capsLockShortcut = await client.callTool({
      name: "keyboard_shortcut",
      arguments: { keys: ["caps-lock", "a"] },
    });
    const excessiveSettle = await client.callTool({
      name: "keyboard_type",
      arguments: {
        text: "safe",
        captureAfter: {
          target: { kind: "window", windowId: "456" },
          settleMs: 2_001,
        },
      },
    });

    expect(duplicateShortcut.isError).toBe(true);
    expect(heldWithModifiers.isError).toBe(true);
    expect(excessiveDelay.isError).toBe(true);
    expect(heldCapsLock.isError).toBe(true);
    expect(capsLockShortcut.isError).toBe(true);
    expect(excessiveSettle.isError).toBe(true);
    expect(native.requests).toEqual([]);
  });

  it("normalizes and forwards an input batch as one native request", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "input_batch",
      arguments: {
        steps: [
          { type: "wait", durationMs: 0 },
          { type: "keyboard_key", key: "a" },
        ],
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      completed: true,
      completedCount: 2,
      results: [
        { index: 0, type: "wait", result: { waitedMs: 0 } },
        { index: 1, type: "keyboard_key", result: keyboardState },
      ],
    });
    expect(native.requests).toEqual([
      {
        method: "input.batch",
        params: {
          steps: [
            { type: "wait", durationMs: 0 },
            {
              type: "keyboard_key",
              key: "a",
              action: "press",
              modifiers: [],
              repeat: 1,
            },
          ],
        },
      },
    ]);
  });

  it("rejects an invalid later batch step before native dispatch", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "input_batch",
      arguments: {
        steps: [
          { type: "keyboard_key", key: "shift", action: "down" },
          { type: "wait", durationMs: 5_001 },
        ],
      },
    });

    expect(result.isError).toBe(true);
    expect(native.requests).toEqual([]);
  });

  it("preserves progress and marks a stopped input batch as an MCP error", async () => {
    const { client, native } = await createTestContext();
    native.responses["input.batch"] = {
      completed: false,
      completedCount: 1,
      results: [{ index: 0, type: "wait", result: { waitedMs: 0 } }],
      failure: {
        index: 1,
        type: "keyboard_key",
        error: {
          code: "action_failed",
          message: "Keyboard key is already held",
        },
        cleanup: {
          ...mouseState,
          ...keyboardState,
          releasedButtons: [],
          releasedKeys: ["a"],
          releasedModifiers: [],
        },
      },
    };

    const result = await client.callTool({
      name: "input_batch",
      arguments: {
        steps: [
          { type: "wait", durationMs: 0 },
          { type: "keyboard_key", key: "a", action: "down" },
        ],
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      completed: false,
      completedCount: 1,
      failure: {
        index: 1,
        error: { code: "action_failed" },
        cleanup: {
          heldButtons: [],
          heldKeys: [],
          heldModifiers: [],
          releasedKeys: ["a"],
        },
      },
    });
  });

  it("rejects a batch whose declared duration exceeds the total limit", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "input_batch",
      arguments: {
        steps: Array.from({ length: 7 }, () => ({
          type: "wait",
          durationMs: 5_000,
        })),
      },
    });

    expect(result.isError).toBe(true);
    expect(native.requests).toEqual([]);
  });

  it("rejects an excessive zero-delay batch workload", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "input_batch",
      arguments: {
        steps: [
          { type: "keyboard_type", text: "a".repeat(4_096) },
          { type: "keyboard_type", text: "b" },
        ],
      },
    });

    expect(result.isError).toBe(true);
    expect(native.requests).toEqual([]);
  });

  it("releases all tracked input state", async () => {
    const { client, native } = await createTestContext();
    const result = await client.callTool({
      name: "input_release_all",
      arguments: {},
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      ...mouseState,
      ...keyboardState,
      releasedButtons: ["left"],
      releasedKeys: ["a"],
      releasedModifiers: ["command"],
    });
    expect(native.requests).toEqual([
      { method: "input.releaseAll", params: {} },
    ]);
  });

  it("rejects a native focus result that was not verified", async () => {
    const { client, native } = await createTestContext();
    native.responses["window.focus"] = {
      windowId: "456",
      title: window.title,
      application: window.owningApplication,
      raiseResult: 0,
      verified: false,
    };

    const result = await client.callTool({
      name: "window_focus",
      arguments: { windowId: "456" },
    });

    expect(result.isError).toBe(true);
    expect(native.requests).toEqual([
      { method: "window.focus", params: { windowId: "456" } },
    ]);
  });
});
