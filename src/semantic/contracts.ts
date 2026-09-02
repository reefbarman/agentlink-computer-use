import { z } from "zod";

export const semanticRectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});

export const accessibilityCompletionSchema = z.object({
  status: z.enum(["complete", "partial"]),
  reasons: z.array(z.string().min(1)),
});

export const accessibilityMetricsSchema = z.object({
  durationMs: z.number().nonnegative(),
  nodesVisited: z.number().int().nonnegative(),
  nodesReturned: z.number().int().nonnegative(),
  axCalls: z.number().int().nonnegative(),
  errorsByCategory: z.record(z.string(), z.number().int().nonnegative()),
  serializedBytes: z.number().int().nonnegative(),
});

export const accessibilityLimitsSchema = z.object({
  deadlineMs: z.number().int().min(100).max(3_000),
  messageTimeoutMs: z.number().int().min(10).max(250),
  maxDepth: z.number().int().min(1).max(20),
  maxNodes: z.number().int().min(1).max(2_500),
  maxChildren: z.number().int().min(1).max(250),
  maxStringLength: z.number().int().min(1).max(2_048),
  maxResultBytes: z.number().int().min(16_384).max(2_097_152),
});

export const accessibilityNodeSchema = z.object({
  id: z.string().regex(/^n\d+$/),
  parentId: z
    .string()
    .regex(/^n\d+$/)
    .nullable(),
  depth: z.number().int().nonnegative(),
  childIndex: z.number().int().nonnegative(),
  role: z.string().nullable(),
  subrole: z.string().nullable(),
  names: z.array(z.string()),
  frame: semanticRectSchema.nullable(),
  actions: z.array(z.string()),
  enabled: z.boolean().nullable(),
  focused: z.boolean().nullable(),
  selected: z.boolean().nullable(),
  expanded: z.boolean().nullable(),
  visible: z.boolean().nullable(),
  valueType: z.string().nullable(),
  attributeStatus: z.record(z.string(), z.string()).optional(),
  fingerprint: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .optional(),
});

const processInstanceIdSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const accessibilityObservationSchema = z.object({
  schemaVersion: z.literal(1),
  observationId: z.string().min(1),
  source: z.literal("accessibility"),
  observedAtStart: z.iso.datetime(),
  observedAtEnd: z.iso.datetime(),
  application: z.object({
    processId: z.number().int().positive(),
    processInstanceId: processInstanceIdSchema,
    bundleIdentifier: z.string(),
    launchDate: z.iso.datetime().nullable(),
  }),
  consistency: z.literal("best_effort"),
  completion: accessibilityCompletionSchema,
  metrics: accessibilityMetricsSchema,
  limits: accessibilityLimitsSchema,
});

export const accessibilitySnapshotSchema =
  accessibilityObservationSchema.extend({
    nodes: z.array(accessibilityNodeSchema),
  });

export const accessibilityQuerySchema = accessibilityObservationSchema
  .extend({
    status: z.enum(["found", "not_found", "ambiguous", "incomplete"]),
    matchCount: z.number().int().nonnegative(),
    matches: z.array(accessibilityNodeSchema).max(32),
    matchesTruncated: z.boolean(),
  })
  .superRefine((value, context) => {
    if (value.matches.length > value.matchCount) {
      context.addIssue({
        code: "custom",
        message: "matches cannot exceed matchCount",
        path: ["matches"],
      });
    }
    if (value.matchesTruncated !== value.matches.length < value.matchCount) {
      context.addIssue({
        code: "custom",
        message: "matchesTruncated must reflect omitted matches",
        path: ["matchesTruncated"],
      });
    }
    if (
      value.completion.status === "partial" &&
      value.status !== "incomplete"
    ) {
      context.addIssue({
        code: "custom",
        message: "partial observations must have incomplete query status",
        path: ["status"],
      });
    }
    if (
      value.completion.status === "complete" &&
      value.status === "incomplete"
    ) {
      context.addIssue({
        code: "custom",
        message: "complete observations cannot have incomplete query status",
        path: ["status"],
      });
    }
    if (value.status === "found" && value.matchCount !== 1) {
      context.addIssue({
        code: "custom",
        message: "found queries must have exactly one match",
        path: ["matchCount"],
      });
    }
    if (value.status === "not_found" && value.matchCount !== 0) {
      context.addIssue({
        code: "custom",
        message: "not_found queries cannot have matches",
        path: ["matchCount"],
      });
    }
    if (value.status === "ambiguous" && value.matchCount < 2) {
      context.addIssue({
        code: "custom",
        message: "ambiguous queries must have at least two matches",
        path: ["matchCount"],
      });
    }
  });

