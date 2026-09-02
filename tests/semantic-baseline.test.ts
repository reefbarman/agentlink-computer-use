import {
  aggregateSemanticBaseline,
  semanticBaselineTrialSchema,
  semanticTargetEventSchema,
  statesMatch,
} from "../src/benchmarks/semantic-baseline-types.js";
import { describe, expect, it } from "vitest";

const expected = {
  submittedText: "Baseline text",
  cloudSyncEnabled: false,
  statusText: "Submitted: Baseline text",
};

const state = {
  ...expected,
  actions: ["submit"],
  forbiddenActionCount: 0,
  receivedInputEventCount: 8,
};

describe("semantic baseline contracts", () => {
  it("requires exact semantic state and action order", () => {
    expect(statesMatch(state, expected, ["submit"])).toBe(true);
    expect(
      statesMatch(
        { ...state, actions: ["toggle_sync:on", "submit"] },
        expected,
        ["submit"],
      ),
    ).toBe(false);
    expect(
      statesMatch({ ...state, forbiddenActionCount: 1 }, expected, ["submit"]),
    ).toBe(false);
  });

  it("validates the fixture ready manifest and input-event counter", () => {
    const ready = semanticTargetEventSchema.parse({
      type: "ready",
      schemaVersion: 1,
      processId: 123,
      window: {
        title: "Computer Use Semantic Workflow Target",
        bounds: { x: 10, y: 20, width: 720, height: 443 },
      },
      controls: [
        {
          id: "submit",
          role: "button",
          label: "Submit workflow",
          bounds: { x: 500, y: 250, width: 150, height: 38 },
          actionPoint: { x: 575, y: 269 },
        },
      ],
      workflows: [
        {
          id: "submit-text",
          title: "Submit deterministic text",
          goal: "Enter text and submit",
          expectedActions: ["submit"],
          expectedFinalState: expected,
        },
      ],
      state: {
        submittedText: "",
        cloudSyncEnabled: false,
        statusText: "Ready",
        actions: [],
        forbiddenActionCount: 0,
        receivedInputEventCount: 0,
      },
    });

    expect(ready.type).toBe("ready");
    if (ready.type !== "ready") throw new Error("Expected ready event");
    expect(ready.state.receivedInputEventCount).toBe(0);
  });

  it("qualifies p95 only with at least thirty route samples", () => {
    const base = semanticBaselineTrialSchema.parse({
      workflowId: "submit-text",
      route: "primitive",
      repetition: 1,
      passed: true,
      finalState: state,
      expectedFinalState: expected,
      topLevelMcpCalls: 6,
      nativeRequests: 8,
      captures: 2,
      captureBytes: 20_000,
      inputEvents: 8,
      durationMs: 100,
      trace: [],
    });
    const smoke = aggregateSemanticBaseline([base]);
    expect(smoke[0]?.durationMs).toMatchObject({
      sampleCount: 1,
      p95Qualified: false,
      p95: null,
    });

    const qualified = aggregateSemanticBaseline(
      Array.from({ length: 30 }, (_, index) => ({
        ...base,
        repetition: index + 1,
        durationMs: index + 1,
      })),
    );
    expect(qualified[0]?.durationMs).toMatchObject({
      sampleCount: 30,
      p95Qualified: true,
      p95: 29,
    });
  });

  it("validates complete trace accounting without screenshot content", () => {
    const trial = semanticBaselineTrialSchema.parse({
      workflowId: "submit-text",
      route: "primitive",
      repetition: 1,
      passed: true,
      finalState: state,
      expectedFinalState: expected,
      topLevelMcpCalls: 7,
      nativeRequests: 9,
      captures: 2,
      captureBytes: 20_000,
      inputEvents: 8,
      durationMs: 325,
      trace: [
        {
          sequence: 0,
          layer: "mcp",
          operation: "screen_capture",
          startedOffsetMs: 0,
          durationMs: 100,
          requestBytes: 100,
          responseBytes: 1_000,
          imageBytes: 10_000,
          status: "ok",
        },
      ],
    });

    expect(trial.trace[0]).not.toHaveProperty("image");
    expect(trial.trace[0]?.imageBytes).toBe(10_000);
  });
});
