import {
  createQwen3VlSelectorAdapter,
  evaluateCandidateSelections,
  supportsQwen3VlSelectorModel,
  type CandidateSelection,
  type SelectorCandidate,
} from "../grounding/adapters/qwen3-vl-selector.js";
import {
  LmStudioClient,
  LmStudioError,
  type LmStudioClientOptions,
} from "../grounding/lm-studio-client.js";
import type { PixelSize } from "../grounding/types.js";
import {
  initialLmStudioStatus,
  type LmStudioStatus,
} from "./lm-studio-status.js";

const selectorVariants = ["semantic", "visual-check"] as const;

export interface CandidateVisionSelectionInput {
  targetDescription: string;
  candidates: readonly SelectorCandidate[];
  image: {
    base64: string;
    mimeType: "image/png" | "image/jpeg";
    size: PixelSize;
    capturedAt: string;
  };
}

export type CandidateVisionSelectionReason =
  | "provider_invalid_endpoint"
  | "provider_endpoint_unavailable"
  | "provider_http_error"
  | "provider_timeout"
  | "provider_model_selection"
  | "provider_unsupported_model"
  | "provider_structured_output"
  | "missing_response"
  | "selection_disagreement"
  | "multiple_candidates";

export interface CandidateVisionSelection {
  status: "found" | "not_found" | "ambiguous" | "uncertain" | "unavailable";
  clickEligible: boolean;
  selectedAxCandidateIds: string[];
  viewCount: number;
  expectedViewCount: number;
  captureObservedAt?: string;
  model: string | null;
  durationMs: number;
  rejectionReasons: CandidateVisionSelectionReason[];
}

export interface CandidateVisionSelector {
  readonly status?: LmStudioStatus;
  checkReadiness?(): Promise<LmStudioStatus>;
  checkSelectionReadiness?(): Promise<CandidateVisionSelectionReason | null>;
  subscribeStatus?(listener: (status: LmStudioStatus) => void): () => void;
  select(
    input: CandidateVisionSelectionInput,
  ): Promise<CandidateVisionSelection>;
}

export interface LmStudioCandidateSelectorOptions extends LmStudioClientOptions {
  client?: LmStudioClient;
}

function providerReason(error: unknown): CandidateVisionSelectionReason {
  if (error instanceof LmStudioError) {
    return `provider_${error.code}`;
  }
  return "provider_structured_output";
}

function unavailable(
  reason: CandidateVisionSelectionReason,
  durationMs: number,
): CandidateVisionSelection {
  return {
    status: "unavailable",
    clickEligible: false,
    selectedAxCandidateIds: [],
    viewCount: 0,
    expectedViewCount: selectorVariants.length,
    model: null,
    durationMs,
    rejectionReasons: [reason],
  };
}

/**
 * Uses Qwen3-VL only to choose from AX candidates supplied for one fresh
 * screenshot. It never accepts model-generated coordinates or identifiers.
 */
interface ReadinessCheck {
  status: LmStudioStatus;
  reason: CandidateVisionSelectionReason;
}

export class LmStudioCandidateSelector implements CandidateVisionSelector {
  readonly #client: LmStudioClient | undefined;
  readonly #configurationError: unknown;
  readonly #listeners = new Set<(status: LmStudioStatus) => void>();
  #status = initialLmStudioStatus();
  #checking: Promise<ReadinessCheck> | undefined;

  constructor(options: LmStudioCandidateSelectorOptions = {}) {
    const { client, ...clientOptions } = options;
    try {
      this.#client = client ?? new LmStudioClient(clientOptions);
    } catch (error) {
      this.#configurationError = error;
    }
  }

