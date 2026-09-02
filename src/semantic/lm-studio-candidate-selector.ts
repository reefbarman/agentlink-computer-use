import {
  createQwen3VlSelectorAdapter,
  evaluateCandidateSelections,
  type CandidateSelection,
  type SelectorCandidate,
} from "../grounding/adapters/qwen3-vl-selector.js";
import {
  LmStudioClient,
  LmStudioError,
  type LmStudioClientOptions,
} from "../grounding/lm-studio-client.js";
import type { PixelSize } from "../grounding/types.js";

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
export class LmStudioCandidateSelector implements CandidateVisionSelector {
  readonly #client: LmStudioClient;
  #model: Promise<string> | undefined;

  constructor(options: LmStudioCandidateSelectorOptions = {}) {
    const { client, ...clientOptions } = options;
    this.#client = client ?? new LmStudioClient(clientOptions);
  }

  async select(
    input: CandidateVisionSelectionInput,
  ): Promise<CandidateVisionSelection> {
    const startedAt = performance.now();
    let model: string;
    try {
      model = await this.#selectedModel(input.candidates);
    } catch (error) {
      return unavailable(providerReason(error), performance.now() - startedAt);
    }

    const adapters = selectorVariants.map((variant) =>
      createQwen3VlSelectorAdapter(input.candidates, variant),
    );
    const predictions = await Promise.allSettled(
      adapters.map((adapter) =>
        this.#client.ground(
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

  #selectedModel(candidates: readonly SelectorCandidate[]): Promise<string> {
    if (this.#model === undefined) {
      const model = this.#client.selectModel(
        createQwen3VlSelectorAdapter(candidates, selectorVariants[0]),
      );
      this.#model = model;
      void model.catch(() => {
        if (this.#model === model) this.#model = undefined;
      });
    }
    return this.#model;
  }
}

/**
 * Opt-in configuration for the MCP process. No model endpoint is contacted
 * unless this flag is set, preserving the AX-only default path.
 */
export function createCandidateVisionSelectorFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): CandidateVisionSelector | undefined {
  if (environment.LM_STUDIO_CANDIDATE_SELECTOR !== "1") return undefined;
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
