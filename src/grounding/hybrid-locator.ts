import { z } from "zod";

import { distance, intersectionOverUnion } from "./geometry.js";
import { pointSchema, rectSchema, type Point, type Rect } from "./types.js";

const axCandidateSchema = z.object({
  id: z.string().min(1),
  frame: rectSchema.nullable(),
  actions: z.array(z.string().min(1)),
  enabled: z.boolean().nullable(),
});

const axEvidenceSchema = z
  .object({
    status: z.enum([
      "found",
      "not_found",
      "ambiguous",
      "incomplete",
      "unavailable",
    ]),
    observationId: z.string().min(1).optional(),
    processId: z.number().int().positive().optional(),
    launchDate: z.iso.datetime().nullable().optional(),
    observedAtEnd: z.iso.datetime().optional(),
    candidates: z.array(axCandidateSchema).max(32),
  })
  .superRefine((value, context) => {
    if (
      value.status !== "unavailable" &&
      (value.observationId === undefined ||
        value.processId === undefined ||
        value.observedAtEnd === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "available AX evidence requires observation and process identity",
      });
    }
    if (value.status === "found" && value.candidates.length !== 1) {
      context.addIssue({
        code: "custom",
        message: "found AX evidence needs one candidate",
      });
    }
    if (value.status === "ambiguous" && value.candidates.length < 2) {
      context.addIssue({
        code: "custom",
        message: "ambiguous AX evidence needs multiple candidates",
      });
    }
    if (
      (value.status === "not_found" || value.status === "unavailable") &&
      value.candidates.length !== 0
    ) {
      context.addIssue({
        code: "custom",
        message: `${value.status} AX evidence cannot contain candidates`,
      });
    }
  });

const visualCandidateSchema = z.object({
  point: pointSchema,
  box: rectSchema,
});

const visionEvidenceSchema = z
  .object({
    status: z.enum([
      "found",
      "not_found",
      "ambiguous",
      "uncertain",
      "unavailable",
    ]),
    clickEligible: z.boolean(),
    evidenceScore: z.number().min(0).max(1).nullable(),
    viewCount: z.number().int().nonnegative(),
    expectedViewCount: z.number().int().positive(),
    captureObservedAt: z.iso.datetime().optional(),
    candidate: visualCandidateSchema.nullable(),
    selectedAxCandidateIds: z.array(z.string().min(1)).max(32).optional(),
    geometryValidated: z.boolean().optional(),
  })
  .superRefine((value, context) => {
    if (
      value.status !== "unavailable" &&
      value.captureObservedAt === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "available vision evidence requires captureObservedAt",
      });
    }
    if (value.status === "found" && !value.clickEligible) {
      context.addIssue({
        code: "custom",
        message: "found vision evidence must be clickEligible",
      });
    }
    if (value.status !== "found" && value.clickEligible) {
      context.addIssue({
        code: "custom",
        message: `${value.status} vision evidence cannot be clickEligible`,
      });
    }
    if (
      value.status === "found" &&
      value.candidate === null &&
      value.selectedAxCandidateIds?.length !== 1
    ) {
      context.addIssue({
        code: "custom",
        message:
          "found vision evidence requires a coordinate or selected AX ID",
      });
    }
    if (
      value.candidate !== null &&
      (value.evidenceScore === null || value.geometryValidated !== true)
    ) {
      context.addIssue({
        code: "custom",
        message: "coordinate evidence requires a score and geometry validation",
      });
    }
  });

export const hybridLocatorInputSchema = z.object({
  evaluatedAt: z.iso.datetime(),
  maximumEvidenceAgeMs: z.number().int().min(50).max(120_000).default(30_000),
  target: z.object({
    processId: z.number().int().positive(),
    launchDate: z.iso.datetime().nullable(),
  }),
  requiredAction: z.string().min(1).default("AXPress"),
  ax: axEvidenceSchema,
  vision: visionEvidenceSchema.optional(),
});

export type HybridLocatorInput = z.infer<typeof hybridLocatorInputSchema>;
export type HybridLocatorMode =
  | "ax_action"
  | "ax_point"
  | "candidate_constrained"
  | "visual_point"
  | "abstain";