const boundedAccessibilityStringSchema = z.string().min(1).max(512);
const accessibilityRoleSchema = z.string().min(1).max(128);

export const accessibilityPredicateSchema = z
  .object({
    roles: z.array(accessibilityRoleSchema).min(1).max(16).optional(),
    name: boundedAccessibilityStringSchema.optional(),
    nameMatch: z.enum(["exact", "normalized"]).default("normalized"),
    requiredActions: z.array(accessibilityRoleSchema).max(16).optional(),
    enabled: z.boolean().optional(),
    ancestor: z
      .object({
        roles: z.array(accessibilityRoleSchema).min(1).max(16).optional(),
        name: boundedAccessibilityStringSchema.optional(),
        nameMatch: z.enum(["exact", "normalized"]).default("normalized"),
      })
      .strict()
      .refine(
        (value) => value.roles !== undefined || value.name !== undefined,
        {
          message: "ancestor must constrain role or name",
        },
      )
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.roles !== undefined ||
      value.name !== undefined ||
      (value.requiredActions?.length ?? 0) > 0 ||
      value.enabled !== undefined,
    { message: "predicate must include at least one constraint" },
  );

export const uiApplicationSelectorSchema = z.union([
  z.object({ processId: z.number().int().positive() }).strict(),
  z.object({ bundleIdentifier: z.string().min(1).max(512) }).strict(),
]);

export const uiQueryInputSchema = z.object({
  scope: uiApplicationSelectorSchema,
  target: accessibilityPredicateSchema,
  maxCandidates: z.number().int().min(1).max(32).default(20),
});

export const uiQueryCandidateSchema = z.object({
  id: z.string().regex(/^n\d+$/),
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  role: z.string().nullable(),
  subrole: z.string().nullable(),
  names: z.array(z.string()).max(5),
  frame: semanticRectSchema.nullable(),
  actions: z.array(z.string()),
  enabled: z.boolean().nullable(),
  focused: z.boolean().nullable(),
  selected: z.boolean().nullable(),
  expanded: z.boolean().nullable(),
  visible: z.boolean().nullable(),
});

export const uiQueryResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(["found", "not_found", "ambiguous", "uncertain"]),
    applicationMatchCount: z.number().int().nonnegative(),
    scope: z
      .object({
        application: z.object({
          processId: z.number().int().positive(),
          processInstanceId: processInstanceIdSchema,
          bundleIdentifier: z.string().nullable(),
          launchDate: z.iso.datetime().nullable(),
        }),
      })
      .nullable(),
    observation: z
      .object({
        observationId: z.string().min(1),
        source: z.literal("accessibility"),
        observedAtStart: z.iso.datetime(),
        observedAtEnd: z.iso.datetime(),
        consistency: z.literal("best_effort"),
        completion: accessibilityCompletionSchema,
        durationMs: z.number().nonnegative(),
      })
      .nullable(),
    matchCount: z.number().int().nonnegative(),
    candidates: z.array(uiQueryCandidateSchema).max(32),
    candidatesTruncated: z.boolean(),
    reasons: z.array(z.string().min(1)),
  })
  .superRefine((value, context) => {
    const applicationResolved = value.applicationMatchCount === 1;
    if (applicationResolved !== (value.scope !== null)) {
      context.addIssue({
        code: "custom",
        path: ["scope"],
        message: "scope must be present exactly when one application matched",
      });
    }
    if (!applicationResolved && value.observation !== null) {
      context.addIssue({
        code: "custom",
        path: ["observation"],
        message: "unresolved application scope cannot have an observation",
      });
    }
    if (applicationResolved && value.observation === null) {
      context.addIssue({
        code: "custom",
        path: ["observation"],
        message: "resolved application scope requires an observation",
      });
    }
    if (value.applicationMatchCount === 0 && value.status !== "not_found") {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "missing application scope must be not_found",
      });
    }
    if (value.applicationMatchCount > 1 && value.status !== "ambiguous") {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "multiple application matches must be ambiguous",
      });
    }
    if (value.observation === null && value.matchCount !== 0) {
      context.addIssue({
        code: "custom",
        path: ["matchCount"],
        message: "queries without an observation cannot have target matches",
      });
    }
    if (value.status === "found" && value.matchCount !== 1) {
      context.addIssue({
        code: "custom",
        path: ["matchCount"],
        message: "found ui_query results require one target match",
      });
    }
    if (value.status === "not_found" && value.matchCount !== 0) {
      context.addIssue({
        code: "custom",
        path: ["matchCount"],
        message: "not_found ui_query results cannot have target matches",
      });
    }
    if (
      value.status === "ambiguous" &&
      applicationResolved &&
      value.matchCount < 2
    ) {
      context.addIssue({
        code: "custom",
        path: ["matchCount"],
        message: "ambiguous target results require at least two matches",
      });
    }
    if (value.status === "uncertain" && !applicationResolved) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "uncertain status requires a resolved application observation",
      });
    }
    if (value.candidates.length > value.matchCount) {
      context.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "ui_query cannot return more candidates than target matches",
      });
    }
    if (
      value.candidatesTruncated !==
      value.candidates.length < value.matchCount
    ) {
      context.addIssue({
        code: "custom",
        path: ["candidatesTruncated"],
        message: "candidatesTruncated must reflect omitted target matches",
      });
    }
  });

