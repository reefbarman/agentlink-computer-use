import { z } from "zod";

import {
  accessibilityLimitsSchema,
  accessibilityPredicateSchema,
} from "../semantic/contracts.js";

export {
  accessibilityNodeSchema,
  accessibilityPredicateSchema,
  accessibilityQuerySchema,
  accessibilitySnapshotSchema,
  type AccessibilityNode,
  type AccessibilityPredicate,
  type AccessibilityQuery,
  type AccessibilitySnapshot,
} from "../semantic/contracts.js";

export const axDiscoveryCaseSchema = z.object({
  id: z.string().min(1),
  expectedStatus: z.enum(["found", "not_found", "ambiguous", "incomplete"]),
  predicate: accessibilityPredicateSchema,
  limits: accessibilityLimitsSchema.partial().optional(),
});

export const axDiscoveryTrialSchema = z.object({
  caseId: z.string().min(1),
  repetition: z.number().int().positive(),
  expectedStatus: z.enum(["found", "not_found", "ambiguous", "incomplete"]),
  actualStatus: z.enum(["found", "not_found", "ambiguous", "incomplete"]),
  passed: z.boolean(),
  durationMs: z.number().nonnegative(),
  nativeDurationMs: z.number().nonnegative(),
  responseBytes: z.number().int().nonnegative(),
  nodesVisited: z.number().int().nonnegative(),
  axCalls: z.number().int().nonnegative(),
  matchCount: z.number().int().nonnegative(),
  completionStatus: z.enum(["complete", "partial"]),
  completionReasons: z.array(z.string().min(1)),
});

export type AxDiscoveryCase = z.infer<typeof axDiscoveryCaseSchema>;
export type AxDiscoveryTrial = z.infer<typeof axDiscoveryTrialSchema>;

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
}

export function aggregateAxDiscovery(trials: AxDiscoveryTrial[]) {
  const successful = trials.filter(({ passed }) => passed);
  return {
    total: trials.length,
    passed: successful.length,
    passRate: trials.length === 0 ? 0 : successful.length / trials.length,
    durationMs: {
      sampleCount: trials.length,
      p50: percentile(
        trials.map(({ durationMs }) => durationMs),
        0.5,
      ),
      p95Qualified: trials.length >= 30,
      p95:
        trials.length < 30
          ? null
          : percentile(
              trials.map(({ durationMs }) => durationMs),
              0.95,
            ),
      max:
        trials.length === 0
          ? null
          : Math.max(...trials.map(({ durationMs }) => durationMs)),
    },
    meanResponseBytes:
      trials.length === 0
        ? 0
        : trials.reduce((total, trial) => total + trial.responseBytes, 0) /
          trials.length,
    meanAxCalls:
      trials.length === 0
        ? 0
        : trials.reduce((total, trial) => total + trial.axCalls, 0) /
          trials.length,
  };
}
