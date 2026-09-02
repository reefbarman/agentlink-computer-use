# Accessibility Discovery Spike

This benchmark evaluates whether bounded macOS Accessibility (AX) discovery can replace repeated screenshot/click loops for native controls. It is benchmark-only: no MCP tools are registered and no AX actions, mouse events, keyboard events, screenshots, or model calls occur.

## Safety

The runner launches `SemanticWorkflowTestTarget` in passive mode. Its disposable window is ordered onscreen for AX inspection but is not intentionally activated or made key.

The native operations are read-only:

- `accessibility.snapshot` traverses a target process's AX tree.
- `accessibility.query` traverses and applies semantic predicates.
- Neither operation calls `AXUIElementPerformAction` or posts `CGEvent` input.
- Secure text values are never read or returned.
- Default content is redacted; the synthetic fixture benchmark explicitly opts into fixture labels.

## Run

```sh
npm run benchmark:ax-discovery
```

Fast smoke run:

```sh
npm run benchmark:ax-discovery -- \
  --repetitions 1 \
  --output benchmark-results/ax-discovery-smoke.json
```

Options:

- `--repetitions N`
- `--output PATH`

Accessibility permission must be granted to the process hosting the native helper. The command fails closed when permission is unavailable. Do not run another release-path `ComputerUseNative` helper concurrently; start the benchmark from a clean helper state so lifecycle and latency measurements remain attributable to one process.

## Cases

Each repetition evaluates:

1. Exact button name, role, action, and enabled state.
2. Normalized checkbox name with punctuation/case differences.
3. Text field qualified by a named window ancestor.
4. Ambiguous role-only button query.
5. Absent target.
6. Deliberately node-limited traversal, which must return `incomplete` rather than authoritative `found` or `not_found`.

Traversal is breadth-first and bounded by deadline, per-message timeout, depth, node count, child count, string length, and serialized result bytes. Results carry process identity, launch date, consistency, completion reasons, AX error categories, and native work counts.

## Output

The atomic mode-`0600` JSON result includes snapshot/query latency, response bytes, nodes visited, AX calls, exact query outcomes, and aggregate pass rate. It records executable basenames only and contains no screenshots, base64 data, native artifact paths, or absolute executable paths.

This spike establishes discovery behavior, not production `find_and_click` confidence. A production tool would still need freshness checks, action-point validation, overlap/visibility checks, post-action semantic verification, and visual fallback for inaccessible or canvas-rendered UI.

## Smoke checklist

- [ ] Fixture appeared without taking keyboard focus.
- [ ] Snapshot completed within configured bounds.
- [ ] Unique, ambiguous, absent, and incomplete outcomes matched expectations.
- [ ] No mouse or keyboard input occurred.
- [ ] No helper was running before the benchmark started.
- [ ] No helper or fixture process remains.
