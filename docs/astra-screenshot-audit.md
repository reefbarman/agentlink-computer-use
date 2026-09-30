# Astra screenshot transport audit

## Scope and decision

Improve guidance for the current MCP tools, then check that synthetic screenshot bytes and their geometry reach the host's Astra request boundary without unexplained changes. Do not change image detail defaults, native input behaviour, tool permissions or the executor based on source comparison alone.

The source trace preserves image bytes through the inspected normalisation and translation functions. Astra OAuth uses Responses Lite, which deliberately omits image `detail`. Adding `codex/imageDetail: original` to MCP output would therefore not establish a fidelity improvement on this route.

This is an outgoing-request audit, not a claim about provider-internal image processing or Astra localisation accuracy.

## Audited sources

- MCP base revision: `6484d51a49a1c07ff0ce6693d23c6b6c70ffe6e5`, plus this task's guidance and test changes.
- Host location: `../agentlink`, confirmed by the user before inspection.
- Host base revision: `a3fc28e93046cdec2017137a2f273515bd606763`. The working tree contains substantial unrelated changes, including Engine and Codex provider changes. Results apply to the inspected working tree, not just that commit.
- Target route: `gpt-6-astra`, OAuth, Responses Lite. No credentials or live request payloads were inspected.
- Initial source audit did not establish installed-build parity. The subsequent live check below matched the installed 1.22.27 bundle to the checkout bundle and inspected the relevant compiled functions.

Host source SHA-256 values recorded during inspection:

| File under `../agentlink`                    | SHA-256                                                            |
| -------------------------------------------- | ------------------------------------------------------------------ |
| `src/agent/mcpToolResult.ts`                 | `b4d9f5e750257b506ade688c590bc47d1cc6186814a24e39c10dda16a368fa14` |
| `src/agent/AgentEngine.ts`                   | `3465480ceadd0fd7daa72847f84e4cbe74ce57206625b12b65f5155f9e61bef2` |
| `packages/core/src/codex/translation.ts`     | `878f0ae19376aa8320ba13c89af582c1ebbe766f0e72f581ea66f6ee56102be9` |
| `packages/core/src/codex/models.ts`          | `3c6eca9aa7ff896a40e30488e0be0e910875e7e6e1c5524d85de76e6b0f89898` |
| `src/agent/providers/codex/CodexProvider.ts` | `77f72f64c9331e0de236a512d3a7435cc2a8786f4fad464ac463953f40987063` |

## Request path

1. MCP `src/tools/capture.ts` returns image data and capture metadata, including SHA-256, pixel size, timestamp and pixel-to-global-point mapping. `src/tools/post-action-capture.ts` preserves successful interaction results separately from capture errors.
2. Host `src/agent/mcpToolResult.ts` copies image data/MIME into normalised content and stores `_meta` separately in `mcpMeta`. Structured content becomes model-visible text when it is not an exact duplicate of an existing text block.
3. Host `src/agent/AgentEngine.ts` serialises tool results into model text/image blocks. Image data is copied, not decoded or resized in the inspected serializer. Text is subject to truncation.
4. Host `packages/core/src/codex/translation.ts` emits tool text as a function result and images in an immediately following user message labelled with the tool-call ID. The images remain tool-origin evidence, not user authorisation. Translation initially supplies `detail: auto`.
5. `usesCodexResponsesLite` selects the Lite route for Astra OAuth. The final body builder strips image-detail fields. The Codex provider uses that body builder for requests.

MCP-specific image-detail metadata is not forwarded into the model image block in this path. That is an interoperability observation, not a demonstrated Astra defect. Do not change the Lite wire contract to preserve an unsupported field.

## Coordinate coverage

Existing `imageToScreen` and `screenToImage` helpers remain unchanged. `tests/grounding.test.ts` now checks:

- logical (1×), Retina-style (2×) and downscaled (0.5×) mappings;
- a cropped region with negative global X and nonzero Y;
- two successive captures whose scale and origin differ;
- round trips through the production helpers.

These tests validate supplied mapping arithmetic, not real ScreenCaptureKit geometry, physical clicking or automatic stale-capture rejection. Physical tools still accept global logical points, not a capture-relative token. The guide explicitly requires current evidence and matching metadata.

The guide's accessible workflow was parsed with `uiWorkflowInputSchema`, and its visual point was checked against `imageToScreen` from the built source.

