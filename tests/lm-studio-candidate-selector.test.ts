/// <reference types="node" />

import {
  LmStudioCandidateSelector,
  createCandidateVisionSelectorFromEnvironment,
} from "../src/semantic/lm-studio-candidate-selector.js";
import { describe, expect, it, vi } from "vitest";

import { LmStudioClient } from "../src/grounding/lm-studio-client.js";

const loadedModel = {
  key: "qwen/qwen3-vl-8b",
  type: "llm",
  loaded_instances: [{ id: "qwen/qwen3-vl-8b" }],
  capabilities: { vision: true },
};

const input = {
  targetDescription: "the Save button for Project Alpha",
  candidates: [
    {
      id: "left-save",
      role: "AXButton",
      names: ["Save"],
      normalizedBox: { xMin: 100, yMin: 200, xMax: 200, yMax: 250 },
    },
    {
      id: "right-save",
      role: "AXButton",
      names: ["Save"],
      normalizedBox: { xMin: 500, yMin: 200, xMax: 600, yMax: 250 },
    },
  ],
  image: {
    base64: "iVBORw0KGgo=",
    mimeType: "image/png" as const,
    size: { width: 1024, height: 768 },
    capturedAt: "2026-09-02T02:00:00Z",
  },
};

function clientForResponses(
  ...responses: Array<unknown | Error>
): LmStudioClient {
  let responseIndex = 0;
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockImplementation(async (request) => {
      if (String(request).endsWith("/models")) {
        return new Response(JSON.stringify({ models: [loadedModel] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      const response = responses[responseIndex++];
      if (response instanceof Error) throw response;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(response) } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
  return new LmStudioClient({ fetchImpl });
}

describe("LM Studio candidate selector", () => {
  it("permits one agreed schema-enumerated candidate only", async () => {
    const selector = new LmStudioCandidateSelector({
      client: clientForResponses(
        { selectedIds: ["left-save"] },
        { selectedIds: ["left-save"] },
      ),
    });

    await expect(selector.select(input)).resolves.toMatchObject({
      status: "found",
      clickEligible: true,
      selectedAxCandidateIds: ["left-save"],
      viewCount: 2,
      expectedViewCount: 2,
      captureObservedAt: input.image.capturedAt,
      model: "qwen/qwen3-vl-8b",
      rejectionReasons: [],
    });
  });

  it("turns model disagreement and partial failure into non-clickable abstention", async () => {
    const disagreement = new LmStudioCandidateSelector({
      client: clientForResponses(
        { selectedIds: ["left-save"] },
        { selectedIds: ["right-save"] },
      ),
    });
    await expect(disagreement.select(input)).resolves.toMatchObject({
      status: "uncertain",
      clickEligible: false,
      selectedAxCandidateIds: [],
      rejectionReasons: ["selection_disagreement"],
    });

    const partial = new LmStudioCandidateSelector({
      client: clientForResponses(
        { selectedIds: ["left-save"] },
        new Error("offline"),
      ),
    });
    await expect(partial.select(input)).resolves.toMatchObject({
      status: "uncertain",
      clickEligible: false,
      selectedAxCandidateIds: [],
      rejectionReasons: ["provider_endpoint_unavailable", "missing_response"],
    });
  });

  it("returns unavailable instead of throwing when the provider cannot be reached", async () => {
    const selector = new LmStudioCandidateSelector({
      client: clientForResponses(new Error("offline"), new Error("offline")),
    });

    await expect(selector.select(input)).resolves.toMatchObject({
      status: "unavailable",
      clickEligible: false,
      selectedAxCandidateIds: [],
      rejectionReasons: ["provider_endpoint_unavailable"],
    });
  });

  it("retries model discovery after a transient provider failure", async () => {
    let modelsCalls = 0;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async (request) => {
        if (String(request).endsWith("/models")) {
          modelsCalls += 1;
          if (modelsCalls === 1) throw new Error("offline");
          return new Response(JSON.stringify({ models: [loadedModel] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({ selectedIds: ["left-save"] }),
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });
    const selector = new LmStudioCandidateSelector({
      client: new LmStudioClient({ fetchImpl }),
    });

    await expect(selector.select(input)).resolves.toMatchObject({
      status: "unavailable",
      rejectionReasons: ["provider_endpoint_unavailable"],
    });
    await expect(selector.select(input)).resolves.toMatchObject({
      status: "found",
      selectedAxCandidateIds: ["left-save"],
    });
    expect(modelsCalls).toBe(2);
  });

  it("checks loaded-model metadata without inference or usage history", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ models: [loadedModel] }));
    const selector = new LmStudioCandidateSelector({
      client: new LmStudioClient({ fetchImpl }),
    });
    await expect(selector.checkReadiness()).resolves.toMatchObject({
      state: "ready",
      model: loadedModel.key,
      lastUsed: null,
      lastFailure: null,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(
      "http://127.0.0.1:1234/api/v1/models",
    );
    expect(fetchImpl.mock.calls[0]![1]?.method).toBe("GET");
  });

  it("does not infer with a downloaded but unloaded model", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        models: [{ ...loadedModel, loaded_instances: [] }],
      }),
    );
    const selector = new LmStudioCandidateSelector({
      client: new LmStudioClient({ fetchImpl }),
    });
    await expect(selector.select(input)).resolves.toMatchObject({
      status: "unavailable",
      clickEligible: false,
    });
    expect(selector.status).toMatchObject({
      state: "not_loaded",
      lastUsed: null,
      lastFailure: { reason: "provider_model_selection" },
    });
    expect(
      fetchImpl.mock.calls.every(
        ([url, init]) =>
          String(url).endsWith("/models") && init?.method === "GET",
      ),
    ).toBe(true);
  });

  it("requires a choice between compatible loaded models and honours a pinned instance", async () => {
    const models = [
      loadedModel,
      {
        ...loadedModel,
        key: "qwen/qwen3-vl-4b",
        loaded_instances: [{ id: "vision-small" }],
      },
    ];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ models }));
    const automatic = new LmStudioCandidateSelector({
      client: new LmStudioClient({ fetchImpl }),
    });
    await expect(automatic.checkReadiness()).resolves.toMatchObject({
      state: "ambiguous",
      model: null,
    });
    const pinned = new LmStudioCandidateSelector({
      client: new LmStudioClient({ fetchImpl, model: "vision-small" }),
    });
    await expect(pinned.checkReadiness()).resolves.toMatchObject({
      state: "ready",
      model: "vision-small",
    });
  });

  it("ignores unrelated loaded models but reports unsupported models when none is compatible", async () => {
    let models = [
      loadedModel,
      { ...loadedModel, key: "text-only", capabilities: { vision: false } },
    ];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ models }));
    const selector = new LmStudioCandidateSelector({
      client: new LmStudioClient({ fetchImpl }),
    });
    await expect(selector.checkReadiness()).resolves.toMatchObject({
      state: "ready",
      model: loadedModel.key,
    });
    models = [models[1]!];
    await expect(selector.checkReadiness()).resolves.toMatchObject({
      state: "unsupported",
      model: null,
    });
  });

  it("refreshes readiness after unload and reload instead of caching a selected model", async () => {
    let loaded = true;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        models: [
          {
            ...loadedModel,
            loaded_instances: loaded ? loadedModel.loaded_instances : [],
          },
        ],
      }),
    );
    const selector = new LmStudioCandidateSelector({
      client: new LmStudioClient({ fetchImpl }),
    });
    await expect(selector.checkReadiness()).resolves.toMatchObject({
      state: "ready",
    });
    loaded = false;
    await expect(selector.checkReadiness()).resolves.toMatchObject({
      state: "not_loaded",
      model: null,
    });
    loaded = true;
    await expect(selector.checkReadiness()).resolves.toMatchObject({
      state: "ready",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("preserves successful use and failure independently across readiness checks", async () => {
    const selector = new LmStudioCandidateSelector({
      client: clientForResponses(
        { selectedIds: ["left-save"] },
        { selectedIds: ["left-save"] },
        new Error("offline"),
        new Error("offline"),
      ),
    });
    await selector.select(input);
    const lastUsed = selector.status.lastUsed;
    expect(lastUsed).toMatchObject({
      model: loadedModel.key,
      at: expect.any(String),
      durationMs: expect.any(Number),
    });
    await selector.select(input);
    const lastFailure = selector.status.lastFailure;
    expect(lastFailure).toMatchObject({
      model: loadedModel.key,
      reason: "provider_endpoint_unavailable",
    });
    expect(selector.status.state).toBe("offline");
    await selector.checkReadiness();
    expect(selector.status).toMatchObject({
      state: "ready",
      lastUsed,
      lastFailure,
    });
  });

  it("falls back to legacy loaded-state metadata, never the OpenAI model listing", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      String(url).endsWith("/api/v1/models")
        ? new Response("", { status: 404 })
        : Response.json({
            data: [{ id: loadedModel.key, type: "vlm", state: "loaded" }],
          }),
    );
    const selector = new LmStudioCandidateSelector({
      client: new LmStudioClient({ fetchImpl }),
    });
    await expect(selector.checkReadiness()).resolves.toMatchObject({
      state: "ready",
      lastUsed: null,
    });
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:1234/api/v1/models",
      "http://127.0.0.1:1234/api/v0/models",
    ]);
  });

  it("supports legacy servers reporting an unknown endpoint in an HTTP 200 response", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) =>
        String(url).endsWith("/api/v1/models")
          ? Response.json({
              error: "Unexpected endpoint or method. (GET /api/v1/models)",
            })
          : Response.json({
              data: [{ id: loadedModel.key, type: "vlm", state: "loaded" }],
            }),
      );
    const selector = new LmStudioCandidateSelector({
      client: new LmStudioClient({ fetchImpl }),
    });
    await expect(selector.checkReadiness()).resolves.toMatchObject({
      state: "ready",
      lastUsed: null,
      lastFailure: null,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(
      fetchImpl.mock.calls.every(([, init]) => init?.method === "GET"),
    ).toBe(true);
  });

  it("does not reject the whole inventory because an unrelated model has a new type", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        models: [
          loadedModel,
          { ...loadedModel, key: "future-model", type: "speech" },
        ],
      }),
    );
    const selector = new LmStudioCandidateSelector({
      client: new LmStudioClient({ fetchImpl }),
    });
    await expect(selector.checkReadiness()).resolves.toMatchObject({
      state: "ready",
      model: loadedModel.key,
    });
  });

  it("keeps the provider reason attached to overlapping readiness and selection checks", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("offline"));
    const selector = new LmStudioCandidateSelector({
      client: new LmStudioClient({ fetchImpl }),
    });
    const [selection, readiness, reason] = await Promise.all([
      selector.select(input),
      selector.checkReadiness(),
      selector.checkSelectionReadiness(),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(readiness.state).toBe("offline");
    expect(reason).toBe("provider_endpoint_unavailable");
    expect(selection.rejectionReasons).toEqual([reason]);
    expect(selector.status.lastFailure?.reason).toBe(reason);
  });

  it("does not treat a model listing without loaded-state evidence as ready", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ data: [{ id: loadedModel.key }] }),
      );
    const selector = new LmStudioCandidateSelector({
      client: new LmStudioClient({ fetchImpl }),
    });
    await expect(selector.checkReadiness()).resolves.toMatchObject({
      state: "error",
      model: null,
      lastUsed: null,
      lastFailure: null,
    });
  });

  it("reports invalid configuration without breaking the MCP server", async () => {
    const selector = new LmStudioCandidateSelector({
      baseUrl: "https://remote.invalid/v1",
    });
    await expect(selector.checkReadiness()).resolves.toMatchObject({
      state: "error",
      model: null,
      lastUsed: null,
    });
  });

  it("auto-enables discovery by default and supports an explicit opt-out", () => {
    expect(createCandidateVisionSelectorFromEnvironment({})).toBeInstanceOf(
      LmStudioCandidateSelector,
    );
    expect(
      createCandidateVisionSelectorFromEnvironment({
        LM_STUDIO_CANDIDATE_SELECTOR: "0",
      }),
    ).toBeUndefined();
    expect(
      createCandidateVisionSelectorFromEnvironment({
        LM_STUDIO_CANDIDATE_SELECTOR: "1",
        LM_STUDIO_MODEL: "qwen/qwen3-vl-8b",
      }),
    ).toBeInstanceOf(LmStudioCandidateSelector);
  });
});
