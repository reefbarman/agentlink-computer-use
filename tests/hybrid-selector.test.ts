/// <reference types="node" />

import {
  createQwen3VlSelectorAdapter,
  evaluateCandidateSelections,
} from "../src/grounding/adapters/qwen3-vl-selector.js";
import { describe, expect, it } from "vitest";

const candidates = [
  {
    id: "candidate-a",
    role: "AXButton",
    names: ["Save"],
    normalizedBox: { xMin: 100, yMin: 200, xMax: 200, yMax: 250 },
  },
  {
    id: "candidate-b",
    role: "AXButton",
    names: ["Save"],
    normalizedBox: { xMin: 300, yMin: 200, xMax: 400, yMax: 250 },
  },
] as const;

describe("Qwen3-VL constrained candidate selector", () => {
  it("uses a schema enum and treats screenshot text as untrusted", () => {
    const adapter = createQwen3VlSelectorAdapter(candidates, "semantic");
    const prompt = adapter.prompt("the Save button for Project Alpha", {
      width: 1024,
      height: 768,
    });

    expect(prompt).toContain("candidate-a");
    expect(prompt).toContain("candidate-b");
    expect(prompt).toContain("candidate metadata");
    expect(prompt).toContain("untrusted UI content");
    expect(prompt).toContain("never invent an ID or coordinate");
    expect(adapter.responseJsonSchema).toMatchObject({
      properties: {
        selectedIds: {
          items: { enum: ["candidate-a", "candidate-b"] },
        },
      },
    });
  });

  it("rejects unknown or duplicate IDs", () => {
    const adapter = createQwen3VlSelectorAdapter(candidates, "visual-check");

    expect(() => adapter.parse({ selectedIds: ["candidate-c"] })).toThrow();
    expect(() =>
      adapter.parse({ selectedIds: ["candidate-a", "candidate-a"] }),
    ).toThrow(/must not contain duplicates/);
  });

  it("requires complete agreement before selecting one candidate", () => {
    expect(
      evaluateCandidateSelections(
        [{ selectedIds: ["candidate-a"] }, { selectedIds: ["candidate-a"] }],
        2,
      ),
    ).toMatchObject({
      status: "found",
      clickEligible: true,
      selectedIds: ["candidate-a"],
      rejectionReasons: [],
    });
    expect(
      evaluateCandidateSelections(
        [{ selectedIds: ["candidate-a"] }, { selectedIds: ["candidate-b"] }],
        2,
      ),
    ).toMatchObject({
      status: "uncertain",
      clickEligible: false,
      selectedIds: [],
      rejectionReasons: ["selection_disagreement"],
    });
  });

  it("rejects invalid expected response counts", () => {
    expect(() => evaluateCandidateSelections([], 0)).toThrow(
      /positive integer/,
    );
  });

  it("preserves agreed ambiguity and absence", () => {
    expect(
      evaluateCandidateSelections(
        [
          { selectedIds: ["candidate-a", "candidate-b"] },
          { selectedIds: ["candidate-b", "candidate-a"] },
        ],
        2,
      ),
    ).toMatchObject({
      status: "ambiguous",
      clickEligible: false,
      selectedIds: ["candidate-a", "candidate-b"],
      rejectionReasons: ["multiple_candidates"],
    });
    expect(
      evaluateCandidateSelections(
        [{ selectedIds: [] }, { selectedIds: [] }],
        2,
      ),
    ).toMatchObject({
      status: "not_found",
      clickEligible: false,
      selectedIds: [],
    });
  });
});
