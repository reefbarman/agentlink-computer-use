# AGENTS.md

## Project

This repository implements a local macOS computer-use MCP server:

- TypeScript exposes MCP tools and validates native responses.
- Swift performs privileged macOS discovery, capture, and input operations.
- The native helper communicates over protocol-v1 NDJSON on stdio.

## Commands

Use repository scripts for common operations instead of invoking `tsc`, `vitest`, `swift build`, or built binaries directly. Stable script prefixes can be approved once and reused.

- `npm run build` — build TypeScript.
- `npm run build:native:debug` — build the Swift helper for debugging.
- `npm run build:native` — build the Swift helper for release.
- `npm run typecheck` — type-check production and test TypeScript.
- `npm test` — run unit and MCP contract tests.
- `npm run test:integration` — build and run serialized native/MCP integration tests.
- `npm run test:smoke` — run interactive discovery/focus smoke tests.
- `npm run test:mouse-smoke` — run real mouse events against the disposable test target.
- `npm run test:keyboard-smoke` — run real keyboard events against the disposable test target.
- `npm run validate` — run type-checking, unit tests, and integration tests.

Use direct shell commands only for one-off diagnostics without an existing script. Add or extend an npm/script entry when a command becomes part of the normal workflow.

## Safety and correctness constraints

### Native input

- Keep all mutable input state and input dispatch serialized on `MainActor`.
- Track held mouse buttons, keyboard keys, and modifiers; release them after partial composite-operation failures and during helper shutdown.
- Keep `input_release_all` safe and idempotent.
- Reject ambiguous multi-button movement/drag operations before posting additional input events.
- Do not weaken cursor verification tolerances to hide nondeterministic movement.
- Keep native operation limits and MCP schema limits aligned.
- Ensure client timeouts exceed the maximum valid native operation duration with scheduling margin.

### Interactive tests

- Never send click, drag, button-down, nonzero scroll, or keyboard events to the user's active applications during tests.
- Run real mouse-event tests only against `MouseTestTarget` through `npm run test:mouse-smoke`.
- Run real keyboard-event tests only against `KeyboardTestTarget` through `npm run test:keyboard-smoke`.
- Always restore the original cursor position where relevant and call `input.releaseAll` in cleanup paths.

### Screen capture

- Keep ScreenCaptureKit objects confined to `MainActor`; they are non-Sendable under Swift 6.
- Reuse helper-owned shareable content to avoid repeated discovery hangs.
- Run ScreenCaptureKit integration tests serially; do not enable file-level parallelism.
- Do not expose native artifact paths through MCP responses.
- Keep capture artifacts private, validate ownership/mode/path/hash/MIME, consume them once, and delete them after use or failure.

### Native helper lifecycle

- A timed-out or malformed helper is not reusable: reject its pending requests, terminate it, and start a fresh helper for the next request.
- Ignore late stdout/stderr lifecycle events from stale helper processes.
- Ensure no helper or disposable target processes remain after tests.

## Validation expectations

For routine TypeScript changes, run:

```text
npm run typecheck
npm test
```

For native protocol, capture, process-lifecycle, or input changes, also run:

```text
npm run test:integration
```

For changes that post real mouse or keyboard input, also run the relevant disposable-target smoke test:

```text
npm run test:mouse-smoke
npm run test:keyboard-smoke
```

Keep smoke-test notes concise and checklist-based.
