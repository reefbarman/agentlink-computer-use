import type { GroundingAdapter, GroundingResult, PixelSize } from "./types.js";

import { z } from "zod";

const modelsResponseSchema = z.object({
  data: z.array(
    z
      .object({
        id: z.string().min(1),
        object: z.string().optional(),
        owned_by: z.string().optional(),
      })
      .passthrough(),
  ),
});

const completionResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string() }).passthrough(),
      }),
    )
    .min(1),
});

export type LmStudioErrorCode =
  | "invalid_endpoint"
  | "endpoint_unavailable"
  | "http_error"
  | "timeout"
  | "model_selection"
  | "unsupported_model"
  | "structured_output";

export class LmStudioError extends Error {
  constructor(
    readonly code: LmStudioErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LmStudioError";
  }
}

export interface LmStudioClientOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  allowRemoteEndpoint?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface GroundingPrediction<Result = GroundingResult> {
  result: Result;
  durationMs: number;
  model: string;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1"
  );
}

export function validateBaseUrl(
  value: string,
  allowRemoteEndpoint = false,
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new LmStudioError(
      "invalid_endpoint",
      "LM Studio base URL is invalid",
      {
        cause: error,
      },
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new LmStudioError(
      "invalid_endpoint",
      "LM Studio base URL must use HTTP or HTTPS",
    );
  }
  if (url.username || url.password) {
    throw new LmStudioError(
      "invalid_endpoint",
      "LM Studio base URL must not contain embedded credentials",
    );
  }
  if (!allowRemoteEndpoint && !isLoopbackHostname(url.hostname)) {
    throw new LmStudioError(
      "invalid_endpoint",
      "LM Studio base URL must be loopback unless remote endpoints are explicitly allowed",
    );
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  url.search = "";
  url.hash = "";
  return url;
}

function authorizationHeaders(apiKey: string | undefined): HeadersInit {
  return apiKey === undefined ? {} : { Authorization: `Bearer ${apiKey}` };
}

export class LmStudioClient {
  readonly #baseUrl: URL;
  readonly #apiKey: string | undefined;
  readonly #configuredModel: string | undefined;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: LmStudioClientOptions = {}) {
    this.#baseUrl = validateBaseUrl(
      options.baseUrl ?? "http://127.0.0.1:1234/v1",
      options.allowRemoteEndpoint,
    );
    this.#apiKey = options.apiKey;
    this.#configuredModel = options.model;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  get endpointHost(): string {
    return this.#baseUrl.host;
  }

  async listModels(): Promise<string[]> {
    const response = await this.#request("models", { method: "GET" });
    const value = modelsResponseSchema.parse(await response.json());
    return value.data.map(({ id }) => id);
  }

  async selectModel<Result>(
    adapter: GroundingAdapter<Result>,
  ): Promise<string> {
    const available = await this.listModels();
    const selected = this.#configuredModel;
    if (selected !== undefined) {
      if (!available.includes(selected)) {
        throw new LmStudioError(
          "model_selection",
          `Configured model '${selected}' is not available; loaded models: ${available.join(", ") || "none"}`,
        );
      }
      if (!adapter.supportsModel(selected)) {
        throw new LmStudioError(
          "unsupported_model",
          `Configured model '${selected}' is not supported by adapter '${adapter.id}'`,
        );
      }
      return selected;
    }
    if (available.length !== 1) {
      throw new LmStudioError(
        "model_selection",
        `Set LM_STUDIO_MODEL because LM Studio returned ${available.length} models: ${available.join(", ") || "none"}`,
      );
    }
    const onlyModel = available[0];
    if (onlyModel === undefined || !adapter.supportsModel(onlyModel)) {
      throw new LmStudioError(
        "unsupported_model",
        `Loaded model '${onlyModel ?? "unknown"}' is not supported by adapter '${adapter.id}'`,
      );
    }
    return onlyModel;
  }

  async ground<Result>(
    adapter: GroundingAdapter<Result>,
    model: string,
    target: string,
    image: { base64: string; mimeType: "image/png" | "image/jpeg" },
    imageSize: PixelSize,
  ): Promise<GroundingPrediction<Result>> {
    const startedAt = performance.now();
    const response = await this.#request("chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: adapter.prompt(target, imageSize) },
              {
                type: "image_url",
                image_url: {
                  url: `data:${image.mimeType};base64,${image.base64}`,
                },
              },
            ],
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "gui_grounding",
            strict: true,
            schema: adapter.responseJsonSchema,
          },
        },
        temperature: 0,
        max_tokens: 256,
        stream: false,
      }),
    });
    const durationMs = performance.now() - startedAt;
    let completion: z.infer<typeof completionResponseSchema>;
    try {
      completion = completionResponseSchema.parse(await response.json());
      const content = completion.choices[0]?.message.content;
      if (content === undefined) {
        throw new Error("LM Studio response contained no first choice");
      }
      return {
        result: adapter.parse(JSON.parse(content)),
        durationMs,
        model,
      };
    } catch (error) {
      throw new LmStudioError(
        "structured_output",
        `LM Studio returned invalid structured grounding output: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  async #request(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(new URL(path, this.#baseUrl), {
        ...init,
        headers: {
          ...authorizationHeaders(this.#apiKey),
          ...init.headers,
        },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new LmStudioError(
          "http_error",
          `LM Studio returned HTTP ${response.status}`,
        );
      }
      return response;
    } catch (error) {
      if (error instanceof LmStudioError) {
        throw error;
      }
      if (controller.signal.aborted) {
        throw new LmStudioError(
          "timeout",
          `LM Studio request timed out after ${this.#timeoutMs} ms`,
          { cause: error },
        );
      }
      throw new LmStudioError(
        "endpoint_unavailable",
        `Could not reach LM Studio at ${this.#baseUrl.origin}`,
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
