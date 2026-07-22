/// <reference types="node" />

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { NativeClient } from "../src/native/client.js";

const nativePath = resolve("native/.build/release/ComputerUseNative");
const targetPath = resolve("native/.build/release/KeyboardTestTarget");
const shiftMask = 1 << 17;
const commandMask = 1 << 20;
const nativeInputEventUserData = 0x4355_4d43;

const readyEventSchema = z.object({
  type: z.literal("ready"),
  processId: z.number().int().positive(),
});
const keyboardEventSchema = z.object({
  type: z.enum(["keyDown", "keyUp", "flagsChanged"]),
  key: z.string(),
  keyCode: z.number().int().nonnegative(),
  modifierFlags: z.number().int().nonnegative(),
  userData: z.number().int(),
  isRepeat: z.boolean(),
  characters: z.string(),
  charactersIgnoringModifiers: z.string(),
  text: z.string().optional(),
});
const targetEventSchema = z.union([readyEventSchema, keyboardEventSchema]);

type ReadyEvent = z.infer<typeof readyEventSchema>;
type KeyboardEvent = z.infer<typeof keyboardEventSchema>;
type TargetEvent = z.infer<typeof targetEventSchema>;

interface TargetProcess {
  child: ChildProcessWithoutNullStreams;
  events: TargetEvent[];
  ready: ReadyEvent;
}

