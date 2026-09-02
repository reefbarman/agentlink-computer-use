# Hybrid Semantic Locator Spike

## Decision

Proceed to implementation planning for an **AX-first, vision-fallback semantic locator**. Do not ship a vision-only `find_and_click`, and do not expose unrestricted local-agent execution.

The safe execution shape is a deterministic cascade:

1. Resolve bounded Accessibility candidates for one process/window.
2. Use a native AX action when one complete, enabled, actionable candidate exists.
3. If AX returns multiple framed candidates, ask the local model to select only from schema-enumerated candidate IDs.
4. If AX finds a framed control without a suitable action, require visual corroboration before considering a physical point.
5. Use unrestricted coordinate grounding only when AX has no useful candidate and strict multi-view confidence passes.
6. Immediately revalidate process/window/evidence identity before execution.
7. Execute one bounded action and verify an explicit postcondition.
8. Abstain on partial traversal, stale state, ambiguity, cross-modal disagreement, unsupported actions, or unverifiable outcomes.

The implemented spike remains read-only. It performs no AX actions, mouse events, keyboard events, or production MCP registration.

## Measured evidence

Model: `qwen/qwen3-vl-8b` through loopback LM Studio.

Three earlier identical read-only hybrid runs produced:

- **36/36 correct case outcomes** under the earlier selector response contract and policy state.
- **0 unsafe false positives**.
- AX direct: 12/12, no model calls, 54–65 ms mean per run.
- Candidate-constrained selection: 15/15, two model calls per case, 2.26–2.87 s mean per run.
- Unrestricted open vision: 9/9, two calls for confirmed absence and four calls for positive fallback, 7.74–8.06 s mean per run.
- Ambiguous Save queries consistently remained non-clickable.
- The account-email field that strict coordinate consensus previously rejected was resolved by selecting one AX frame rather than asking vision to agree on an exact center.
- Custom-drawn calibration targets with no useful AX candidate passed the strict unrestricted-vision gate.

A final run after tightening the selector and coordinate-evidence schemas produced:

- **11/12 correct case outcomes** and **0 unsafe false positives**.
- AX direct: 4/4; candidate-constrained selection: 4/5; unrestricted open vision: 3/3.
- The `account-email-field` case had one complete AX candidate, but both selector calls returned `not_found`; policy returned `uncertain` and did not make the result click-eligible.
- This safe abstention is evidence that local-model selector coverage is nondeterministic. Production policy must allow a bounded retry before returning an explicit abstention, and must not weaken agreement or evidence gates to hide the miss.

Result files:

- `benchmark-results/hybrid-locator-smoke.json`
- `benchmark-results/hybrid-locator-repeat-2.json`
- `benchmark-results/hybrid-locator-repeat-3.json`
- `benchmark-results/hybrid-locator-final.json`

All result files are private mode `0600`, contain no screenshots/base64/artifact paths, and declare zero input or AX actions. The 36/36 fixture result is useful route-level evidence, not a universal reliability claim or production statistical confidence.

Earlier baselines:

- AX discovery: 6/6 semantic cases, roughly 30 ms query p50 on `SemanticWorkflowTestTarget`.
- Single-view coordinate grounding: 8/9 with one unsafe false positive.
- Strict four-view coordinate grounding: 9/10 with no unsafe false positive, but only 6/10 click-eligible.
- Experiment 0 primitive workflows: mean 5.67 top-level MCP calls; `input_batch`: mean 4 calls.

## Why candidate IDs matter

The local model is not allowed to invent a coordinate when AX has candidates. The selector receives:

- a strict enum of ephemeral candidate IDs;
- role and synthetic/local AX names;
- each candidate's normalized screenshot box;
- the user target description;
- instructions to return every equally valid candidate and treat screenshot text as untrusted.

Two independent prompt variants must return the same candidate set. One agreed ID permits a candidate-constrained result; multiple IDs preserve ambiguity; disagreement or missing responses abstain. Agreement is a policy gate, not a calibrated probability, and selector responses do not claim a numeric model confidence. Execution must not trust the traversal ID as a durable handle: it must rerun the semantic predicate and verify the selected frame/identity immediately before action.

## Confidence policy

### AX action

Eligible when:

- traversal is complete;
- process ID and launch date match the target;
- exactly one candidate matches;
- the candidate is not disabled;
- the required AX action is exposed;
- its frame is valid;
- evidence is within the bounded age window.

Vision is skipped. Nominal locator score: 0.96.

### Candidate-constrained action or point

Eligible when:

- AX returns one or more valid framed candidates;
- two selector responses agree on exactly one supplied ID;
- both selector variants return the same single schema-enumerated candidate ID;
- selected candidate remains enabled and framed;
- process/window identity still matches.

