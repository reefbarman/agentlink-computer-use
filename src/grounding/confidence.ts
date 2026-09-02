import type { CaptureMapping, PixelSize, Point, Rect } from "./types.js";
import { imageToScreen, intersectionOverUnion, mapRect } from "./geometry.js";

import type { GroundingCandidate } from "./adapters/qwen3-vl-candidates.js";

export interface CandidateView {
  adapterId: string;
  requestedWidth: number;
  imageSize: PixelSize;
  mapping: CaptureMapping;
  coordinateDenominator: number;
  candidates: GroundingCandidate[];
}

export interface ScreenCandidate {
  point: Point;
  box: Rect;
  sourceCount: number;
}

export type ConfidenceRejectionReason =
  | "missing_view"
  | "no_candidate"
  | "ambiguous_candidates"
  | "center_disagreement"
  | "box_disagreement"
  | "point_near_box_edge";

export interface GroundingConfidence {
  clickEligible: boolean;
  evidenceScore: number;
  rejectionReasons: ConfidenceRejectionReason[];
  viewCount: number;
  expectedViewCount: number;
  candidateCounts: number[];
  maxCenterDistanceScreenPoints: number | null;
  minimumPairwiseBoxIou: number | null;
  minimumPointEdgeInsetRatio: number | null;
  agreedPoint: Point | null;
  agreedBox: Rect | null;
}

export type GroundingDerivedStatus =
  | "found"
  | "not_found"
  | "ambiguous"
  | "uncertain";

export interface GroundingConfidenceCaseSummary {
  passed: boolean;
  derivedStatus: GroundingDerivedStatus;
  confidence: GroundingConfidence;
}

const duplicateCenterDistancePoints = 12;
const duplicateBoxIou = 0.45;
const maximumAgreementDistancePoints = 14;
const minimumAgreementIou = 0.35;
const minimumEdgeInsetRatio = 0.12;

function normalizedPointToImage(
  point: Point,
  imageSize: PixelSize,
  denominator: number,
): Point {
  return {
    x: (point.x / denominator) * imageSize.width,
    y: (point.y / denominator) * imageSize.height,
  };
}

function candidateToScreen(
  candidate: GroundingCandidate,
  imageSize: PixelSize,
  mapping: CaptureMapping,
  coordinateDenominator: number,
): ScreenCandidate {
  const imagePoint = normalizedPointToImage(
    candidate.point,
    imageSize,
    coordinateDenominator,
  );
  const topLeft = normalizedPointToImage(
    { x: candidate.box.xMin, y: candidate.box.yMin },
    imageSize,
    coordinateDenominator,
  );
  const bottomRight = normalizedPointToImage(
    { x: candidate.box.xMax, y: candidate.box.yMax },
    imageSize,
    coordinateDenominator,
  );
  const imageBox = {
    x: topLeft.x,
    y: topLeft.y,
    width: bottomRight.x - topLeft.x,
    height: bottomRight.y - topLeft.y,
  };
  return {
    point: imageToScreen(imagePoint, mapping),
    box: mapRect(imageBox, (point) => imageToScreen(point, mapping)),
    sourceCount: 1,
  };
}

function distance(left: Point, right: Point): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function mergeCandidates(candidates: ScreenCandidate[]): ScreenCandidate[] {
  const merged: ScreenCandidate[] = [];
  for (const candidate of candidates) {
    const existing = merged.find(
      (value) =>
        distance(value.point, candidate.point) <=
          duplicateCenterDistancePoints &&
        intersectionOverUnion(value.box, candidate.box) >= duplicateBoxIou,
    );
    if (existing === undefined) {
      merged.push({ ...candidate });
      continue;
    }
    const count = existing.sourceCount + candidate.sourceCount;
    existing.point = {
      x: (existing.point.x * existing.sourceCount + candidate.point.x) / count,
      y: (existing.point.y * existing.sourceCount + candidate.point.y) / count,
    };
    existing.box = {
      x: (existing.box.x * existing.sourceCount + candidate.box.x) / count,
      y: (existing.box.y * existing.sourceCount + candidate.box.y) / count,
      width:
        (existing.box.width * existing.sourceCount + candidate.box.width) /
        count,
      height:
        (existing.box.height * existing.sourceCount + candidate.box.height) /
        count,
    };
    existing.sourceCount = count;
  }
  return merged;
}