  get status(): LmStudioStatus {
    return structuredClone(this.#status);
  }

  subscribeStatus(listener: (status: LmStudioStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async checkReadiness(): Promise<LmStudioStatus> {
    return (await this.#checkReadiness()).status;
  }

  async checkSelectionReadiness(): Promise<CandidateVisionSelectionReason | null> {
    const { status, reason } = await this.#checkReadiness();
    if (status.state === "ready") return null;
    this.#recordFailure(reason, status.model);
    return reason;
  }

  #checkReadiness(): Promise<ReadinessCheck> {
    if (this.#checking) return this.#checking;
    const checking = this.#refreshReadiness();
    this.#checking = checking;
    void checking.finally(() => {
      if (this.#checking === checking) this.#checking = undefined;
    });
    return checking;
  }

  async #refreshReadiness(): Promise<ReadinessCheck> {
    let state: LmStudioStatus["state"];
    let model: string | null = null;
    let detail: string;
    let reason: CandidateVisionSelectionReason = "provider_model_selection";
    try {
      if (!this.#client) throw this.#configurationError;
      const inventory = await this.#client.modelInventory();
      const configured = this.#client.configuredModel;
      const matching = inventory.filter(
        (entry) =>
          configured === undefined ||
          entry.key === configured ||
          entry.loadedInstanceIds.includes(configured),
      );
      const supported = matching.filter(
        (entry) =>
          entry.isLanguageModel &&
          entry.vision !== false &&
          supportsQwen3VlSelectorModel(entry.key),
      );
      const loaded = supported.flatMap((entry) =>
        entry.loadedInstanceIds.filter(
          (id) =>
            configured === undefined ||
            configured === entry.key ||
            configured === id,
        ),
      );
      if (loaded.length === 1) {
        state = "ready";
        model = loaded[0]!;
        detail = "Supported model is loaded; visual selection is available";
      } else if (loaded.length > 1) {
        state = "ambiguous";
        detail =
          "Multiple supported models are loaded; set LM_STUDIO_MODEL to choose one";
      } else if (
        matching.length > 0 &&
        supported.length === 0 &&
        (configured !== undefined ||
          matching.some((entry) => entry.loadedInstanceIds.length > 0))
      ) {
        state = "unsupported";
        detail =
          "Loaded or configured model is not supported by the Qwen3-VL selector";
        reason = "provider_unsupported_model";
      } else {
        state = "not_loaded";
        detail =
          configured === undefined
            ? "No supported model is loaded; load a Qwen3-VL model in LM Studio"
            : "Configured model is not loaded; load it in LM Studio";
      }
    } catch (error) {
      reason = providerReason(error);
      state =
        error instanceof LmStudioError &&
        (error.code === "endpoint_unavailable" || error.code === "timeout")
          ? "offline"
          : "error";
      detail =
        error instanceof LmStudioError
          ? error.message
          : "Could not verify LM Studio model readiness";
    }
    this.#updateStatus({
      state,
      model,
      detail,
      checkedAt: new Date().toISOString(),
    });
    return { status: this.status, reason };
  }

  #updateStatus(update: Partial<LmStudioStatus>): void {
    this.#status = { ...this.#status, ...update };
    for (const listener of this.#listeners) listener(this.status);
  }

  #recordFailure(reason: string, model: string | null): void {
    this.#updateStatus({
      lastFailure: { at: new Date().toISOString(), reason, model },
    });
  }

  async select(
    input: CandidateVisionSelectionInput,
  ): Promise<CandidateVisionSelection> {
    const startedAt = performance.now();
    const { status: readiness, reason } = await this.#checkReadiness();
    const model = readiness.model;
    const client = this.#client;
    if (readiness.state !== "ready" || model === null || !client) {
      this.#recordFailure(reason, model);
      return unavailable(reason, performance.now() - startedAt);
    }

    const adapters = selectorVariants.map((variant) =>
      createQwen3VlSelectorAdapter(input.candidates, variant),
    );
    const predictions = await Promise.allSettled(
      adapters.map((adapter) =>
        client.ground(
          adapter,
          model,
          input.targetDescription,
          {
            base64: input.image.base64,
            mimeType: input.image.mimeType,
          },
          input.image.size,
        ),
      ),
    );
    const selections: CandidateSelection[] = [];
    const providerFailures: CandidateVisionSelectionReason[] = [];
    for (const prediction of predictions) {
      if (prediction.status === "fulfilled") {
        selections.push(prediction.value.result);
      } else {
        providerFailures.push(providerReason(prediction.reason));
      }
    }

    const durationMs = performance.now() - startedAt;
    if (providerFailures.length > 0) {
      this.#recordFailure(providerFailures[0]!, model);
      this.#updateStatus({
        state: providerFailures.some(
          (reason) =>
            reason === "provider_endpoint_unavailable" ||
            reason === "provider_timeout",
        )
          ? "offline"
          : "error",
        detail: `Visual selection failed: ${providerFailures[0]}`,
      });
    } else {
      this.#updateStatus({
        lastUsed: { at: new Date().toISOString(), model, durationMs },
      });
    }
    if (selections.length === 0) {
      return unavailable(
        providerFailures[0] ?? "provider_structured_output",
        durationMs,
      );
    }

    const confidence = evaluateCandidateSelections(
      selections,
      selectorVariants.length,
    );
    if (
      providerFailures.length === 0 &&
      confidence.rejectionReasons.length > 0
    ) {
      this.#recordFailure(confidence.rejectionReasons[0]!, model);
    }
    return {
      status: confidence.status,
      clickEligible: confidence.clickEligible,
      selectedAxCandidateIds: confidence.selectedIds,
      viewCount: confidence.responseCount,
      expectedViewCount: confidence.expectedResponseCount,
      captureObservedAt: input.image.capturedAt,
      model,
      durationMs,
      rejectionReasons: [...providerFailures, ...confidence.rejectionReasons],
    };
  }
}

/** Auto-discovery enables the existing visual-selection path, not action routing. */
export function createCandidateVisionSelectorFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): CandidateVisionSelector | undefined {
  if (environment.LM_STUDIO_CANDIDATE_SELECTOR === "0") return undefined;
  return new LmStudioCandidateSelector({
    ...(environment.LM_STUDIO_BASE_URL === undefined
      ? {}
      : { baseUrl: environment.LM_STUDIO_BASE_URL }),
    ...(environment.LM_STUDIO_API_KEY === undefined
      ? {}
      : { apiKey: environment.LM_STUDIO_API_KEY }),
    ...(environment.LM_STUDIO_MODEL === undefined
      ? {}
      : { model: environment.LM_STUDIO_MODEL }),
  });
}