const uiElementExistenceConditionSchema = z
  .object({
    kind: z.literal("element"),
    target: accessibilityPredicateSchema,
    state: z.enum(["appears", "disappears"]),
  })
  .strict();

const uiElementBooleanConditionSchema = z
  .object({
    kind: z.literal("element"),
    target: accessibilityPredicateSchema,
    state: z.enum(["enabled", "focused", "selected", "expanded"]),
    equals: z.boolean(),
  })
  .strict();

const uiWindowConditionSchema = z
  .object({
    kind: z.literal("window"),
    state: z.enum(["appears", "disappears"]),
    title: boundedAccessibilityStringSchema.optional(),
    titleMatch: z.enum(["exact", "normalized"]).default("normalized"),
  })
  .strict();

export const uiAtomicConditionSchema = z.union([
  uiElementExistenceConditionSchema,
  uiElementBooleanConditionSchema,
  uiWindowConditionSchema,
]);

export const uiConditionSchema = z.union([
  uiAtomicConditionSchema,
  z
    .object({
      allOf: z.array(uiAtomicConditionSchema).min(1).max(8),
    })
    .strict(),
  z
    .object({
      anyOf: z.array(uiAtomicConditionSchema).min(1).max(8),
    })
    .strict(),
]);

export const uiWaitInputSchema = z
  .object({
    scope: uiApplicationSelectorSchema,
    condition: uiConditionSchema,
    timeoutMs: z.number().int().min(0).max(30_000).default(10_000),
    pollIntervalMs: z.number().int().min(50).max(2_000).default(250),
  })
  .strict();