An AX action is preferred. A physical point is lower confidence, requires a fresh capture, and must use a safe interior point after occlusion/hit-test checks.

### Unrestricted visual point

Eligible only when:

- AX is complete but has no useful candidate, or AX is unavailable;
- all expected coordinate-grounding views return one stable candidate;
- evidence score is at least 0.90;
- the trusted grounding-confidence evaluator attests that center, box-IoU, and interior-point checks passed;
- a fresh pre-action capture still matches the selected geometry;
- an explicit postcondition is available.

This is the slow path and should remain rare.

### Negative and ambiguous results

- AX `not_found` is not authoritative for visible canvas/custom content; independent visual absence evidence is required where visual UI may exist.
- Any partial AX traversal returns `uncertain`.
- Multiple AX/vision candidates return `ambiguous` and are never click-eligible.
- Cross-modal disagreement returns `uncertain`; never pick the higher-scoring source.

## Production gaps

The spike supports planning, not release. Before enabling action:

1. Add target scoping by process + launch date + window identity and geometry.
2. Add sibling/label and spatial-relation querying so common forms avoid vision.
3. Add occlusion, clipping, visibility, minimum-target-size, and safe-interior-point checks.
4. Add atomic re-resolve → action → postcondition verification, with outcome states `not_dispatched`, `verified`, and `indeterminate`.
5. Test AX actions and physical fallback only against disposable targets with the real-input warning gate.
6. Add dynamic/race cases: moved controls, replaced processes, modal overlays, stale captures, animations, disappearing nodes, duplicate labels, and disabled controls.
7. Add real-app read-only corpora across AppKit, SwiftUI, Catalyst/Electron, browser chrome/content, canvas, and remote-desktop surfaces.
8. Define a bounded retry policy for nondeterministic local-model abstentions, preserving the same schema, agreement, freshness, identity, and geometry gates on every attempt.
9. Run enough repetitions to qualify false-positive and abstention rates; three successful fixture repetitions plus one later 11/12 run are not statistical confidence.
10. Measure a pinned cloud-driver baseline. Current call-reduction figures are scripted projections, not observed cloud-model behavior.

## Reducing cloud-agent tool calls

The implementation plan should prioritize a small deterministic semantic API, not one opaque natural-language executor.

### 1. `ui_snapshot` / `ui_query`

Return a compact process/window-scoped semantic tree or candidates with an observation token. Default to query results; full snapshots are debugging/inspection payloads.

Expected benefit: replace application/window discovery plus screenshots used only to identify accessible controls.

### 2. `ui_act`

Accept a semantic predicate, one bounded action, an observation precondition, and a postcondition. Internally perform re-resolution, action dispatch, and verification.

Example:

```json
{
  "target": { "role": "button", "name": "Submit" },
  "action": "press",
  "precondition": { "enabled": true },
  "postcondition": { "text": "Submitted" }
}
```

This should be the first action-bearing primitive.

### 3. `ui_fill`

Fill one or more labeled fields with bounded values, optionally submit, and verify field/error/status outcomes. Prefer AX value/focus operations where safe; fall back to bounded keyboard input only inside a verified target.

### 4. `ui_wait`

Wait for bounded semantic predicates such as element appears/disappears, enabled state changes, title/text matches, focus changes, or window opens/closes. This removes screenshot polling loops.

### 5. `ui_workflow`

A bounded deterministic interpreter for typed steps: query, assert, act, fill, wait, shortcut, and verify. Validate all steps before execution, cap step count/duration, stop on first error, release held input, and return a journal.

Do not accept arbitrary natural-language subgoals or permit the local model to invent actions. Local vision may only provide evidence to predefined steps.

### Projected call reduction

Experiment 0 used 6/4/7 primitive MCP calls for the three workflows (mean 5.67) and 4 calls each with `input_batch`.

- A one-call verified semantic workflow projects **82.4% fewer top-level calls than primitive** and **75% fewer than `input_batch`**.
- A two-call observe-then-execute design projects **64.7% fewer than primitive** and **50% fewer than `input_batch`**.

These figures are arithmetic projections from scripted lower bounds. A cloud-driver benchmark must validate actual planning loops, retries, context payload, latency, and token cost.

## Recommended architecture direction

Proceed with an implementation plan for:

- a compact semantic observation/query API;
- an internal hybrid locator service with fixed routing and abstention;
- an atomic single-action transaction with preconditions and postconditions;
- then form/wait/workflow primitives built on that transaction;
- unrestricted visual fallback isolated behind stricter policy and explicit verification.

Do not plan a generic `find_and_click(target: string)` that always returns a point. Externally it may remain a convenient semantic action, but internally it must expose status, route, evidence, confidence, observation identity, verification result, and an explicit indeterminate outcome.