## Host boundary result

`../agentlink/src/agent/codexScreenshotAudit.test.ts` composes the existing production normaliser, exported Engine serializer, Codex translator and final body builder. Three cases passed across Astra OAuth and API-key request shapes:

- Standalone PNG capture followed by a JPEG post-action capture: exact bytes, SHA-256, MIME, byte length, geometry text and tool-call association survive. PNG dimensions are decoded; JPEG coverage checks byte identity and framing only, not decoding or validity.
- Separate MCP metadata is retained in the normalised result but not forwarded into model-visible image blocks. An explicit `codex/imageDetail: original` hint does not override the current host behaviour: OAuth Lite omits detail, API-key requests use `auto`.
- A successful interaction with `captureError` stays text-only and does not become a tool error or acquire a stale image.

The test uses package imports, consistent with the host's existing TypeScript module boundary. `@agentlink/core/codex` resolved to `packages/core/dist/cjs/codex.cjs`, SHA-256 `0a7bedfe8fb80560b827e787fb67398203a7ac3f551b735044c9b1fe2a55f1fe`. Separate core translation tests exercise current source. The package was not rebuilt over the unrelated dirty host tree; this is not a fresh-source-to-installed-build parity claim. Audit test SHA-256: `800bbdd3149c416f4df63b420dd3c260f625e7206ce7a4b36cdf2df1692ba2da`.

No byte-loss or capture-association defect was demonstrated in these bounded cases. No production host fix is proposed. The MCP's pretty-printed JSON and compact `structuredContent` representation can both appear in host text because deduplication uses exact string equality. This is redundant context, not lost geometry; it is not changed in this audit.

## Validation

- `npm run typecheck`: passed.
- `npm test`: 121 tests passed before the four additional coordinate cases.
- `npm test -- -t 'grounding geometry|observation boundaries'`: 10 passed, 115 skipped after adding those cases.
- `npm run build`: passed.
- `git diff --check`: passed for the code/test diff.
- Host: `./node_modules/.bin/vitest run src/agent/codexScreenshotAudit.test.ts src/agent/mcpToolResult.test.ts`: 8 passed.
- Host: `npm test --workspace @agentlink/core -- src/codex/translation.test.ts`: 24 passed.
- Host audit file: Oxfmt check passed; VS Code reports no diagnostics.

The direct installed Vitest invocation was used as a one-off scoped diagnostic: the host's root `npm test` chains builds and unrelated suites rather than accepting a simple scoped filter. Full host lint/test was skipped for this test-only audit on a heavily modified tree. No host scripts or production modules were edited.

## Live read-only check, 2026-09-08

### Parity

The installed `agentlink.agentlink-1.22.27/dist/extension.js` and `../agentlink/dist/extension.js` are byte-identical: SHA-256 `4139874fff19f50dfd13377f0301a6d15c203d16b570513b1333025500ff3c17`, 11,872,716 bytes. All five audited source hashes above remained unchanged. The bundled normaliser, Engine serializer, Codex translator and Lite detail-stripping functions were inspected and match the audited behaviour.

This establishes on-disk bundle identity and relevant behavioural parity, not a reproducible-build attestation or an in-memory extension-host measurement. The observer resolved to native AgentLink provider `codex`, model `gpt-6-astra`, reasoning `high`, with no provider fallback. Credentials and the live HTTP exchange were not inspected, so the actual authentication route was not independently attested. OAuth/Lite and API-key request shapes were covered separately by the earlier boundary tests.

The connected MCP still advertised the previous capture description. This check exercises its unchanged capture implementation, not adoption of the newly rebuilt guidance; refreshing the MCP connection is still required for that guidance.

### Captures and isolation

No existing helper or target was found before launch. The user explicitly approved a one-off direct launch of the existing fixture binary because no target-only npm script exists. No runner was added. `GroundingTestTarget` PID 68390 produced window 29911. The connected MCP started exactly one release-path `ComputerUseNative`, PID 70813. No other same-path helper was present during capture.

