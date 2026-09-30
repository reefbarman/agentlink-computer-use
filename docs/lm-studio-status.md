# LM Studio readiness and usage

Computer use automatically makes LM Studio available to the existing `candidate_vision` selection path when one supported Qwen3-VL model is already loaded. This does not change action routing: ordinary accessibility actions still run without model inference.

Readiness checks only fetch loaded-model metadata from `/api/v1/models`, with `/api/v0/models` as a fallback for older servers. They never load a model, send a screenshot, or run inference. The OpenAI-compatible `/v1/models` listing alone is not proof that a model is loaded.

## Status

`computer_status` includes an `lmStudio` object. The existing Computer Use menu shows the same snapshot under **LM Studio**:

- `checking`: no readiness check has completed yet.
- `disabled`: visual selection was explicitly disabled.
- `offline`: the model server is unreachable or the check timed out.
- `not_loaded`: no eligible model is loaded.
- `unsupported`: loaded/configured models are incompatible with the selector.
- `ambiguous`: multiple eligible instances are loaded; choose one explicitly.
- `ready`: a supported instance is loaded, not a guarantee that inference will succeed.
- `error`: readiness could not be verified, for example an authentication or metadata error.

`model` identifies the selected loaded instance. `checkedAt` timestamps the readiness snapshot. The menu refreshes periodically while its helper is already running; status updates never start or revive a helper.

`lastUsed` records a completed model-selection inference, with its model, time and duration. It does not mean a click was dispatched or verified. Disagreement or an uncertain selection still blocks input.

`lastFailure` records the latest failed selection attempt, with its time, model when known, and reason. Readiness probes do not count as model use or overwrite selection history. History belongs to the current MCP connection and resets when it restarts. No screenshots, target descriptions or API keys are stored in these fields.

## Configuration

No `LM_STUDIO_CANDIDATE_SELECTOR=1` setting is required. Existing settings for `LM_STUDIO_BASE_URL`, `LM_STUDIO_API_KEY` and `LM_STUDIO_MODEL` remain supported. The endpoint defaults to `http://127.0.0.1:1234/v1`; remote endpoints remain rejected.

- Set `LM_STUDIO_CANDIDATE_SELECTOR=0` to disable model selection and readiness polling.
- Set `LM_STUDIO_MODEL` to a model key or loaded-instance ID when more than one eligible instance is loaded. A model key matching multiple instances still requires a specific instance ID.
- Load/unload models in LM Studio. Computer use rechecks readiness before each visual-selection attempt instead of keeping an indefinitely cached model choice.

## Manual check

- [ ] Reconnect the computer-use MCP server after rebuilding.
- [ ] Call `computer_status` and inspect the existing icon's LM Studio submenu.
- [ ] Load/unload a supported model and confirm readiness changes without inference.
- [ ] Confirm `lastUsed` stays empty until a real visual-selection operation completes.
- [ ] Use Quit Computer Use and confirm status polling does not recreate its icon.
