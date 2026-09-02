/// <reference types="node" />

import { describe, expect, it } from "vitest";

import {
  decideHybridLocator,
  hybridLocatorInputSchema,
  type HybridLocatorInput,
} from "../src/grounding/hybrid-locator.js";

const evaluatedAt = "2026-07-22T12:00:00.500Z";
const observedAt = "2026-07-22T12:00:00.000Z";

const frame = { x: 100, y: 200, width: 120, height: 40 };
const secondFrame = { x: 300, y: 200, width: 120, height: 40 };

function input(
  overrides: Partial<HybridLocatorInput> = {},
): HybridLocatorInput {
  return hybridLocatorInputSchema.parse({
    evaluatedAt,
    maximumEvidenceAgeMs: 1_000,
    target: { processId: 123, launchDate: "2026-07-22T11:59:00.000Z" },
    requiredAction: "AXPress",
    ax: {
      status: "found",
      observationId: "ax-1",
      processId: 123,
      launchDate: "2026-07-22T11:59:00.000Z",
      observedAtEnd: observedAt,
      candidates: [
        {
          id: "n1",
          frame,
          actions: ["AXPress"],
          enabled: true,
        },
      ],
    },
    ...overrides,
  });
}

const matchingVision = {
  status: "found" as const,
  clickEligible: true,
  evidenceScore: 0.9,
  viewCount: 4,
  expectedViewCount: 4,
  captureObservedAt: observedAt,
  geometryValidated: true,
  candidate: {
    point: { x: 160, y: 220 },
    box: { x: 105, y: 202, width: 110, height: 36 },
  },
};