export const uiConditionEvaluationSchema = z
  .object({
    index: z.number().int().min(0).max(7),
    kind: z.enum(["element", "window"]),
    state: z.enum([
      "appears",
      "disappears",
      "enabled",
      "focused",
      "selected",
      "expanded",
    ]),
    status: z.enum(["satisfied", "unsatisfied", "uncertain"]),
    matchCount: z.number().int().nonnegative(),
    observedValue: z.boolean().nullable(),
    reason: z.string().min(1).nullable(),
  })
  .superRefine((value, context) => {
    if (value.status === "uncertain" && value.reason === null) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "uncertain condition evaluations require a reason",
      });
    }
    if (value.status !== "uncertain" && value.reason !== null) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "certain condition evaluations cannot have a reason",
      });
    }
  });

export const accessibilityWaitSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(["satisfied", "timed_out", "uncertain"]),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime(),
    durationMs: z.number().nonnegative(),
    pollCount: z.number().int().positive(),
    application: z.object({
      processId: z.number().int().positive(),
      processInstanceId: processInstanceIdSchema,
      bundleIdentifier: z.string(),
      launchDate: z.iso.datetime().nullable(),
    }),
    observation: accessibilityObservationSchema.nullable(),
    evaluations: z.array(uiConditionEvaluationSchema).max(8),
    reasons: z.array(z.string().min(1)),
  })
  .superRefine((value, context) => {
    if (
      value.observation !== null &&
      (value.application.processId !==
        value.observation.application.processId ||
        value.application.processInstanceId !==
          value.observation.application.processInstanceId ||
        value.application.bundleIdentifier !==
          value.observation.application.bundleIdentifier)
    ) {
      context.addIssue({
        code: "custom",
        path: ["observation", "application"],
        message: "wait application identity must match its final observation",
      });
    }
    if (value.status !== "uncertain" && value.observation === null) {
      context.addIssue({
        code: "custom",
        path: ["observation"],
        message: "satisfied and timed-out waits require a final observation",
      });
    }
    if (value.status === "satisfied" && value.reasons.length !== 0) {
      context.addIssue({
        code: "custom",
        path: ["reasons"],
        message: "satisfied waits cannot have rejection reasons",
      });
    }
    if (value.status === "uncertain" && value.reasons.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["reasons"],
        message: "uncertain waits require at least one reason",
      });
    }
    if (value.status !== "uncertain" && value.evaluations.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["evaluations"],
        message: "certain waits require condition evaluations",
      });
    }
  });

export const uiWaitResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(["satisfied", "timed_out", "uncertain"]),
    applicationMatchCount: z.number().int().nonnegative(),
    scope: z
      .object({
        application: z.object({
          processId: z.number().int().positive(),
          processInstanceId: processInstanceIdSchema,
          bundleIdentifier: z.string().nullable(),
          launchDate: z.iso.datetime().nullable(),
        }),
      })
      .nullable(),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime(),
    durationMs: z.number().nonnegative(),
    pollCount: z.number().int().nonnegative(),
    observation: accessibilityObservationSchema.nullable(),
    evaluations: z.array(uiConditionEvaluationSchema).max(8),
    reasons: z.array(z.string().min(1)),
  })
  .superRefine((value, context) => {
    const applicationResolved = value.applicationMatchCount === 1;
    if (applicationResolved !== (value.scope !== null)) {
      context.addIssue({
        code: "custom",
        path: ["scope"],
        message:
          "ui_wait scope must be present exactly when one application matched",
      });
    }
    if (!applicationResolved && value.status !== "uncertain") {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "unresolved ui_wait application scope must be uncertain",
      });
    }
    if (!applicationResolved && value.observation !== null) {
      context.addIssue({
        code: "custom",
        path: ["observation"],
        message:
          "unresolved ui_wait application scope cannot have an observation",
      });
    }
    if (value.status !== "uncertain" && value.observation === null) {
      context.addIssue({
        code: "custom",
        path: ["observation"],
        message: "certain ui_wait results require a final observation",
      });
    }
    if (value.status !== "uncertain" && value.pollCount < 1) {
      context.addIssue({
        code: "custom",
        path: ["pollCount"],
        message: "certain ui_wait results require at least one poll",
      });
    }
    if (value.status !== "uncertain" && value.evaluations.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["evaluations"],
        message: "certain ui_wait results require condition evaluations",
      });
    }
    if (
      value.observation !== null &&
      value.scope !== null &&
      (value.observation.application.processId !==
        value.scope.application.processId ||
        value.observation.application.processInstanceId !==
          value.scope.application.processInstanceId ||
        (value.observation.application.bundleIdentifier || null) !==
          value.scope.application.bundleIdentifier)
    ) {
      context.addIssue({
        code: "custom",
        path: ["observation", "application"],
        message: "ui_wait observation identity must match its resolved scope",
      });
    }
    if (value.status === "satisfied" && value.reasons.length !== 0) {
      context.addIssue({
        code: "custom",
        path: ["reasons"],
        message: "satisfied ui_wait results cannot have reasons",
      });
    }
    if (value.status === "uncertain" && value.reasons.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["reasons"],
        message: "uncertain ui_wait results require a reason",
      });
    }
  });

