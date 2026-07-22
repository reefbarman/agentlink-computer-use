import { constants, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { lstat, open, realpath, unlink } from "node:fs/promises";

import { NativeError } from "./protocol.js";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { z } from "zod";

const pixelSizeSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

const rectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
});

const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("display"), displayId: z.string() }),
  z.object({ kind: z.literal("window"), windowId: z.string() }),
  z.object({ kind: z.literal("region"), bounds: rectSchema }),
]);

export const captureArtifactSchema = z.object({
  captureId: z.string().uuid(),
  artifactRoot: z.string().min(1),
  artifactPath: z.string().min(1),
  byteLength: z.number().int().positive(),
  target: targetSchema,
  mimeType: z.enum(["image/png", "image/jpeg"]),
  nativePixelSize: pixelSizeSchema.nullable(),
  outputPixelSize: pixelSizeSchema,
  mapping: z.object({
    kind: z.literal("linear"),
    imageContentBounds: rectSchema,
    screenBounds: rectSchema,
    pixelsPerPoint: z.object({
      x: z.number().positive(),
      y: z.number().positive(),
    }),
  }),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  capturedAt: z.iso.datetime(),
});

export type CaptureArtifact = z.infer<typeof captureArtifactSchema>;

export interface ConsumedCapture {
  metadata: Omit<CaptureArtifact, "artifactRoot" | "artifactPath">;
  data: string;
}

const maximumArtifactBytes = 50 * 1024 * 1024;
const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;

function isDirectChild(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path.length > 0 && !path.startsWith("..") && !path.includes("/");
}

function validateMagic(
  bytes: Uint8Array,
  mimeType: CaptureArtifact["mimeType"],
): boolean {
  if (mimeType === "image/png") {
    return (
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  }
  return (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  );
}

export async function consumeCaptureArtifact(
  value: unknown,
  expectedArtifactRoot: string,
): Promise<ConsumedCapture> {
  const artifact = captureArtifactSchema.parse(value);
  let canonicalArtifactPath: string | undefined;
  let openedIdentity: { dev: bigint; ino: bigint } | undefined;

  try {
    const canonicalBase = await realpath(resolve(tmpdir(), "computer-use-mcp"));
    const baseStat = await lstat(canonicalBase, { bigint: true });
    if (
      !baseStat.isDirectory() ||
      baseStat.uid !== BigInt(process.getuid?.() ?? -1) ||
      (baseStat.mode & 0o077n) !== 0n
    ) {
      throw new NativeError(
        "native_unavailable",
        "Native artifact base is not a private owned directory",
      );
    }

    const canonicalRoot = await realpath(artifact.artifactRoot);
    const canonicalExpectedRoot = await realpath(expectedArtifactRoot);
    if (canonicalRoot !== canonicalExpectedRoot) {
      throw new NativeError(
        "native_unavailable",
        "Native artifact did not belong to the active helper session",
      );
    }
    if (!isDirectChild(canonicalBase, canonicalRoot)) {
      throw new NativeError(
        "native_unavailable",
        "Native artifact root escaped its private base",
      );
    }

    const rootStat = await lstat(canonicalRoot, { bigint: true });
    if (
      !rootStat.isDirectory() ||
      rootStat.uid !== BigInt(process.getuid?.() ?? -1) ||
      (rootStat.mode & 0o077n) !== 0n
    ) {
      throw new NativeError(
        "native_unavailable",
        "Native artifact root is not a private owned directory",
      );
    }

    canonicalArtifactPath = await realpath(artifact.artifactPath);
    if (
      !isDirectChild(canonicalRoot, canonicalArtifactPath) ||
      dirname(canonicalArtifactPath) !== canonicalRoot
    ) {
      throw new NativeError(
        "native_unavailable",
        "Native artifact path escaped its session root",
      );
    }

    const pathStat = await lstat(canonicalArtifactPath, { bigint: true });
    const handle = await open(
      canonicalArtifactPath,
      constants.O_RDONLY | noFollow,
    );
    try {
      const stat = await handle.stat({ bigint: true });
      openedIdentity = { dev: stat.dev, ino: stat.ino };
      if (
        pathStat.dev !== stat.dev ||
        pathStat.ino !== stat.ino ||
        !stat.isFile() ||
        stat.uid !== BigInt(process.getuid?.() ?? -1) ||
        (stat.mode & 0o077n) !== 0n
      ) {
        throw new NativeError(
          "native_unavailable",
          "Native artifact is not a private owned regular file",
        );
      }
      if (
        stat.size <= 0n ||
        stat.size > BigInt(maximumArtifactBytes) ||
        stat.size !== BigInt(artifact.byteLength)
      ) {
        throw new NativeError(
          "native_unavailable",
          "Native artifact size is invalid",
        );
      }

      const bytes = await handle.readFile();
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== artifact.sha256) {
        throw new NativeError(
          "native_unavailable",
          "Native artifact hash did not match metadata",
        );
      }
      if (!validateMagic(bytes, artifact.mimeType)) {
        throw new NativeError(
          "native_unavailable",
          "Native artifact content did not match its MIME type",
        );
      }

      const {
        artifactRoot: _artifactRoot,
        artifactPath: _artifactPath,
        ...metadata
      } = artifact;
      return { metadata, data: bytes.toString("base64") };
    } finally {
      await handle.close();
    }
  } finally {
    const cleanupPath = canonicalArtifactPath ?? artifact.artifactPath;
    try {
      const canonicalCleanupPath = realpathSync(cleanupPath);
      const canonicalRoot = realpathSync(artifact.artifactRoot);
      if (isDirectChild(canonicalRoot, canonicalCleanupPath)) {
        const cleanupStat = await lstat(canonicalCleanupPath, { bigint: true });
        if (
          openedIdentity &&
          cleanupStat.dev === openedIdentity.dev &&
          cleanupStat.ino === openedIdentity.ino
        ) {
          await unlink(canonicalCleanupPath);
        }
      }
    } catch {
      // Cleanup is best-effort after validation failures or an already-removed file.
    }
  }
}
