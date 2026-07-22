/// <reference types="node" />

import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  consumeCaptureArtifact,
  type CaptureArtifact,
} from "../src/native/artifacts.js";

const roots: string[] = [];
const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01,
]);

async function createSession(): Promise<string> {
  const base = join(tmpdir(), "computer-use-mcp");
  await mkdir(base, { recursive: true, mode: 0o700 });
  await chmod(base, 0o700);
  const root = await mkdtemp(join(base, "test-"));
  await chmod(root, 0o700);
  roots.push(root);
  return root;
}

async function createArtifact(
  root: string,
  overrides: Partial<CaptureArtifact> = {},
): Promise<CaptureArtifact> {
  const artifactPath = join(root, `${randomUUID()}.png`);
  await writeFile(artifactPath, pngBytes, { mode: 0o600 });
  await chmod(artifactPath, 0o600);

  return {
    captureId: randomUUID(),
    artifactRoot: root,
    artifactPath,
    byteLength: pngBytes.length,
    target: { kind: "display", displayId: "5" },
    mimeType: "image/png",
    nativePixelSize: { width: 100, height: 100 },
    outputPixelSize: { width: 100, height: 100 },
    mapping: {
      kind: "linear",
      imageContentBounds: { x: 0, y: 0, width: 100, height: 100 },
      screenBounds: { x: 0, y: 0, width: 100, height: 100 },
      pixelsPerPoint: { x: 1, y: 1 },
    },
    sha256: createHash("sha256").update(pngBytes).digest("hex"),
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("consumeCaptureArtifact", () => {
  it("returns validated bytes without filesystem paths and deletes the artifact", async () => {
    const root = await createSession();
    const artifact = await createArtifact(root);

    const result = await consumeCaptureArtifact(artifact, root);

    expect(result.data).toBe(pngBytes.toString("base64"));
    expect(result.metadata).not.toHaveProperty("artifactRoot");
    expect(result.metadata).not.toHaveProperty("artifactPath");
    await expect(stat(artifact.artifactPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects an artifact from a different helper session", async () => {
    const root = await createSession();
    const otherRoot = await createSession();
    const artifact = await createArtifact(root);

    await expect(
      consumeCaptureArtifact(artifact, otherRoot),
    ).rejects.toMatchObject({
      code: "native_unavailable",
    });
  });

  it("rejects an escaped artifact path without deleting the unrelated file", async () => {
    const root = await createSession();
    const otherRoot = await createSession();
    const artifact = await createArtifact(root);
    const unrelated = await createArtifact(otherRoot);

    await expect(
      consumeCaptureArtifact(
        { ...artifact, artifactPath: unrelated.artifactPath },
        root,
      ),
    ).rejects.toMatchObject({ code: "native_unavailable" });
    await expect(stat(unrelated.artifactPath)).resolves.toMatchObject({
      size: pngBytes.length,
    });
  });

  it("deletes the artifact when hash validation fails", async () => {
    const root = await createSession();
    const artifact = await createArtifact(root, { sha256: "0".repeat(64) });

    await expect(consumeCaptureArtifact(artifact, root)).rejects.toMatchObject({
      code: "native_unavailable",
    });
    await expect(stat(artifact.artifactPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects group-readable artifacts", async () => {
    const root = await createSession();
    const artifact = await createArtifact(root);
    await chmod(artifact.artifactPath, 0o640);

    await expect(consumeCaptureArtifact(artifact, root)).rejects.toMatchObject({
      code: "native_unavailable",
    });
  });
});