export const uiFillFieldInputSchema = z
  .object({
    target: accessibilityPredicateSchema,
    expectedTargetFingerprint: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
    value: z.string().max(4_096),
  })
  .strict();

export const uiFillInputSchema = z
  .object({
    scope: uiApplicationSelectorSchema,
    fields: z.array(uiFillFieldInputSchema).min(1).max(8),
    postcondition: uiConditionSchema,
    verificationTimeoutMs: z.number().int().min(0).max(15_000).default(3_000),
    pollIntervalMs: z.number().int().min(50).max(2_000).default(150),
  })
  .strict()
  .superRefine((value, context) => {
    const length = value.fields.reduce(
      (total, field) => total + field.value.length,
      0,
    );
    if (length > 8_192) {
      context.addIssue({
        code: "custom",
        path: ["fields"],
        message: "combined ui_fill value length may not exceed 8192 characters",
      });
    }
  });

export const uiActionSchema = z.enum([
  "press",
  "toggle",
  "focus",
  "increment",
  "decrement",
  "show_menu",
]);

const uiWorkflowActStepSchema = z
  .object({
    kind: z.literal("act"),
    target: accessibilityPredicateSchema,
    action: uiActionSchema,
    expectedTargetFingerprint: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
    precondition: uiConditionSchema.optional(),
    postcondition: uiConditionSchema,
    verificationTimeoutMs: z.number().int().min(0).max(15_000).default(3_000),
    pollIntervalMs: z.number().int().min(50).max(2_000).default(150),
  })
  .strict();

const uiWorkflowFillStepSchema = z
  .object({
    kind: z.literal("fill"),
    fields: z.array(uiFillFieldInputSchema).min(1).max(8),
    postcondition: uiConditionSchema,
    verificationTimeoutMs: z.number().int().min(0).max(15_000).default(3_000),
    pollIntervalMs: z.number().int().min(50).max(2_000).default(150),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.fields.reduce((total, field) => total + field.value.length, 0) >
      8_192
    ) {
      context.addIssue({
        code: "custom",
        path: ["fields"],
        message:
          "combined workflow fill value length may not exceed 8192 characters",
      });
    }
  });

const uiWorkflowWaitStepSchema = z
  .object({
    kind: z.literal("wait"),
    condition: uiConditionSchema,
    timeoutMs: z.number().int().min(0).max(30_000).default(10_000),
    pollIntervalMs: z.number().int().min(50).max(2_000).default(200),
  })
  .strict();

export const uiWorkflowStepSchema = z.discriminatedUnion("kind", [
  uiWorkflowActStepSchema,
  uiWorkflowFillStepSchema,
  uiWorkflowWaitStepSchema,
]);

export const uiWorkflowInputSchema = z
  .object({
    scope: uiApplicationSelectorSchema,
    steps: z.array(uiWorkflowStepSchema).min(1).max(8),
    timeoutMs: z.number().int().min(1_000).max(60_000).default(30_000),
  })
  .strict();