export type HybridLocatorStatus =
  | "found"
  | "not_found"
  | "ambiguous"
  | "uncertain";

export type HybridRejectionReason =
  | "ax_incomplete"
  | "ax_candidate_disabled"
  | "ax_frame_missing"
  | "ax_action_unsupported"
  | "vision_required"
  | "vision_unavailable"
  | "vision_not_click_eligible"
  | "vision_missing_candidate"
  | "vision_outside_ax_candidates"
  | "vision_ambiguous_over_ax_candidates"
  | "cross_modal_disagreement"
  | "ax_identity_mismatch"
  | "ax_evidence_stale"
  | "vision_evidence_stale"
  | "not_found_unconfirmed";

export interface HybridLocatorDecision {
  status: HybridLocatorStatus;
  mode: HybridLocatorMode;
  clickEligible: boolean;
  score: number;
  selectedAxCandidateId: string | null;
  point: Point | null;
  frame: Rect | null;
  requiresFreshAxResolution: boolean;
  requiresFreshCapture: boolean;
  requiresPostcondition: boolean;
  rejectionReasons: HybridRejectionReason[];
  evidence: {
    axStatus: HybridLocatorInput["ax"]["status"];
    visionStatus:
      | NonNullable<HybridLocatorInput["vision"]>["status"]
      | "not_run";
    visionEvidenceScore: number | null;
    overlappingAxCandidateIds: string[];
  };
}

const minimumConstrainedVisionScore = 0.8;
const minimumUnrestrictedVisionScore = 0.9;
const minimumAxAgreementIou = 0.2;
const maximumAxCenterDistancePoints = 20;

