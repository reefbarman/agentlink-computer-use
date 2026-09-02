import {
  accessibilityPredicateSchema,
  accessibilityQuerySchema,
  aggregateAxDiscovery,
  axDiscoveryTrialSchema,
} from "../src/benchmarks/ax-discovery-types.js";
import {
  accessibilityWaitSchema,
  uiConditionSchema,
  uiWaitInputSchema,
} from "../src/semantic/contracts.js";
import { describe, expect, it } from "vitest";

const node = {
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
  valueType: null,
  fingerprint: `sha256:${"c".repeat(64)}`,
};

function query(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    observationId: "observation-1",
    source: "accessibility",
    observedAtStart: "2026-07-22T10:00:00Z",
    observedAtEnd: "2026-07-22T10:00:00Z",
    application: {
      processId: 123,
      processInstanceId: `sha256:${"a".repeat(64)}`,
      bundleIdentifier: "com.example.fixture",
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
    matches: [node],
    matchesTruncated: false,
    ...overrides,
  };
}

describe("AX discovery contracts", () => {
  it("accepts a complete unique match and an unavailable launch date", () => {
    expect(accessibilityQuerySchema.parse(query()).status).toBe("found");
    expect(
      accessibilityQuerySchema.parse(
        query({
          application: {
            processId: 123,
            processInstanceId: `sha256:${"a".repeat(64)}`,
            bundleIdentifier: "com.example.fixture",
            launchDate: null,
          },
        }),
      ).application.launchDate,
    ).toBeNull();
  });

  it("rejects authoritative statuses from partial traversal", () => {
    expect(() =>
      accessibilityQuerySchema.parse(
        query({
          completion: { status: "partial", reasons: ["node_limit"] },
        }),
      ),
    ).toThrow(/partial observations must have incomplete query status/);

    expect(
      accessibilityQuerySchema.parse(
        query({
          completion: { status: "partial", reasons: ["node_limit"] },
          status: "incomplete",
          matchCount: 0,
          matches: [],
          matchesTruncated: false,
        }),
      ).status,
    ).toBe("incomplete");
  });

  it("enforces status and match-count invariants", () => {
    expect(() =>
      accessibilityQuerySchema.parse(
        query({ status: "not_found", matchCount: 1, matches: [node] }),
      ),
    ).toThrow(/not_found queries cannot have matches/);
    expect(() =>
      accessibilityQuerySchema.parse(
        query({ status: "ambiguous", matchCount: 1, matches: [node] }),
      ),
    ).toThrow(/ambiguous queries must have at least two matches/);
    expect(() =>
      accessibilityQuerySchema.parse(query({ matchCount: 2 })),
    ).toThrow(/matchesTruncated must reflect omitted matches/);
    expect(
      accessibilityQuerySchema.parse(
        query({
          status: "ambiguous",
          matchCount: 2,
          matchesTruncated: true,
        }),
      ).matches,
    ).toEqual([node]);
  });

  it("requires bounded, meaningful predicates", () => {
    expect(() => accessibilityPredicateSchema.parse({})).toThrow(
      /predicate must include at least one constraint/,
    );
    expect(() =>
      accessibilityPredicateSchema.parse({ name: "Submit", ancestor: {} }),
    ).toThrow(/ancestor must constrain role or name/);
    expect(
      accessibilityPredicateSchema.parse({
        roles: ["AXButton"],
        name: "Submit workflow",
        requiredActions: ["AXPress"],
        enabled: true,
      }),
    ).toMatchObject({ roles: ["AXButton"] });
  });

  it("accepts bounded atomic and flat composite UI conditions", () => {
    expect(
      uiWaitInputSchema.parse({
        scope: { processId: 123 },
        condition: {
          kind: "element",
          target: { name: "Submit workflow" },
          state: "appears",
        },
      }),
    ).toMatchObject({ timeoutMs: 10_000, pollIntervalMs: 250 });

    expect(
      uiConditionSchema.parse({
        allOf: [
          {
            kind: "element",
            target: { roles: ["AXButton"] },
            state: "enabled",
            equals: true,
          },
          {
            kind: "window",
            title: "Computer Use Semantic Workflow Target",
            state: "appears",
          },
        ],
      }),
    ).toHaveProperty("allOf.1.titleMatch", "normalized");

    expect(() => uiConditionSchema.parse({ allOf: [] })).toThrow();
    expect(() =>
      uiConditionSchema.parse({
        kind: "element",
        target: { name: "Submit" },
        state: "enabled",
      }),
    ).toThrow();
    expect(() =>
      uiConditionSchema.parse({
        kind: "window",
        state: "focused",
        equals: true,
      }),
    ).toThrow();
  });

  it("enforces wait observation identity and uncertainty invariants", () => {
    const wait = {
      schemaVersion: 1,
      status: "satisfied",
      startedAt: "2026-07-22T10:00:00Z",
      finishedAt: "2026-07-22T10:00:00Z",
      durationMs: 4,
      pollCount: 1,
      application: query().application,
      observation: {
        ...query(),
        status: undefined,
        matchCount: undefined,
        matches: undefined,
        matchesTruncated: undefined,
      },
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
    };
    const observation = {
      schemaVersion: 1,
      observationId: "wait-observation",
      source: "accessibility",
      observedAtStart: "2026-07-22T10:00:00Z",
      observedAtEnd: "2026-07-22T10:00:00Z",
      application: query().application,
      consistency: "best_effort",
      completion: { status: "complete", reasons: [] },
      metrics: query().metrics,
      limits: query().limits,
    };

    expect(accessibilityWaitSchema.parse({ ...wait, observation }).status).toBe(
      "satisfied",
    );
    expect(() =>
      accessibilityWaitSchema.parse({
        ...wait,
        observation: {
          ...observation,
          application: {
            ...observation.application,
            processInstanceId: `sha256:${"b".repeat(64)}`,
          },
        },
      }),
    ).toThrow(/wait application identity must match/);
    expect(() =>
      accessibilityWaitSchema.parse({
        ...wait,
        status: "uncertain",
        observation: null,
        evaluations: [],
        reasons: [],
      }),
    ).toThrow(/uncertain waits require at least one reason/);
  });

  it("withholds p95 until thirty samples", () => {
    const trial = axDiscoveryTrialSchema.parse({
      caseId: "exact-button",
      repetition: 1,
      expectedStatus: "found",
      actualStatus: "found",
      passed: true,
      durationMs: 10,
      nativeDurationMs: 8,
      responseBytes: 2_000,
      nodesVisited: 8,
      axCalls: 100,
      matchCount: 1,
      completionStatus: "complete",
      completionReasons: [],
    });
    expect(aggregateAxDiscovery([trial]).durationMs).toMatchObject({
      sampleCount: 1,
      p95Qualified: false,
      p95: null,
    });
    expect(
      aggregateAxDiscovery(
        Array.from({ length: 30 }, (_, index) => ({
          ...trial,
          repetition: index + 1,
          durationMs: index + 1,
        })),
      ).durationMs,
    ).toMatchObject({ sampleCount: 30, p95Qualified: true, p95: 29 });
  });
});