export function deduplicateCandidateView(
  view: CandidateView,
): ScreenCandidate[] {
  return mergeCandidates(
    view.candidates.map((candidate) =>
      candidateToScreen(
        candidate,
        view.imageSize,
        view.mapping,
        view.coordinateDenominator,
      ),
    ),
  );
}

function pairwiseValues<T>(
  values: T[],
  measure: (left: T, right: T) => number,
): number[] {
  const result: number[] = [];
  for (let left = 0; left < values.length; left += 1) {
    for (let right = left + 1; right < values.length; right += 1) {
      const leftValue = values[left];
      const rightValue = values[right];
      if (leftValue !== undefined && rightValue !== undefined) {
        result.push(measure(leftValue, rightValue));
      }
    }
  }
  return result;
}

function edgeInsetRatio(candidate: ScreenCandidate): number {
  const inset = Math.min(
    candidate.point.x - candidate.box.x,
    candidate.box.x + candidate.box.width - candidate.point.x,
    candidate.point.y - candidate.box.y,
    candidate.box.y + candidate.box.height - candidate.point.y,
  );
  return (
    inset / Math.max(1, Math.min(candidate.box.width, candidate.box.height))
  );
}

function averageCandidate(candidates: ScreenCandidate[]): ScreenCandidate {
  const count = candidates.length;
  return {
    point: {
      x: candidates.reduce((total, value) => total + value.point.x, 0) / count,
      y: candidates.reduce((total, value) => total + value.point.y, 0) / count,
    },
    box: {
      x: candidates.reduce((total, value) => total + value.box.x, 0) / count,
      y: candidates.reduce((total, value) => total + value.box.y, 0) / count,
      width:
        candidates.reduce((total, value) => total + value.box.width, 0) / count,
      height:
        candidates.reduce((total, value) => total + value.box.height, 0) /
        count,
    },
    sourceCount: count,
  };
}

export function deriveGroundingStatus(
  confidence: GroundingConfidence,
): GroundingDerivedStatus {
  if (confidence.clickEligible) return "found";
  if (
    confidence.viewCount === confidence.expectedViewCount &&
    confidence.candidateCounts.length === confidence.expectedViewCount &&
    confidence.candidateCounts.every((count) => count === 0)
  ) {
    return "not_found";
  }
  if (confidence.candidateCounts.some((count) => count > 1)) {
    return "ambiguous";
  }
  return "uncertain";
}

export function aggregateGroundingConfidence(
  results: readonly GroundingConfidenceCaseSummary[],
) {
  const statusCounts: Record<GroundingDerivedStatus, number> = {
    found: 0,
    not_found: 0,
    ambiguous: 0,
    uncertain: 0,
  };
  const rejectionReasonCounts: Partial<
    Record<ConfidenceRejectionReason, number>
  > = {};
  const candidateCountDistribution: Record<string, number> = {};

  for (const result of results) {
    statusCounts[result.derivedStatus] += 1;
    for (const reason of result.confidence.rejectionReasons) {
      rejectionReasonCounts[reason] = (rejectionReasonCounts[reason] ?? 0) + 1;
    }
    for (const count of result.confidence.candidateCounts) {
      const key = String(count);
      candidateCountDistribution[key] =
        (candidateCountDistribution[key] ?? 0) + 1;
    }
  }

  return {
    total: results.length,
    passed: results.filter(({ passed }) => passed).length,
    clickEligible: results.filter(({ confidence }) => confidence.clickEligible)
      .length,
    statusCounts,
    rejectionReasonCounts,
    candidateCountDistribution,
  };
}

