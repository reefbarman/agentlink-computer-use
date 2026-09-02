/// <reference types="node" />

import { describe, expect, it } from "vitest";

import type { NativeBridge } from "../src/native/client.js";
import { OperationCoordinator } from "../src/semantic/operation-coordinator.js";

class DeferredBridge implements NativeBridge {
  readonly started: string[] = [];
  readonly pending = new Map<string, () => void>();

  request<T>(method: string): Promise<T> {
    this.started.push(method);
    return new Promise<T>((resolve) => {
      this.pending.set(method, () => resolve({ method } as T));
    });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  resolve(method: string): void {
    const complete = this.pending.get(method);
    if (complete === undefined) throw new Error(`No pending ${method}`);
    this.pending.delete(method);
    complete();
  }
}

describe("operation coordinator", () => {
  it("serializes ordinary native requests", async () => {
    const bridge = new DeferredBridge();
    const coordinator = new OperationCoordinator(bridge);

    const first = coordinator.request("first");
    const second = coordinator.request("second");
    await Promise.resolve();
    expect(bridge.started).toEqual(["first"]);

    bridge.resolve("first");
    await first;
    await Promise.resolve();
    expect(bridge.started).toEqual(["first", "second"]);
    bridge.resolve("second");
    await second;
  });

  it("lets release-all bypass a busy lease while keeping ordinary work queued", async () => {
    const bridge = new DeferredBridge();
    const coordinator = new OperationCoordinator(bridge);

    const first = coordinator.request("first");
    const queued = coordinator.request("second");
    await Promise.resolve();
    const release = coordinator.request("input.releaseAll");
    await Promise.resolve();
    expect(bridge.started).toEqual(["first", "input.releaseAll"]);

    bridge.resolve("input.releaseAll");
    await release;
    expect(bridge.started).toEqual(["first", "input.releaseAll"]);
    bridge.resolve("first");
    await first;
    await Promise.resolve();
    expect(bridge.started).toEqual(["first", "input.releaseAll", "second"]);
    bridge.resolve("second");
    await queued;
  });

  it("continues after a failed operation", async () => {
    const bridge: NativeBridge = {
      request: async <T>(method: string) => {
        if (method === "fails") throw new Error("expected failure");
        return { method } as T;
      },
      close: async () => {},
    };
    const coordinator = new OperationCoordinator(bridge);

    await expect(coordinator.request("fails")).rejects.toThrow(
      "expected failure",
    );
    await expect(coordinator.request("after-failure")).resolves.toEqual({
      method: "after-failure",
    });
  });

  it("allows nested workflow requests under one exclusive lease", async () => {
    const bridge = new DeferredBridge();
    const coordinator = new OperationCoordinator(bridge);

    const workflow = coordinator.runExclusive(async () => {
      const first = coordinator.request("workflow-first");
      await Promise.resolve();
      bridge.resolve("workflow-first");
      await first;
      const second = coordinator.request("workflow-second");
      await Promise.resolve();
      bridge.resolve("workflow-second");
      await second;
    });
    const external = coordinator.request("external");

    await workflow;
    await Promise.resolve();
    expect(bridge.started).toEqual([
      "workflow-first",
      "workflow-second",
      "external",
    ]);
    bridge.resolve("external");
    await external;
  });
});