describe("hybrid locator policy", () => {
  it("prefers a complete enabled AX action without invoking vision", () => {
    expect(decideHybridLocator(input())).toMatchObject({
      status: "found",
      mode: "ax_action",
      clickEligible: true,
      selectedAxCandidateId: "n1",
      point: { x: 160, y: 220 },
      requiresFreshAxResolution: true,
      requiresFreshCapture: false,
      requiresPostcondition: true,
      rejectionReasons: [],
    });
  });

  it("uses vision only to corroborate an AX-framed physical point", () => {
    const decision = decideHybridLocator(
      input({
        ax: {
          ...input().ax,
          candidates: [{ id: "n1", frame, actions: [], enabled: true }],
        },
        vision: matchingVision,
      }),
    );

    expect(decision).toMatchObject({
      status: "found",
      mode: "ax_point",
      clickEligible: true,
      point: { x: 160, y: 220 },
      requiresFreshCapture: true,
    });
    expect(decision.score).toBeLessThan(0.96);
  });

  it("selects exactly one AX candidate using strong visual evidence", () => {
    const decision = decideHybridLocator(
      input({
        ax: {
          ...input().ax,
          status: "ambiguous",
          candidates: [
            { id: "left", frame, actions: ["AXPress"], enabled: true },
            {
              id: "right",
              frame: secondFrame,
              actions: ["AXPress"],
              enabled: true,
            },
          ],
        },
        vision: {
          ...matchingVision,
          evidenceScore: null,
          geometryValidated: undefined,
          candidate: null,
          selectedAxCandidateIds: ["left"],
        },
      }),
    );

    expect(decision).toMatchObject({
      status: "found",
      mode: "candidate_constrained",
      selectedAxCandidateId: "left",
      point: { x: 160, y: 220 },
      requiresFreshAxResolution: true,
      requiresFreshCapture: true,
    });
  });

  it("abstains when visual evidence overlaps no or multiple AX candidates", () => {
    const ambiguousAx = {
      ...input().ax,
      status: "ambiguous" as const,
      candidates: [
        { id: "left", frame, actions: ["AXPress"], enabled: true },
        {
          id: "right",
          frame: secondFrame,
          actions: ["AXPress"],
          enabled: true,
        },
      ],
    };
    expect(
      decideHybridLocator(
        input({
          ax: ambiguousAx,
          vision: {
            ...matchingVision,
            candidate: {
              point: { x: 500, y: 500 },
              box: { x: 480, y: 480, width: 40, height: 40 },
            },
          },
        }),
      ),
    ).toMatchObject({
      mode: "abstain",
      rejectionReasons: ["vision_outside_ax_candidates"],
    });

    expect(
      decideHybridLocator(
        input({
          ax: {
            ...ambiguousAx,
            candidates: [
              { id: "a", frame, actions: ["AXPress"], enabled: true },
              {
                id: "b",
                frame: { x: 110, y: 205, width: 120, height: 40 },
                actions: ["AXPress"],
                enabled: true,
              },
            ],
          },
          vision: matchingVision,
        }),
      ),
    ).toMatchObject({
      status: "ambiguous",
      mode: "abstain",
      rejectionReasons: ["vision_ambiguous_over_ax_candidates"],
    });
  });

  it("requires stronger confidence for unrestricted visual fallback", () => {
    const noAx = {
      status: "not_found" as const,
      observationId: "ax-2",
      processId: 123,
      launchDate: "2026-07-22T11:59:00.000Z",
      observedAtEnd: observedAt,
      candidates: [],
    };
    expect(
      decideHybridLocator(
        input({ ax: noAx, vision: { ...matchingVision, evidenceScore: 0.89 } }),
      ),
    ).toMatchObject({
      mode: "abstain",
      rejectionReasons: ["vision_not_click_eligible"],
    });
    expect(
      decideHybridLocator(input({ ax: noAx, vision: matchingVision })),
    ).toMatchObject({
      status: "found",
      mode: "visual_point",
      clickEligible: true,
      requiresFreshCapture: true,
      requiresPostcondition: true,
    });
  });

  it("confirms not_found only when complete vision also finds no candidate", () => {
    const noAx = {
      status: "not_found" as const,
      observationId: "ax-2",
      processId: 123,
      launchDate: "2026-07-22T11:59:00.000Z",
      observedAtEnd: observedAt,
      candidates: [],
    };
    expect(decideHybridLocator(input({ ax: noAx }))).toMatchObject({
      status: "uncertain",
      rejectionReasons: ["not_found_unconfirmed"],
    });
    expect(
      decideHybridLocator(
        input({
          ax: noAx,
          vision: {
            ...matchingVision,
            status: "not_found",
            clickEligible: false,
            evidenceScore: 0,
            geometryValidated: undefined,
            candidate: null,
          },
        }),
      ),
    ).toMatchObject({ status: "not_found", clickEligible: false, score: 0 });
  });

  it("rejects contradictory evidence payloads before policy evaluation", () => {
    expect(() => input({ ax: { ...input().ax, status: "not_found" } })).toThrow(
      /not_found AX evidence cannot contain candidates/,
    );
    expect(() =>
      input({
        vision: {
          ...matchingVision,
          status: "ambiguous",
          clickEligible: true,
        },
      }),
    ).toThrow(/ambiguous vision evidence cannot be clickEligible/);
  });

  it("rejects incomplete, stale, identity-mismatched, and conflicting evidence", () => {
    expect(
      decideHybridLocator(
        input({ ax: { ...input().ax, status: "incomplete" } }),
      ),
    ).toMatchObject({ rejectionReasons: ["ax_incomplete"] });
    expect(
      decideHybridLocator(
        input({ ax: { ...input().ax, observedAtEnd: "2026-07-22T11:59:58Z" } }),
      ),
    ).toMatchObject({ rejectionReasons: ["ax_evidence_stale"] });
    expect(
      decideHybridLocator(input({ ax: { ...input().ax, processId: 999 } })),
    ).toMatchObject({ rejectionReasons: ["ax_identity_mismatch"] });
    expect(
      decideHybridLocator(
        input({
          vision: {
            ...matchingVision,
            candidate: {
              point: { x: 500, y: 500 },
              box: { x: 480, y: 480, width: 40, height: 40 },
            },
          },
        }),
      ),
    ).toMatchObject({ rejectionReasons: ["cross_modal_disagreement"] });
  });
});