export const uiActInputSchema = z
  .object({
    scope: uiApplicationSelectorSchema,
    target: accessibilityPredicateSchema,
    action: uiActionSchema,
    expectedTargetFingerprint: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
    fallback: z.enum(["ax_only", "candidate_vision"]).default("ax_only"),
    visionTargetDescription: boundedAccessibilityStringSchema.optional(),
    precondition: uiConditionSchema.optional(),
    postcondition: uiConditionSchema,
    verificationTimeoutMs: z.number().int().min(0).max(15_000).default(3_000),
    pollIntervalMs: z.number().int().min(50).max(2_000).default(150),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.fallback === "candidate_vision" &&
      value.visionTargetDescription === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["visionTargetDescription"],
        message:
          "candidate_vision fallback requires a target description for local selection",
      });
    }
  });

const uiActTargetSchema = z.object({
  id: z.string().regex(/^n\d+$/),
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  role: z.string().nullable(),
  subrole: z.string().nullable(),
  names: z.array(z.string()).max(5),
  frame: semanticRectSchema.nullable(),
  actions: z.array(z.string()),
  enabled: z.boolean().nullable(),
  focused: z.boolean().nullable(),
});

const uiActPostconditionSchema = z.object({
  status: z.enum(["not_evaluated", "satisfied", "unsatisfied", "uncertain"]),
  pollCount: z.number().int().nonnegative(),
  evaluations: z.array(uiConditionEvaluationSchema).max(8),
});

const uiActJournalEntrySchema = z.object({
  phase: z.enum([
    "pre_dispatch",
    "dispatch_attempted",
    "verifying",
    "complete",
  ]),
  detail: z.string().min(1),
  at: z.iso.datetime(),
});

const uiActOutcomeShape = {
  schemaVersion: z.literal(1),
  outcome: z.enum(["not_dispatched", "verified", "indeterminate"]),
  phase: z.enum([
    "pre_dispatch",
    "dispatch_attempted",
    "verifying",
    "complete",
  ]),
  action: uiActionSchema,
  dispatchAttempted: z.boolean(),
  dispatchAcknowledged: z.boolean(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  durationMs: z.number().nonnegative(),
  target: uiActTargetSchema.nullable(),
  preconditionEvaluations: z.array(uiConditionEvaluationSchema).max(8),
  postcondition: uiActPostconditionSchema,
  journal: z.array(uiActJournalEntrySchema).max(16),
  reasons: z.array(z.string().min(1)),
};

function refineActOutcome(
  value: {
    outcome: "not_dispatched" | "verified" | "indeterminate";
    phase: "pre_dispatch" | "dispatch_attempted" | "verifying" | "complete";
    dispatchAttempted: boolean;
    dispatchAcknowledged: boolean;
    postcondition: { status: string };
    reasons: string[];
  },
  context: z.RefinementCtx,
): void {
  if (value.outcome === "not_dispatched" && value.dispatchAttempted) {
    context.addIssue({
      code: "custom",
      path: ["dispatchAttempted"],
      message: "not_dispatched outcomes cannot have attempted dispatch",
    });
  }
  if (value.outcome === "verified" && !value.dispatchAcknowledged) {
    context.addIssue({
      code: "custom",
      path: ["dispatchAcknowledged"],
      message: "verified outcomes require acknowledged dispatch",
    });
  }
  if (value.dispatchAcknowledged && !value.dispatchAttempted) {
    context.addIssue({
      code: "custom",
      path: ["dispatchAcknowledged"],
      message: "acknowledged dispatch requires an attempted dispatch",
    });
  }
  if (value.outcome === "verified" && value.phase !== "complete") {
    context.addIssue({
      code: "custom",
      path: ["phase"],
      message: "verified outcomes must complete the transaction",
    });
  }
  if (
    value.outcome === "verified" &&
    value.postcondition.status !== "satisfied"
  ) {
    context.addIssue({
      code: "custom",
      path: ["postcondition", "status"],
      message: "verified outcomes require a satisfied postcondition",
    });
  }
  if (value.outcome === "verified" && value.reasons.length !== 0) {
    context.addIssue({
      code: "custom",
      path: ["reasons"],
      message: "verified outcomes cannot have reasons",
    });
  }
  if (value.outcome !== "verified" && value.reasons.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["reasons"],
      message: "non-verified outcomes require at least one reason",
    });
  }
  if (value.outcome === "not_dispatched" && value.phase !== "pre_dispatch") {
    context.addIssue({
      code: "custom",
      path: ["phase"],
      message: "not_dispatched outcomes must stop before dispatch",
    });
  }
}

