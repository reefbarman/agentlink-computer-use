# AgentLink macOS sandbox compatibility notes

## Context

Repository: `agentlink-computer-use`

Environment observed on 2026-07-22:

- macOS on Apple Silicon
- Swift 6 / Xcode macOS SDK 26.5
- AgentLink `workspace-write` sandbox
- Sandbox backend: Seatbelt
- Sandbox policy: `2026-07.sandbox.v2`

This project builds a SwiftPM native helper and runs AppKit/CoreGraphics integration tests. The notes below separate confirmed sandbox-compatible operations from confirmed failures.

## Summary

| Operation                                      | In AgentLink sandbox | Native/escalated    | Notes                                                         |
| ---------------------------------------------- | -------------------- | ------------------- | ------------------------------------------------------------- |
| TypeScript typecheck/unit tests                | Works                | Works               | `npm run typecheck`, `npm test`                               |
| Direct Swift source typecheck                  | Works                | Works               | Requires `-parse-as-library` for this `@main` source          |
| SwiftPM build through repository script        | Fails                | Works               | Nested `sandbox-exec` is rejected                             |
| Launch AppKit disposable test window           | Fails                | Works/expected      | Human Interface Services XPC connection is invalid in sandbox |
| Post real `CGEvent` input to disposable window | Not reached          | Requires native run | Sandbox target never becomes a usable GUI app                 |
| Query host process table with `pgrep`          | Fails                | Works               | `sysmond service not found`                                   |

## What works in the sandbox

### TypeScript and Vitest unit tests

These commands run successfully in the `workspace-write` sandbox:

```text
npm run typecheck
npm test
```

Observed result during this work:

```text
Test Files  3 passed (3)
Tests       33 passed (33)
```

### Direct Swift compiler typechecking

A direct compiler invocation works when the source is compiled in the correct mode:

```text
xcrun swiftc \
  -parse-as-library \
  -typecheck \
  -swift-version 6 \
  -target arm64-apple-macosx14.0 \
  -module-cache-path native/.build/module-cache \
  native/Sources/ComputerUseNative/ComputerUseNative.swift
```

This exits successfully. It may print non-fatal warnings such as:

```text
DVTFilePathFSEvents: Failed to start fs event stream.
```

A prior run without `-parse-as-library` produced `@main`/top-level-code errors. Those were compiler-mode errors, not sandbox failures.

## What does not work in the sandbox

### 1. SwiftPM build: nested Seatbelt sandbox failure

Repository command:

```text
npm run build:native:debug
```

The repository script invokes `swift build`. SwiftPM then invokes macOS `sandbox-exec` while compiling the package manifest. Inside AgentLink's existing Seatbelt sandbox, the nested sandbox application fails:

```text
error: 'native': Invalid manifest
sandbox-exec: sandbox_apply: Operation not permitted
error: ExitCode(rawValue: 1)
```

The same approved repository command succeeds when AgentLink runs it natively/escalated.

This appears to be a sandbox-composition problem, not a filesystem permission or Swift source problem.

Suggested AgentLink improvements:

- Detect SwiftPM commands that invoke nested `sandbox-exec` and route approved build scripts natively.
- Or provide a sandbox profile/launch path that permits SwiftPM's nested manifest sandbox.
- Preserve whitelistability at the repository-script level (`npm run build:native:*`) even when the execution route must be native.

### 2. AppKit GUI target: Human Interface Services XPC unavailable

After building release binaries natively, this command was run inside AgentLink's sandbox:

```text
npx vitest run tests/keyboard-smoke.test.ts
```

The test spawned the already-built `KeyboardTestTarget`, so SwiftPM was not involved. The child process started but AppKit logged:

```text
Connection Invalid error for service com.apple.hiservices-xpcservice.
Error received in message reply handler: Connection invalid
+[NSXPCSharedListener endpointForReply:withListenerName:replyErrorCode:]:
an error occurred while attempting to obtain endpoint for listener
'ClientCallsAuxiliary': Connection invalid
```

The application never became a key window and never emitted its `ready` event. The test timed out before any keyboard input was posted.

This isolates a host GUI/XPC restriction in the sandbox profile. It is independent of the SwiftPM nested-sandbox failure.

Suggested AgentLink improvements:

- Add an explicit local-GUI test capability/profile that permits required AppKit/WindowServer/Human Interface Services XPC connections.
- Or recognize approved interactive smoke scripts and route them natively while retaining explicit approval and audit information.
- Surface a clearer diagnostic when a sandboxed child tries to use AppKit but required host services are unavailable.

### 3. Host process enumeration unavailable

This diagnostic fails inside the sandbox:

```text
pgrep -afil 'ComputerUseNative|KeyboardTestTarget|MouseTestTarget'
```

Observed output:

```text
sysmon request failed with error: sysmond service not found
pgrep: Cannot get process list
```

This prevents arbitrary host process leak checks from sandboxed commands. Test-owned child processes can still be tracked and cleaned up directly by PID/child-process handles.

Suggested AgentLink improvements:

- Permit read-only process enumeration for approved diagnostics, or provide an AgentLink-native process query scoped to descendants/workspace binaries.
- Document that `pgrep`/`ps` host enumeration is unavailable under the current macOS sandbox profile.

## Approval/routing behavior that worked

- AgentLink showed escalation approval when native execution was requested.
- After approval, the same repository script ran successfully through the native route.
- Tool results clearly identified `execution_mode`, sandbox profile, audit ID, and whether approval was human/rule-based.
- A rejected escalation did not execute the command.

## Recommended routing policy

For this class of local macOS project:

1. Keep TypeScript checks, unit tests, and direct read-only compiler checks sandboxed.
2. Run SwiftPM builds natively after repository-script approval because nested `sandbox-exec` fails.
3. Run AppKit/CoreGraphics interactive smoke tests natively after explicit approval because required GUI/XPC services are unavailable in the sandbox.
4. Keep command approval anchored to stable repository scripts:
   - `npm run build:native:debug`
   - `npm run build:native`
   - `npm run test:integration`
   - `npm run test:mouse-smoke`
   - `npm run test:keyboard-smoke`
5. Do not broadly disable sandboxing for ordinary TypeScript/test commands.

## Minimal reproductions

### SwiftPM nested sandbox

```text
npm run build:native:debug
```

Expected in current AgentLink sandbox: manifest compilation fails with `sandbox_apply: Operation not permitted`.

### AppKit host-service restriction

First build the target outside the sandbox:

```text
npm run build:native
```

Then inside the AgentLink sandbox:

```text
npx vitest run tests/keyboard-smoke.test.ts
```

Expected in current sandbox: `com.apple.hiservices-xpcservice` connection invalid; target does not emit `ready`.

### Direct Swift typecheck control case

```text
xcrun swiftc \
  -parse-as-library \
  -typecheck \
  -swift-version 6 \
  -target arm64-apple-macosx14.0 \
  -module-cache-path native/.build/module-cache \
  native/Sources/ComputerUseNative/ComputerUseNative.swift
```

Expected in current sandbox: exits successfully, demonstrating that basic `swiftc` execution and workspace/module-cache access work.