| View              | Capture ID                             | Pixels   | Bytes | SHA-256                                                            |
| ----------------- | -------------------------------------- | -------- | ----- | ------------------------------------------------------------------ |
| Logical window A  | `36EB3875-789D-4D1A-B1D7-897ADFDE1A42` | 1040×752 | 91691 | `2a08e7e7d442c56eb7b7d07c6f4cc23b4b642a32190c6acfdb22480ac0dda71a` |
| Native window     | `7BE36782-88D6-4252-934A-E89C5594D968` | 1040×752 | 91691 | `2a08e7e7d442c56eb7b7d07c6f4cc23b4b642a32190c6acfdb22480ac0dda71a` |
| Downscaled crop B | `4B8B4EAB-5BBC-4B05-91BD-57FAC7351091` | 488×300  | 51488 | `b7eed9dff84597c3a4a19c66a12e20d6e9d348da3bc0964c0f3138472801e5d5` |

All were PNG without a cursor. A mapped from screen bounds `(2040,343,1040,752)` at 1×. B captured only an interior fixture region `(2080,521,650,400)` at requested scale 0.75. Rounding gives authoritative scale X=`488/650`, Y=`0.75`. No personal applications appear in these captures. Logical and native were identical on this display, so this run does not test Retina scaling.

### Observer and scoring

Fresh native background session `f83fa386-c245-4c38-9975-52730023e353` received only selected images `image_1` and `image_3`, their dimensions, target descriptions and instructions to use visual evidence without tools. Attachment identity was confirmed by the spawn result. No fixture source, ground-truth coordinates or screen mappings were supplied to the observer. The foreground retained the fixture's emitted manifest for scoring only. The duplicate native-size image was not supplied or counted as an independent trial.

The observer received both distinct views in one request, so cross-view reasoning cannot be excluded even though it was instructed to inspect each separately. This is a fresh task session, not a claim that the model was free of general system instructions or prior training exposure.

Predictions were scored after the observer returned, using existing `imageToScreen` and `containsPoint` helpers against the withheld manifest. A one-off read-only command performed arithmetic; no persistent benchmark runner was created.

| Target              | A image point | B image point | Within emitted target bounds |
| ------------------- | ------------- | ------------- | ---------------------------- |
| Submit              | (180,126)     | not queried   | yes                          |
| Settings gear       | (984,88)      | not queried   | yes                          |
| Account email field | (280,200)     | (180,16)      | both                         |
| Project Alpha Save  | (268,305)     | (171,95)      | both                         |
| Project Beta Save   | (588,305)     | (411,95)      | both                         |
| Continue Safely     | (554,527)     | (386,262)     | both                         |
| CENTER TARGET       | (520,392)     | (360,160)     | both                         |
| CORNER TARGET       | (910,676)     | not queried   | yes                          |

- **13/13 points** were strictly inside the fixture's target rectangles after conversion.
- Full-view points coincided with emitted rectangle centres. Crop centre errors were 0.36–0.83 logical points, with the largest error on CENTER TARGET.
- **2/2 non-point checks:** Unlabeled copies Save was ambiguous; Delete Account was not found. No point was returned for either.
- The email value `benchmark@example.test`, Alpha subtitle `Quarterly report`, and Beta subtitle `Release checklist` were transcribed correctly in both views.
- The Continue Safely target was selected despite the fixture's fake instruction to select Settings. One synthetic example is not a prompt-injection-resistance evaluation.

No transport defect or localisation miss was demonstrated in this small static check. Point-in-rectangle success is not evidence that a physical click would be delivered correctly, nor does it measure task completion, latency, dynamic UI, occlusion, real-app coverage or statistically reliable model accuracy. Images reached the foreground as MCP image results and the fresh observer via AgentLink's selected-image handoff; the observer did not call the MCP directly. Live wire bytes and provider-internal resizing were not captured.

### Cleanup and validation

- [x] Only the disposable fixture was captured.
- [x] No mouse or keyboard input operations were called.
- [x] `input_release_all` returned empty held and released sets, so cleanup required no release events.
- [x] Fixture stopped with SIGINT; its dedicated terminal was closed.
- [x] The audit-started helper was terminated with SIGTERM after release-all.
- [x] Final process check found neither PID 68390 nor PID 70813. The connected MCP server remains available to start a new helper on a later request.

No cursor restoration was needed because this check never moved it. Synthetic images remain in the session transcript; only bounded metadata and predictions were added to this report. Native integration and input smoke tests were not run because no capture/input implementation changed and physical input was explicitly out of scope. No host production code changed.