export function evaluateGroundingConfidence(
  views: CandidateView[],
  expectedViewCount: number,
): GroundingConfidence {
  const rejectionReasons = new Set<ConfidenceRejectionReason>();
  if (views.length !== expectedViewCount) rejectionReasons.add("missing_view");

  const deduplicated = views.map(deduplicateCandidateView);
  const candidateCounts = deduplicated.map((values) => values.length);
  if (candidateCounts.some((count) => count === 0)) {
    rejectionReasons.add("no_candidate");
  }
  if (candidateCounts.some((count) => count > 1)) {
    rejectionReasons.add("ambiguous_candidates");
  }

  const uniqueCandidates = deduplicated.flatMap((values) =>
    values.length === 1 && values[0] !== undefined ? [values[0]] : [],
  );
  const centerDistances = pairwiseValues(uniqueCandidates, (left, right) =>
    distance(left.point, right.point),
  );
  const boxIous = pairwiseValues(uniqueCandidates, (left, right) =>
    intersectionOverUnion(left.box, right.box),
  );
  const edgeInsets = uniqueCandidates.map(edgeInsetRatio);
  const maxCenterDistanceScreenPoints =
    centerDistances.length === 0 ? null : Math.max(...centerDistances);
  const minimumPairwiseBoxIou =
    boxIous.length === 0 ? null : Math.min(...boxIous);
  const minimumPointEdgeInsetRatio =
    edgeInsets.length === 0 ? null : Math.min(...edgeInsets);

  if (
    maxCenterDistanceScreenPoints !== null &&
    maxCenterDistanceScreenPoints > maximumAgreementDistancePoints
  ) {
    rejectionReasons.add("center_disagreement");
  }
  if (
    minimumPairwiseBoxIou !== null &&
    minimumPairwiseBoxIou < minimumAgreementIou
  ) {
    rejectionReasons.add("box_disagreement");
  }
  if (
    minimumPointEdgeInsetRatio !== null &&
    minimumPointEdgeInsetRatio < minimumEdgeInsetRatio
  ) {
    rejectionReasons.add("point_near_box_edge");
  }

  const allViewsUnique =
    views.length === expectedViewCount &&
    candidateCounts.length === expectedViewCount &&
    candidateCounts.every((count) => count === 1);
  const agreed =
    allViewsUnique && uniqueCandidates.length === expectedViewCount
      ? averageCandidate(uniqueCandidates)
      : undefined;
  const clickEligible = rejectionReasons.size === 0 && agreed !== undefined;

  const uniquenessScore =
    expectedViewCount === 0
      ? 0
      : candidateCounts.filter((count) => count === 1).length /
        expectedViewCount;
  const centerScore =
    maxCenterDistanceScreenPoints === null
      ? 0
      : Math.max(
          0,
          1 - maxCenterDistanceScreenPoints / maximumAgreementDistancePoints,
        );
  const boxScore = minimumPairwiseBoxIou ?? 0;
  const insetScore =
    minimumPointEdgeInsetRatio === null
      ? 0
      : Math.min(1, minimumPointEdgeInsetRatio / 0.5);
  const evidenceScore =
    Math.round(
      1000 *
        (0.4 * uniquenessScore +
          0.25 * centerScore +
          0.2 * boxScore +
          0.15 * insetScore),
    ) / 1000;

  return {
    clickEligible,
    evidenceScore,
    rejectionReasons: [...rejectionReasons],
    viewCount: views.length,
    expectedViewCount,
    candidateCounts,
    maxCenterDistanceScreenPoints,
    minimumPairwiseBoxIou,
    minimumPointEdgeInsetRatio,
    agreedPoint: agreed?.point ?? null,
    agreedBox: agreed?.box ?? null,
  };
}
