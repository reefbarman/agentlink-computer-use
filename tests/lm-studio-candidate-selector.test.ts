/// <reference types="node" />

import {
  LmStudioCandidateSelector,
  createCandidateVisionSelectorFromEnvironment,
} from "../src/semantic/lm-studio-candidate-selector.js";
import { describe, expect, it, vi } from "vitest";

import { LmStudioClient } from "../src/grounding/lm-studio-client.js";

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
        return new Response(
          JSON.stringify({ data: [{ id: "qwen/qwen3-vl-8b" }] }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
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
          return new Response(
            JSON.stringify({ data: [{ id: "qwen/qwen3-vl-8b" }] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
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

  it("requires an explicit process opt-in", () => {
    expect(createCandidateVisionSelectorFromEnvironment({})).toBeUndefined();
    expect(
      createCandidateVisionSelectorFromEnvironment({
        LM_STUDIO_CANDIDATE_SELECTOR: "1",
        LM_STUDIO_MODEL: "qwen/qwen3-vl-8b",
      }),
    ).toBeInstanceOf(LmStudioCandidateSelector);
  });
});
