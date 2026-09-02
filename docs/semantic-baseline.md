# Semantic Computer-Use Experiment 0 Baseline

This benchmark measures the current repository's lower-bound workflow cost before Accessibility, OCR, local grounding, or semantic execution is added. It does not register new MCP tools or send input to real applications.

## Safety

The benchmark launches `SemanticWorkflowTestTarget`, a disposable AppKit fixture. It sends input only after activating that target and uses fixture-emitted global logical-point ground truth.

Cleanup always:

- calls `input.releaseAll`;
- restores the original cursor position;
- closes the in-memory MCP client/server and native helper;
- terminates the fixture process.

Do not run another release-path `ComputerUseNative` helper concurrently. Same-path helpers can interfere with ScreenCaptureKit exclusion and invalidate capture timing.

## Routes

- `oracle` — direct native requests using fixture-emitted coordinates. This is the harness/native lower bound, not a realistic agent strategy.
- `primitive` — current MCP tools with one top-level MCP call per input operation.
- `input_batch` — current MCP discovery/capture plus one `input_batch` call per workflow.

All routes execute the same three deterministic workflows:

1. Enter and submit text.
2. Enable a checkbox.
3. Enable the checkbox, enter text, and submit.

The target reports exact semantic actions, final state, forbidden-action count, and the number of helper-tagged input events it received. Event dispatch alone never counts as task success.

## Run

```sh
npm run benchmark:semantic-baseline
```

Fast smoke run:

```sh
npm run benchmark:semantic-baseline -- \
  --routes oracle,primitive,input_batch \
  --repetitions 1 \
  --output benchmark-results/semantic-baseline-smoke.json
```

Options:

- `--routes oracle,primitive,input_batch`
- `--repetitions N`
- `--output PATH`

## Output

The atomic JSON result includes:

- Fixture and harness source hashes.
- Route/workflow/repetition and semantic pass/fail.
- Top-level MCP calls, native requests, captures, capture bytes, and observed input events. `nativeRequests` includes every helper request: each MCP capture expands to `health` plus `screen.capture`, while direct oracle capture performs the same two requests. Setup/reset/cursor-neutralization and cleanup are excluded from per-trial counts for every route.
- Per-operation MCP/native/target durations and bounded request/response byte counts.
- p50/max route duration and mean work counts; p95 remains `null` and `p95Qualified` is false until a route has at least 30 trials.
- An explicit `cloudBaseline.status: "not_run"` marker.

The scripted primitive routes are deterministic lower bounds, not an observed cloud-driver baseline. A later cloud series must pin provider/model, prompts, MCP schema, sampling settings, and context policy.

The result never includes screenshot/base64 content or native artifact paths. Fixture labels and text are synthetic and non-sensitive. `inputEvents` counts helper-tagged events delivered to the fixture; AppKit may coalesce movement events, so it is an observed target-load metric rather than an exact count of every posted CGEvent.

## Smoke checklist

- [ ] Only `SemanticWorkflowTestTarget` received input.
- [ ] All workflows reached exact expected semantic state.
- [ ] Forbidden-action count remained zero.
- [ ] Original cursor position was restored.
- [ ] `input.releaseAll` ran during cleanup.
- [ ] No helper or fixture process remains.