export const accessibilityActSchema = z
  .object({
    ...uiActOutcomeShape,
    application: z
      .object({
        processId: z.number().int().positive(),
        processInstanceId: processInstanceIdSchema,
        bundleIdentifier: z.string(),
        launchDate: z.iso.datetime().nullable(),
      })
      .nullable(),
    observation: accessibilityObservationSchema.nullable(),
  })
  .superRefine(refineActOutcome);

export const uiFillFieldResultSchema = z.object({
  index: z.number().int().nonnegative(),
  target: uiActTargetSchema.nullable(),
  valueStatus: z.enum(["not_evaluated", "verified", "mismatch", "uncertain"]),
  reason: z.string().min(1).nullable(),
});

const uiFillOutcomeShape = {
  schemaVersion: z.literal(1),
  outcome: z.enum(["not_dispatched", "verified", "indeterminate"]),
  phase: z.enum([
    "pre_dispatch",
    "dispatch_attempted",
    "verifying",
    "complete",
  ]),
  dispatchAttempted: z.boolean(),
  dispatchAcknowledged: z.boolean(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  durationMs: z.number().nonnegative(),
  fields: z.array(uiFillFieldResultSchema).min(1).max(8),
  postcondition: uiActPostconditionSchema,
  journal: z.array(uiActJournalEntrySchema).max(16),
  reasons: z.array(z.string().min(1)),
};

export const accessibilityFillSchema = z
  .object({
    ...uiFillOutcomeShape,
    application: z
      .object({
        processId: z.number().int().positive(),
        processInstanceId: processInstanceIdSchema,
        bundleIdentifier: z.string(),
        launchDate: z.iso.datetime().nullable(),
      })
      .nullable(),
    observation: accessibilityObservationSchema.nullable(),
  })
  .superRefine((value, context) => {
    refineActOutcome(value, context);
    refineFillOutcome(value, context);
  });

function refineFillOutcome(
  value: {
    outcome: "not_dispatched" | "verified" | "indeterminate";
    dispatchAttempted: boolean;
    fields: Array<{ index: number; valueStatus: string }>;
  },
  context: z.RefinementCtx,
): void {
  if (
    new Set(value.fields.map((field) => field.index)).size !==
    value.fields.length
  ) {
    context.addIssue({
      code: "custom",
      path: ["fields"],
      message: "ui_fill field indices must be distinct",
    });
  }
  if (
    value.outcome === "verified" &&
    value.fields.some((field) => field.valueStatus !== "verified")
  ) {
    context.addIssue({
      code: "custom",
      path: ["fields"],
      message: "verified ui_fill outcomes require every field value to verify",
    });
  }
  if (
    !value.dispatchAttempted &&
    value.fields.some((field) => field.valueStatus !== "not_evaluated")
  ) {
    context.addIssue({
      code: "custom",
      path: ["fields"],
      message: "pre-dispatch ui_fill outcomes cannot evaluate field values",
    });
  }
}

export const uiFillResultSchema = z
  .object({
    ...uiFillOutcomeShape,
    applicationMatchCount: z.number().int().nonnegative(),
    scope: z
      .object({
        application: z.object({
          processId: z.number().int().positive(),
          processInstanceId: processInstanceIdSchema,
          bundleIdentifier: z.string().nullable(),
          launchDate: z.iso.datetime().nullable(),
        }),
      })
      .nullable(),
    observation: accessibilityObservationSchema.nullable(),
  })
  .superRefine((value, context) => {
    refineActOutcome(value, context);
    refineFillOutcome(value, context);
    const applicationResolved = value.applicationMatchCount === 1;
    if (
      applicationResolved !== (value.scope !== null) &&
      value.outcome !== "indeterminate"
    ) {
      context.addIssue({
        code: "custom",
        path: ["scope"],
        message:
          "ui_fill scope must be present exactly when one application matched",
      });
    }
    if (!applicationResolved && value.observation !== null) {
      context.addIssue({
        code: "custom",
        path: ["observation"],
        message: "unresolved ui_fill application cannot have an observation",
      });
    }
    if (!applicationResolved && value.outcome !== "not_dispatched") {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "unresolved ui_fill application cannot dispatch",
      });
    }
  });

