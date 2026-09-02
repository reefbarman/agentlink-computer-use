# LM Studio GUI Grounding Benchmark

This benchmark measures read-only GUI grounding accuracy and latency using the existing macOS capture helper and a locally hosted Qwen3-VL model. It does not register an MCP tool or synthesize mouse/keyboard input.

## LM Studio setup

Load **Qwen3-VL 8B Instruct, MLX 8-bit** with:

- Context length: `8192`
- Max concurrent predictions: `1`
- Fixed seed: `1`
- KV cache quantization: off
- Remember model settings: enabled

Start LM Studio's local server on `http://127.0.0.1:1234`. Keep the model loaded throughout a run.

Run only one `ComputerUseNative` process from the release executable path. Before a standalone benchmark, disconnect/stop any MCP client already using this repository's helper. Concurrent same-path helpers are both classified as helper applications for ScreenCaptureKit exclusion and can cause screenshot timeouts.

The benchmark selects `LM_STUDIO_MODEL` exactly. If it is omitted, auto-selection succeeds only when LM Studio lists exactly one model.

```sh
export LM_STUDIO_MODEL='qwen/qwen3-vl-8b'
npm run benchmark:grounding
```

If LM Studio reports a different loaded model ID, use that exact ID. The adapter must still recognize it as Qwen3-VL.

Optional environment variables:

- `LM_STUDIO_BASE_URL` — defaults to `http://127.0.0.1:1234/v1`.
- `LM_STUDIO_API_KEY` — optional authorization; never written to results.
- `LM_STUDIO_BACKEND` — optional non-secret metadata, for example `MLX`.
- `LM_STUDIO_QUANTIZATION` — optional non-secret metadata, for example `8-bit`.

Non-loopback endpoints, embedded URL credentials, and HTTP redirects are rejected by default because screenshots may be sensitive.

## Commands

Full deterministic window matrix:

```sh
npm run benchmark:grounding
```

Fast protocol/capture smoke run:

```sh
npm run benchmark:grounding -- \
  --widths 768 \
  --accuracy-repetitions 1 \
  --latency-repetitions 1
```

Bounded confidence-strategy experiment:

```sh
npm run benchmark:grounding -- \
  --confidence-strategy \
  --widths 768,1024 \
  --output benchmark-results/confidence-768-1024.json
```

Confidence mode runs the two calibration calls, then evaluates each scored case using two distinct actual image sizes and two exhaustive prompt variants. It skips the normal accuracy repetition matrix, latency trials, display context, and real-application cases. The fixed `768,1024` widths keep this experiment comparable and bounded; with ten scored cases it makes 42 model calls including calibration.

Opt-in display-context subset:

```sh
npm run benchmark:grounding -- --include-display-context
```

Optional real-application cases:

1. Copy `benchmarks/grounding-real-cases.example.json` to the ignored `benchmarks/grounding-real-cases.local.json`.
2. Record an exact bundle identifier, anchored window-title regex, reference window dimensions, query, expected status, and normalized target bounds.
3. Run without activating or rearranging the application:

```sh
npm run benchmark:grounding -- \
  --real-cases benchmarks/grounding-real-cases.local.json
```

A real-app case is skipped unless exactly one on-screen window matches and its size agrees with the reference within one logical point. Exploratory results are reported separately and never contribute to deterministic accuracy.

Other options:

- `--confidence-strategy` (requires or defaults to `--widths 768,1024`)
- `--widths 512,768,1024,1280,1600`
- `--accuracy-repetitions N`
- `--latency-repetitions N`
- `--real-cases PATH`
- `--output PATH`
- `--allow-remote-endpoint` (not recommended for private screenshots)

## Behavior

The runner:

1. Loads the deterministic `GroundingTestTarget` AppKit window.
2. Captures it through the native helper at distinct actual output sizes.
3. Performs one unscored capture warm-up; if the first helper-start capture fails, it records the error, waits 500 ms, and retries exactly once.
4. Validates each native private artifact and deletes it after consumption.
5. Runs center/corner grounding calibration before scored trials.
6. Scores unique, two ambiguous-query variants, absent, contextual, small-control, and prompt-injection cases.
7. Recaptures before dedicated warmed latency trials.
8. Writes one atomic JSON result under `benchmark-results/`.
9. Terminates helper and target processes on success, failure, or interruption.

The deterministic target is captured as its exact global screen region rather than through ScreenCaptureKit's newly launched `SCWindow` object. The manifest comes directly from the spawned child after layout, and the runner requires its region to fit entirely within exactly one pre-discovered display before capture. Region captures use numeric scale `4` capped by each requested width and preserve an authoritative returned mapping. Opt-in display captures use native scale. The current Qwen3-VL adapter accepts relative integer coordinates `0..999` and uses `value / 1000 × imageDimension`. It records `/999` endpoint mapping only as sensitivity data; calibration detects gross normalized-versus-absolute coordinate mismatches.

## Privacy

- Screenshots are sent only to the configured LM Studio endpoint.
- The default endpoint must be loopback.
- Screenshots and base64 data are not written to benchmark results.
- Native artifact paths, credentials, authorization headers, and unbounded model prose are not recorded.
- Full-display capture is opt-in because it may include unrelated private content.

## JSON output

Each result contains:

- Exact selected model and adapter/version.
- Optional backend and quantization metadata.
- Requested and actual image sizes plus capture mappings.
- Calibration results.
- Raw bounded prediction geometry and decoded image/screen geometry.
- Point-in-target, center error, descriptive IoU, abstention, and false-positive outcomes.
- Capture, inference, and end-to-end timings.
- Accuracy and warmed latency aggregates, or confidence-specific per-view evidence and aggregates.
- Categorized endpoint, timeout, HTTP, structured-output, geometry, and validation errors.

It contains no screenshot bytes or native artifact paths.

## Result interpretation

This is a spike, not a production qualification. Passing the small deterministic corpus justifies a larger corpus and more repetitions. It does not justify automatic clicking. A production path should start with a read-only `screen_find` design and separately address capture freshness and window-geometry revalidation.

Confidence mode fails closed unless every expected evidence view returns exactly one candidate, all candidate geometries agree within the configured screen-space thresholds, and each proposed point is safely inset from its box edges. All-empty completed views produce `not_found`; multiple candidates produce `ambiguous`; missing, failed, mixed, or geometrically unstable evidence produces `uncertain`. The reported `evidenceScore` is a diagnostic summary only. It is not a model-reported confidence value, a calibrated probability, or an authorization to click.