async function startTarget(): Promise<TargetProcess> {
  const child = spawn(targetPath, [], { stdio: ["pipe", "pipe", "pipe"] });
  const events: TargetEvent[] = [];
  const lines = createInterface({ input: child.stdout });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    const ready = await new Promise<ReadyEvent>((resolveReady, rejectReady) => {
      const timeout = setTimeout(
        () => rejectReady(new Error("Keyboard test target timed out")),
        5_000,
      );
      lines.on("line", (line) => {
        try {
          const event = targetEventSchema.parse(JSON.parse(line));
          events.push(event);
          if (event.type === "ready") {
            clearTimeout(timeout);
            resolveReady(event);
          }
        } catch (error) {
          clearTimeout(timeout);
          rejectReady(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      });
      child.once("error", rejectReady);
      child.once("exit", (code, signal) => {
        clearTimeout(timeout);
        rejectReady(
          new Error(`Keyboard target exited before ready (${signal ?? code})`),
        );
      });
    });

    return { child, events, ready };
  } catch (error) {
    lines.close();
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
    throw error;
  }
}

async function stopProcess(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await new Promise<void>((resolveExit) =>
    child.once("exit", () => resolveExit()),
  );
}

async function waitForEvent(
  events: TargetEvent[],
  startIndex: number,
  predicate: (event: KeyboardEvent) => boolean,
): Promise<number> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const index = events.findIndex(
      (event, candidateIndex) =>
        candidateIndex >= startIndex &&
        event.type !== "ready" &&
        event.userData === nativeInputEventUserData &&
        predicate(event),
    );
    if (index >= 0) {
      return index;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(
    `Expected keyboard event was not delivered to the disposable target: ${JSON.stringify(
      events.slice(startIndex),
    )}`,
  );
}

async function verifySignalRelease(
  events: TargetEvent[],
  probe: () => Promise<void>,
): Promise<{ keyUpIndex: number; probeIndex: number }> {
  const child = spawn(nativePath, ["serve"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<
    string,
    { resolve(): void; reject(error: Error): void }
  >();
  lines.on("line", (line) => {
    try {
      const response = JSON.parse(line) as {
        id?: unknown;
        ok?: unknown;
        error?: { message?: unknown };
      };
      const request = pending.get(String(response.id));
      if (!request) {
        return;
      }
      pending.delete(String(response.id));
      if (response.ok === true) {
        request.resolve();
      } else {
        request.reject(
          new Error(
            typeof response.error?.message === "string"
              ? response.error.message
              : "Native keyboard request failed",
          ),
        );
      }
    } catch (error) {
      for (const request of pending.values()) {
        request.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      pending.clear();
    }
  });

  let requestNumber = 0;
  const request = async (method: string, params: Record<string, unknown>) => {
    const id = `signal-${requestNumber++}`;
    const response = new Promise<void>((resolveResponse, rejectResponse) => {
      pending.set(id, { resolve: resolveResponse, reject: rejectResponse });
    });
    child.stdin.write(
      `${JSON.stringify({ version: 1, id, method, params })}\n`,
    );
    await response;
  };

  const startIndex = events.length;
  try {
    await request("keyboard.key", { key: "shift", action: "down" });
    await request("keyboard.key", { key: "x", action: "down" });
    await waitForEvent(
      events,
      startIndex,
      (event) => event.type === "keyDown" && event.key === "x",
    );
    child.kill("SIGTERM");
    await new Promise<void>((resolveExit) =>
      child.once("exit", () => resolveExit()),
    );
    const keyUpIndex = await waitForEvent(
      events,
      startIndex,
      (event) => event.type === "keyUp" && event.key === "x",
    );
    await probe();
    const probeIndex = await waitForEvent(
      events,
      keyUpIndex + 1,
      (event) =>
        event.type === "keyDown" &&
        event.key === "z" &&
        event.characters === "z" &&
        (event.modifierFlags & shiftMask) === 0,
    );
    return { keyUpIndex, probeIndex };
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
    lines.close();
  }
}

describe("keyboard input smoke", () => {
  it("delivers Unicode, named keys, shortcuts, and recovery to a disposable editor", async () => {
    const client = new NativeClient({ executablePath: nativePath });
    let target: TargetProcess | undefined;

    try {
      await client.request("health");
      target = await startTarget();
      const activeTarget = target;
      await client.request("application.activate", {
        processId: activeTarget.ready.processId,
      });

      const unicodeText = "Hello, 世界 👋";
      let startIndex = activeTarget.events.length;
      await client.request("keyboard.type", {
        text: unicodeText,
        intervalMs: 0,
      });
      await waitForEvent(
        activeTarget.events,
        startIndex,
        (event) =>
          event.type === "keyDown" &&
          activeTarget.events
            .slice(startIndex)
            .filter(
              (candidate): candidate is KeyboardEvent =>
                candidate.type === "keyDown" &&
                candidate.userData === nativeInputEventUserData,
            )
            .map((candidate) => candidate.characters)
            .join("") === unicodeText,
      );

      startIndex = target.events.length;
      await client.request("keyboard.key", {
        key: "a",
        action: "press",
        modifiers: ["shift"],
        repeat: 2,
      });
      const firstShiftedAIndex = await waitForEvent(
        target.events,
        startIndex,
        (event) =>
          event.type === "keyDown" &&
          event.key === "a" &&
          (event.modifierFlags & shiftMask) !== 0,
      );
      await waitForEvent(
        target.events,
        firstShiftedAIndex + 1,
        (event) =>
          event.type === "keyDown" &&
          event.key === "a" &&
          (event.modifierFlags & shiftMask) !== 0,
      );
      const shiftedAEvents = target.events
        .slice(startIndex)
        .filter(
          (event): event is KeyboardEvent =>
            event.type === "keyDown" &&
            event.userData === nativeInputEventUserData &&
            event.key === "a" &&
            (event.modifierFlags & shiftMask) !== 0,
        );
      expect(shiftedAEvents).toHaveLength(2);
      expect(shiftedAEvents.every((event) => event.isRepeat === false)).toBe(
        true,
      );

      startIndex = target.events.length;
      await client.request("keyboard.shortcut", {
        keys: ["command", "a"],
        holdMs: 25,
      });
      await waitForEvent(
        target.events,
        startIndex,
        (event) =>
          event.type === "keyDown" &&
          event.key === "a" &&
          (event.modifierFlags & commandMask) !== 0,
      );

      startIndex = target.events.length;
      await client.request("keyboard.key", { key: "shift", action: "down" });
      await client.request("keyboard.key", { key: "x", action: "down" });
      const released = await client.request<{
        heldKeys: string[];
        heldModifiers: string[];
        releasedKeys: string[];
        releasedModifiers: string[];
      }>("input.releaseAll");
      expect(released).toMatchObject({
        heldKeys: [],
        heldModifiers: [],
        releasedKeys: ["x"],
        releasedModifiers: ["shift"],
      });
      const keyUpIndex = await waitForEvent(
        target.events,
        startIndex,
        (event) => event.type === "keyUp" && event.key === "x",
      );
      await client.request("keyboard.key", { key: "z", action: "press" });
      const probeIndex = await waitForEvent(
        target.events,
        keyUpIndex + 1,
        (event) =>
          event.type === "keyDown" &&
          event.key === "z" &&
          event.characters === "z" &&
          (event.modifierFlags & shiftMask) === 0,
      );
      expect(keyUpIndex).toBeLessThan(probeIndex);

      startIndex = target.events.length;
      const batch = await client.request<{
        completed: boolean;
        completedCount: number;
        failure: {
          index: number;
          error: { code: string };
          cleanup: {
            heldKeys: string[];
            heldModifiers: string[];
            releasedKeys: string[];
            releasedModifiers: string[];
          };
        };
      }>("input.batch", {
        steps: [
          { type: "keyboard_key", key: "shift", action: "down" },
          { type: "keyboard_key", key: "x", action: "down" },
          { type: "keyboard_key", key: "x", action: "down" },
          { type: "keyboard_key", key: "z", action: "press" },
        ],
      });
      expect(batch).toMatchObject({
        completed: false,
        completedCount: 2,
        failure: {
          index: 2,
          error: { code: "action_failed" },
          cleanup: {
            heldKeys: [],
            heldModifiers: [],
            releasedKeys: ["x"],
            releasedModifiers: ["shift"],
          },
        },
      });
      const batchKeyUpIndex = await waitForEvent(
        target.events,
        startIndex,
        (event) => event.type === "keyUp" && event.key === "x",
      );
      expect(
        target.events
          .slice(startIndex, batchKeyUpIndex + 1)
          .some(
            (event) =>
              event.type !== "ready" &&
              event.userData === nativeInputEventUserData &&
              event.type === "keyDown" &&
              event.key === "z",
          ),
      ).toBe(false);

      const signalRelease = await verifySignalRelease(target.events, async () =>
        client.request("keyboard.key", { key: "z", action: "press" }),
      );
      expect(signalRelease.keyUpIndex).toBeLessThan(signalRelease.probeIndex);
    } finally {
      await client.request("input.releaseAll").catch(() => undefined);
      await client.close();
      if (target) {
        await stopProcess(target.child);
      }
    }
  });
});