export const uiActResultSchema = z
  .object({
    ...uiActOutcomeShape,
    applicationMatchCount: z.number().int().nonnegative(),
    scope: z
      .object({
        application: z.object({
          processId: z.number().int().positive(),
          processInstanceId: processInstanceIdSchema,
          bundleIdentifier: z.string().nullable(),
          launchDate: z.iso.datetime().nullable(),
        }),
      })
      .nullable(),
    observation: accessibilityObservationSchema.nullable(),
  })
  .superRefine((value, context) => {
    refineActOutcome(value, context);
    const applicationResolved = value.applicationMatchCount === 1;
    if (!applicationResolved && value.scope !== null) {
      context.addIssue({
        code: "custom",
        path: ["scope"],
        message: "unmatched ui_act application scope must be null",
      });
    }
    // A resolved application can still lack verified identity when the helper
    // never returned the transaction result.
    if (
      applicationResolved &&
      value.scope === null &&
      value.outcome !== "indeterminate"
    ) {
      context.addIssue({
        code: "custom",
        path: ["scope"],
        message: "resolved ui_act application scope requires scope identity",
      });
    }
    if (!applicationResolved && value.outcome !== "not_dispatched") {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "unresolved ui_act application scope cannot dispatch",
      });
    }
    if (!applicationResolved && value.observation !== null) {
      context.addIssue({
        code: "custom",
        path: ["observation"],
        message:
          "unresolved ui_act application scope cannot have an observation",
      });
    }
  });

export type AccessibilityNode = z.infer<typeof accessibilityNodeSchema>;
export type AccessibilitySnapshot = z.infer<typeof accessibilitySnapshotSchema>;
export type AccessibilityQuery = z.infer<typeof accessibilityQuerySchema>;
export type AccessibilityPredicate = z.infer<
  typeof accessibilityPredicateSchema
>;
export type UiQueryInput = z.infer<typeof uiQueryInputSchema>;
export type UiQueryResult = z.infer<typeof uiQueryResultSchema>;
export type UiAtomicCondition = z.infer<typeof uiAtomicConditionSchema>;
export type UiCondition = z.infer<typeof uiConditionSchema>;
export type UiWaitInput = z.infer<typeof uiWaitInputSchema>;
export type AccessibilityWait = z.infer<typeof accessibilityWaitSchema>;
export type UiWaitResult = z.infer<typeof uiWaitResultSchema>;
export type UiWorkflowInput = z.infer<typeof uiWorkflowInputSchema>;
export type UiWorkflowStep = z.infer<typeof uiWorkflowStepSchema>;
export type UiFillInput = z.infer<typeof uiFillInputSchema>;
export type AccessibilityFill = z.infer<typeof accessibilityFillSchema>;
export type UiFillResult = z.infer<typeof uiFillResultSchema>;
export type UiAction = z.infer<typeof uiActionSchema>;
export type UiActInput = z.infer<typeof uiActInputSchema>;
export type AccessibilityAct = z.infer<typeof accessibilityActSchema>;
export type UiActResult = z.infer<typeof uiActResultSchema>;
