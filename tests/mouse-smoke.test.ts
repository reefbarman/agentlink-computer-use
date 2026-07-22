import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { NativeClient } from "../src/native/client.js";

const nativePath = resolve("native/.build/release/ComputerUseNative");
const targetPath = resolve("native/.build/release/MouseTestTarget");

const targetEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    processId: z.number().int().positive(),
    bounds: z.object({
      x: z.number(),
      y: z.number(),
      width: z.number().positive(),
      height: z.number().positive(),
    }),
  }),
  z.object({
    type: z.enum([
      "leftDown",
      "leftUp",
      "leftDragged",
      "rightDown",
      "rightUp",
      "rightDragged",
      "otherDown",
      "otherUp",
      "otherDragged",
    ]),
    clickCount: z.number().int().nonnegative(),
    buttonNumber: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("scroll"),
    deltaX: z.number(),
    deltaY: z.number(),
  }),
]);

type TargetEvent = z.infer<typeof targetEventSchema>;

async function startTarget(): Promise<{
  child: ChildProcessWithoutNullStreams;
  events: TargetEvent[];
  ready: Extract<TargetEvent, { type: "ready" }>;
}> {
  const child = spawn(targetPath, [], { stdio: ["pipe", "pipe", "pipe"] });
  const events: TargetEvent[] = [];
  const lines = createInterface({ input: child.stdout });
  let resolveReady!: (event: Extract<TargetEvent, { type: "ready" }>) => void;
  let rejectReady!: (error: Error) => void;
  const readyPromise = new Promise<Extract<TargetEvent, { type: "ready" }>>(
    (resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    },
  );

  lines.on("line", (line) => {
    try {
      const event = targetEventSchema.parse(JSON.parse(line));
      events.push(event);
      if (event.type === "ready") {
        resolveReady(event);
      }
    } catch (error) {
      rejectReady(error instanceof Error ? error : new Error(String(error)));
    }
  });
  child.once("error", rejectReady);
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  const timeout = setTimeout(
    () => rejectReady(new Error("Mouse test target timed out")),
    5_000,
  );
  try {
    const ready = await readyPromise;
    return { child, events, ready };
  } finally {
    clearTimeout(timeout);
  }
}

async function stopTarget(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

async function waitForEvents(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250));
}

async function verifySignalReleasesButton(point: {
  x: number;
  y: number;
}): Promise<void> {
  const child = spawn(nativePath, ["serve"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  const lines = createInterface({ input: child.stdout });
  const requestId = "signal-release";
  const response = new Promise<void>((resolve, reject) => {
    lines.on("line", (line) => {
      try {
        const value = JSON.parse(line) as {
          id?: unknown;
          ok?: unknown;
          error?: unknown;
        };
        if (value.id !== requestId) {
          return;
        }
        if (value.ok !== true) {
          reject(
            new Error(
              `Native button-down failed: ${JSON.stringify(value.error)}`,
            ),
          );
          return;
        }
        resolve();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      reject(
        new Error(
          `Native helper exited before button-down response (${signal ?? code})`,
        ),
      );
    });
  });

  try {
    child.stdin.write(
      `${JSON.stringify({
        version: 1,
        id: requestId,
        method: "mouse.button",
        params: { button: "left", action: "down", point },
      })}\n`,
    );
    await response;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
    lines.close();
  }
}

describe("mouse input smoke", () => {
  it("delivers clicks, drag, held-button recovery, and scroll to a disposable window", async () => {
    const target = await startTarget();
    const client = new NativeClient({ executablePath: nativePath });
    const initial = await client.request<{
      position: { x: number; y: number };
    }>("mouse.position");
    const center = {
      x: target.ready.bounds.x + target.ready.bounds.width / 2,
      y: target.ready.bounds.y + target.ready.bounds.height / 2,
    };
    const dragEnd = { x: center.x + 60, y: center.y + 30 };

    try {
      await client.request("application.activate", {
        processId: target.ready.processId,
      });
      await client.request("mouse.move", { to: center, durationMs: 50 });
      await client.request("mouse.click", {
        button: "left",
        point: center,
        count: 1,
        intervalMs: 0,
      });
      await client.request("mouse.click", {
        button: "right",
        point: center,
        count: 1,
        intervalMs: 0,
      });
      await client.request("mouse.click", {
        button: "middle",
        point: center,
        count: 1,
        intervalMs: 0,
      });
      await client.request("mouse.drag", {
        button: "left",
        from: center,
        to: dragEnd,
        durationMs: 100,
      });
      await client.request("mouse.button", {
        button: "left",
        action: "down",
        point: center,
      });
      await client.request("mouse.move", { to: dragEnd, durationMs: 50 });
      const released = await client.request<{
        heldButtons: string[];
        releasedButtons: string[];
      }>("input.releaseAll");
      expect(released).toMatchObject({
        heldButtons: [],
        releasedButtons: ["left"],
      });
      await waitForEvents();

      const batchStartIndex = target.events.length;
      const batch = await client.request<{
        completed: boolean;
        completedCount: number;
        failure: {
          index: number;
          error: { code: string };
          cleanup: { heldButtons: string[]; releasedButtons: string[] };
        };
      }>("input.batch", {
        steps: [
          {
            type: "mouse_button",
            button: "left",
            action: "down",
            point: center,
          },
          { type: "mouse_button", button: "left", action: "down" },
          { type: "mouse_button", button: "right", action: "down" },
        ],
      });
      expect(batch).toMatchObject({
        completed: false,
        completedCount: 1,
        failure: {
          index: 1,
          error: { code: "action_failed" },
          cleanup: { heldButtons: [], releasedButtons: ["left"] },
        },
      });
      await waitForEvents();
      const batchEvents = target.events.slice(batchStartIndex);
      expect(
        batchEvents.filter((event) => event.type === "leftDown"),
      ).toHaveLength(1);
      expect(
        batchEvents.filter((event) => event.type === "leftUp"),
      ).toHaveLength(1);
      expect(batchEvents.some((event) => event.type === "rightDown")).toBe(
        false,
      );

      await client.request("mouse.scroll", {
        deltaX: 0,
        deltaY: -3,
        unit: "line",
        point: center,
      });
      await client.request("mouse.scroll", {
        deltaX: 25,
        deltaY: 0,
        unit: "pixel",
        point: center,
      });
      await waitForEvents();

      const types = target.events.map((event) => event.type);
      expect(types).toEqual(expect.arrayContaining(["leftDown", "leftUp"]));
      expect(types).toEqual(expect.arrayContaining(["rightDown", "rightUp"]));
      expect(types).toEqual(expect.arrayContaining(["otherDown", "otherUp"]));
      expect(types).toContain("leftDragged");
      expect(
        target.events.filter((event) => event.type === "scroll").length,
      ).toBeGreaterThanOrEqual(2);

      const leftDownCount = target.events.filter(
        (event) => event.type === "leftDown",
      ).length;
      const leftUpCount = target.events.filter(
        (event) => event.type === "leftUp",
      ).length;
      await verifySignalReleasesButton(center);
      await waitForEvents();
      expect(
        target.events.filter((event) => event.type === "leftDown").length,
      ).toBeGreaterThan(leftDownCount);
      expect(
        target.events.filter((event) => event.type === "leftUp").length,
      ).toBeGreaterThan(leftUpCount);
    } finally {
      await client.request("input.releaseAll").catch(() => undefined);
      await client
        .request("mouse.move", { to: initial.position, durationMs: 0 })
        .catch(() => undefined);
      await client.close();
      await stopTarget(target.child);
    }
  });
});