function center(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function pointInside(rect: Rect, point: Point): boolean {
  return (
    point.x > rect.x &&
    point.x < rect.x + rect.width &&
    point.y > rect.y &&
    point.y < rect.y + rect.height
  );
}

function supportsAction(
  candidate: z.infer<typeof axCandidateSchema>,
  requiredAction: string,
): boolean {
  return (
    candidate.enabled !== false && candidate.actions.includes(requiredAction)
  );
}

function safeAxPoint(frame: Rect): Point {
  return center(frame);
}

function abstain(
  input: HybridLocatorInput,
  status: HybridLocatorStatus,
  reasons: HybridRejectionReason[],
  overlappingAxCandidateIds: string[] = [],
): HybridLocatorDecision {
  return {
    status,
    mode: "abstain",
    clickEligible: false,
    score: 0,
    selectedAxCandidateId: null,
    point: null,
    frame: null,
    requiresFreshAxResolution: false,
    requiresFreshCapture: false,
    requiresPostcondition: false,
    rejectionReasons: reasons,
    evidence: {
      axStatus: input.ax.status,
      visionStatus: input.vision?.status ?? "not_run",
      visionEvidenceScore: input.vision?.evidenceScore ?? null,
      overlappingAxCandidateIds,
    },
  };
}

function coordinateVisionUsable(
  vision: NonNullable<HybridLocatorInput["vision"]>,
  minimumScore: number,
): boolean {
  return (
    vision.status === "found" &&
    vision.clickEligible &&
    vision.evidenceScore !== null &&
    vision.evidenceScore >= minimumScore &&
    vision.viewCount === vision.expectedViewCount &&
    vision.candidate !== null &&
    vision.geometryValidated === true
  );
}

function selectorVisionUsable(
  vision: NonNullable<HybridLocatorInput["vision"]>,
): boolean {
  return (
    vision.status === "found" &&
    vision.clickEligible &&
    vision.viewCount === vision.expectedViewCount &&
    vision.selectedAxCandidateIds?.length === 1
  );
}

function evidenceIsStale(
  observedAt: string | undefined,
  evaluatedAt: string,
  maximumAgeMs: number,
): boolean {
  if (observedAt === undefined) return true;
  const age = Date.parse(evaluatedAt) - Date.parse(observedAt);
  return age < 0 || age > maximumAgeMs;
}

function visionAgreement(
  frame: Rect,
  candidate: z.infer<typeof visualCandidateSchema>,
): boolean {
  return (
    pointInside(frame, candidate.point) ||
    intersectionOverUnion(frame, candidate.box) >= minimumAxAgreementIou ||
    distance(center(frame), candidate.point) <= maximumAxCenterDistancePoints
  );
}

export function decideHybridLocator(
  value: HybridLocatorInput,
): HybridLocatorDecision {
  const input = hybridLocatorInputSchema.parse(value);
  const { ax, vision, requiredAction } = input;

  if (
    ax.status !== "unavailable" &&
    (ax.processId !== input.target.processId ||
      (input.target.launchDate !== null &&
        ax.launchDate !== input.target.launchDate))
  ) {
    return abstain(input, "uncertain", ["ax_identity_mismatch"]);
  }
  if (
    ax.status !== "unavailable" &&
    evidenceIsStale(
      ax.observedAtEnd,
      input.evaluatedAt,
      input.maximumEvidenceAgeMs,
    )
  ) {
    return abstain(input, "uncertain", ["ax_evidence_stale"]);
  }
  if (
    vision !== undefined &&
    vision.status !== "unavailable" &&
    evidenceIsStale(
      vision.captureObservedAt,
      input.evaluatedAt,
      input.maximumEvidenceAgeMs,
    )
  ) {
    return abstain(input, "uncertain", ["vision_evidence_stale"]);
  }

  if (ax.status === "incomplete") {
    return abstain(input, "uncertain", ["ax_incomplete"]);
  }

  if (ax.status === "found") {
    const candidate = ax.candidates.length === 1 ? ax.candidates[0] : undefined;
    if (candidate === undefined) {
      return abstain(input, "uncertain", ["cross_modal_disagreement"]);
    }
    if (candidate.enabled === false) {
      return abstain(input, "uncertain", ["ax_candidate_disabled"]);
    }
    const actionSupported = candidate.actions.includes(requiredAction);
    const selectorIds = vision?.selectedAxCandidateIds ?? [];
    if (candidate.frame === null) {
      return abstain(input, "uncertain", ["ax_frame_missing"]);
    }
    if (vision !== undefined && vision.status !== "unavailable") {
      if (selectorIds.length > 0) {
        if (!selectorVisionUsable(vision) || selectorIds[0] !== candidate.id) {
          return abstain(input, "uncertain", ["cross_modal_disagreement"]);
        }
      } else {
        if (
          !coordinateVisionUsable(vision, minimumConstrainedVisionScore) ||
          vision.candidate === null
        ) {
          return abstain(input, "uncertain", ["vision_not_click_eligible"]);
        }
        if (!visionAgreement(candidate.frame, vision.candidate)) {
          return abstain(input, "uncertain", ["cross_modal_disagreement"]);
        }
      }
    }
    if (!actionSupported && vision === undefined) {
      return abstain(input, "uncertain", [
        "ax_action_unsupported",
        "vision_required",
      ]);
    }
    return {
      status: "found",
      mode: actionSupported ? "ax_action" : "ax_point",
      clickEligible: true,
      score: actionSupported
        ? vision === undefined
          ? 0.96
          : selectorIds.length > 0
            ? 0.97
            : Math.min(0.99, 0.96 + (vision.evidenceScore ?? 0) * 0.03)
        : selectorIds.length > 0
          ? 0.88
          : Math.min(0.92, 0.62 + (vision?.evidenceScore ?? 0) * 0.3),
      selectedAxCandidateId: candidate.id,
      point: safeAxPoint(candidate.frame),
      frame: candidate.frame,
      requiresFreshAxResolution: true,
      requiresFreshCapture: !actionSupported,
      requiresPostcondition: true,
      rejectionReasons: [],
      evidence: {
        axStatus: ax.status,
        visionStatus: vision?.status ?? "not_run",
        visionEvidenceScore: vision?.evidenceScore ?? null,
        overlappingAxCandidateIds: [candidate.id],
      },
    };
  }

  if (ax.status === "ambiguous") {
    if (vision === undefined)
      return abstain(input, "ambiguous", ["vision_required"]);
    if (vision.status === "unavailable") {
      return abstain(input, "ambiguous", ["vision_unavailable"]);
    }
    const framedCandidates = ax.candidates.filter(
      (candidate) => candidate.frame !== null && candidate.enabled !== false,
    );
    const selectorIds = vision.selectedAxCandidateIds ?? [];
    let overlaps: typeof framedCandidates;
    if (selectorIds.length > 0) {
      if (!selectorVisionUsable(vision)) {
        return abstain(input, "ambiguous", ["vision_not_click_eligible"]);
      }
      const selected = new Set(selectorIds);
      overlaps = framedCandidates.filter(({ id }) => selected.has(id));
    } else {
      if (
        !coordinateVisionUsable(vision, minimumConstrainedVisionScore) ||
        vision.candidate === null
      ) {
        return abstain(input, "ambiguous", ["vision_not_click_eligible"]);
      }
      overlaps = framedCandidates.filter(
        (candidate) =>
          candidate.frame !== null &&
          visionAgreement(candidate.frame, vision.candidate!),
      );
    }
    if (overlaps.length === 0) {
      return abstain(input, "uncertain", ["vision_outside_ax_candidates"]);
    }
    if (overlaps.length > 1) {
      return abstain(
        input,
        "ambiguous",
        ["vision_ambiguous_over_ax_candidates"],
        overlaps.map(({ id }) => id),
      );
    }
    const selected = overlaps[0];
    if (selected?.frame === null || selected === undefined) {
      return abstain(input, "uncertain", ["ax_frame_missing"]);
    }
    const actionSupported = supportsAction(selected, requiredAction);
    return {
      status: "found",
      mode: actionSupported ? "candidate_constrained" : "ax_point",
      clickEligible: true,
      score: actionSupported ? 0.9 : 0.86,
      selectedAxCandidateId: selected.id,
      point: safeAxPoint(selected.frame),
      frame: selected.frame,
      requiresFreshAxResolution: true,
      requiresFreshCapture: true,
      requiresPostcondition: true,
      rejectionReasons: [],
      evidence: {
        axStatus: ax.status,
        visionStatus: vision.status,
        visionEvidenceScore: vision.evidenceScore,
        overlappingAxCandidateIds: [selected.id],
      },
    };
  }

  if (ax.status === "not_found") {
    if (vision === undefined || vision.status === "unavailable") {
      return abstain(input, "uncertain", ["not_found_unconfirmed"]);
    }
    if (
      vision.status === "not_found" &&
      vision.viewCount === vision.expectedViewCount
    ) {
      return {
        ...abstain(input, "not_found", []),
        score: 0,
      };
    }
    if (
      !coordinateVisionUsable(vision, minimumUnrestrictedVisionScore) ||
      vision.candidate === null
    ) {
      return abstain(
        input,
        vision.status === "ambiguous" ? "ambiguous" : "uncertain",
        ["vision_not_click_eligible"],
      );
    }
    return {
      status: "found",
      mode: "visual_point",
      clickEligible: true,
      score: Math.min(0.92, vision.evidenceScore ?? 0),
      selectedAxCandidateId: null,
      point: vision.candidate.point,
      frame: vision.candidate.box,
      requiresFreshAxResolution: false,
      requiresFreshCapture: true,
      requiresPostcondition: true,
      rejectionReasons: [],
      evidence: {
        axStatus: ax.status,
        visionStatus: vision.status,
        visionEvidenceScore: vision.evidenceScore,
        overlappingAxCandidateIds: [],
      },
    };
  }

  if (vision === undefined || vision.status === "unavailable") {
    return abstain(input, "uncertain", ["vision_unavailable"]);
  }
  if (
    !coordinateVisionUsable(vision, minimumUnrestrictedVisionScore) ||
    vision.candidate === null
  ) {
    return abstain(
      input,
      vision.status === "not_found" ? "not_found" : "uncertain",
      ["vision_not_click_eligible"],
    );
  }
  return {
    status: "found",
    mode: "visual_point",
    clickEligible: true,
    score: Math.min(0.9, vision.evidenceScore ?? 0),
    selectedAxCandidateId: null,
    point: vision.candidate.point,
    frame: vision.candidate.box,
    requiresFreshAxResolution: false,
    requiresFreshCapture: true,
    requiresPostcondition: true,
    rejectionReasons: [],
    evidence: {
      axStatus: ax.status,
      visionStatus: vision.status,
      visionEvidenceScore: vision.evidenceScore,
      overlappingAxCandidateIds: [],
    },
  };
}
