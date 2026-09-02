import { AsyncLocalStorage } from "node:async_hooks";
import type { NativeBridge } from "../native/client.js";

const releaseAllMethod = "input.releaseAll";

export interface CoordinatedNativeBridge extends NativeBridge {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
}

/**
 * Serializes server-originated native operations. A workflow can hold one lease
 * across multiple native requests; recovery release-all deliberately bypasses
 * the lease, though the helper's own sequential stdin loop still orders it
 * after an already-submitted native request.
 */
export class OperationCoordinator implements CoordinatedNativeBridge {
  readonly #lease = new AsyncLocalStorage<symbol>();
  readonly #native: NativeBridge;
  #queue: Promise<void> = Promise.resolve();

  constructor(native: NativeBridge) {
    this.#native = native;
  }

  request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (method === releaseAllMethod || this.#lease.getStore() !== undefined) {
      return this.#native.request<T>(method, params);
    }
    return this.#enqueue(() => this.#native.request<T>(method, params));
  }

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#lease.getStore() !== undefined) return operation();
    const token = Symbol("semantic-operation-lease");
    return this.#enqueue(() => this.#lease.run(token, operation));
  }

  close(): Promise<void> {
    return this.#native.close();
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
