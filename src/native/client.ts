import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

import {
  NativeError,
  nativeResponseSchema,
  type NativeRequest,
  type NativeResponse,
} from "./protocol.js";

export interface NativeBridge {
  request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

export interface NativeClientOptions {
  executablePath: string;
  requestTimeoutMs?: number;
  inputRequestTimeoutMs?: number;
  captureRequestTimeoutMs?: number;
  stderr?: NodeJS.WritableStream;
}

interface ResolvedNativeClientOptions {
  executablePath: string;
  requestTimeoutMs: number;
  inputRequestTimeoutMs: number;
  captureRequestTimeoutMs: number;
  stderr: NodeJS.WritableStream;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

export class NativeClient implements NativeBridge {
  readonly #options: ResolvedNativeClientOptions;
  readonly #pending = new Map<string, PendingRequest>();
  #process: ChildProcessWithoutNullStreams | undefined;
  #starting: Promise<ChildProcessWithoutNullStreams> | undefined;
  #requestQueue: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(options: NativeClientOptions) {
    this.#options = {
      requestTimeoutMs: 10_000,
      inputRequestTimeoutMs: 15_000,
      captureRequestTimeoutMs: 30_000,
      stderr: process.stderr,
      ...options,
    };
  }

  request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const result = this.#requestQueue.then(() =>
      this.#dispatchRequest<T>(method, params),
    );
    this.#requestQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #dispatchRequest<T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    if (this.#closed) {
      throw new NativeError("native_unavailable", "Native client is closed");
    }

    const child = await this.#getProcess();
    if (this.#closed) {
      throw new NativeError("native_unavailable", "Native client is closed");
    }

    const id = randomUUID();
    const request: NativeRequest = { id, version: 1, method, params };

    const isAccessibilityRequest = method.startsWith("accessibility.");
    const accessibilityRequestTimeoutMs = 8_000;
    // accessibility.wait permits up to 30 seconds plus one worst-case
    // 3-second AX traversal and scheduling/serialization margin.
    const accessibilityWaitTimeoutMs =
      method === "accessibility.wait"
        ? Math.min(
            30_000,
            typeof params.timeoutMs === "number" &&
              Number.isInteger(params.timeoutMs)
              ? Math.max(0, params.timeoutMs)
              : 10_000,
          ) + 8_000
        : method === "accessibility.act" || method === "accessibility.fill"
          ? // Verification polling plus one worst-case resolve, the dispatch
            // boundary, and one worst-case verification traversal.
            Math.min(
              15_000,
              typeof params.verificationTimeoutMs === "number" &&
                Number.isInteger(params.verificationTimeoutMs)
                ? Math.max(0, params.verificationTimeoutMs)
                : 3_000,
            ) + 12_000
          : accessibilityRequestTimeoutMs;
    const isInputRequest =
      method === "mouse.move" ||
      method === "mouse.drag" ||
      method === "keyboard.type" ||
      method === "keyboard.shortcut";
    // Batches allow 30 seconds of declared delays plus bounded per-step cursor
    // verification overhead and scheduling margin.
    const inputBatchRequestTimeoutMs = 45_000;
    const requestTimeoutMs =
      params.captureAfter !== undefined
        ? (method === "input.batch"
            ? inputBatchRequestTimeoutMs
            : isInputRequest
              ? this.#options.inputRequestTimeoutMs
              : this.#options.requestTimeoutMs) +
          this.#options.captureRequestTimeoutMs +
          5_000
        : method === "screen.capture"
          ? this.#options.captureRequestTimeoutMs
          : isAccessibilityRequest
            ? accessibilityWaitTimeoutMs
            : method === "input.batch"
              ? inputBatchRequestTimeoutMs
              : isInputRequest
                ? this.#options.inputRequestTimeoutMs
                : this.#options.requestTimeoutMs;

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.#pending.has(id)) {
          return;
        }
        const error = new NativeError(
          "timeout",
          `Native request '${method}' timed out`,
        );
        this.#invalidateProcess(child, error);
      }, requestTimeoutMs);

      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });

      child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (!error) {
          return;
        }

        const pending = this.#pending.get(id);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.#pending.delete(id);
        pending.reject(
          new NativeError(
            "native_unavailable",
            `Could not write native request: ${error.message}`,
          ),
        );
      });
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#rejectAll(
      new NativeError("native_unavailable", "Native client is closed"),
    );

    let child = this.#process;
    if (!child && this.#starting) {
      try {
        child = await this.#starting;
      } catch {
        return;
      }
    }

    if (this.#process === child) {
      this.#process = undefined;
    }
    if (!child || child.exitCode !== null) {
      return;
    }

    child.stdin.end();
    await new Promise<void>((resolve) => {
      const forceKill = setTimeout(() => {
        child.kill("SIGTERM");
      }, 1_000);
      child.once("exit", () => {
        clearTimeout(forceKill);
        resolve();
      });
    });
  }

  async #getProcess(): Promise<ChildProcessWithoutNullStreams> {
    if (this.#process?.exitCode === null) {
      return this.#process;
    }
    if (this.#starting) {
      return this.#starting;
    }

    this.#starting = this.#startProcess();
    try {
      return await this.#starting;
    } finally {
      this.#starting = undefined;
    }
  }

  async #startProcess(): Promise<ChildProcessWithoutNullStreams> {
    const child = spawn(this.#options.executablePath, ["serve"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stderr.pipe(this.#options.stderr);
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.#handleLine(child, line));
    child.once("exit", (code, signal) => {
      if (this.#process !== child) {
        return;
      }

      this.#process = undefined;
      const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      this.#rejectAll(
        new NativeError(
          "native_unavailable",
          `Native helper exited with ${detail}`,
        ),
      );
    });
    child.once("error", (error) => {
      if (this.#process !== child) {
        return;
      }

      this.#process = undefined;
      this.#rejectAll(
        new NativeError(
          "native_unavailable",
          `Native helper failed: ${error.message}`,
        ),
      );
    });

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => {
        this.#process = child;
        resolve();
      });
      child.once("error", reject);
    });
    return child;
  }

  #handleLine(child: ChildProcessWithoutNullStreams, line: string): void {
    if (this.#process !== child) {
      return;
    }

    let response: NativeResponse;
    try {
      response = nativeResponseSchema.parse(JSON.parse(line));
    } catch (error) {
      this.#rejectAll(
        new NativeError(
          "native_unavailable",
          `Native helper emitted an invalid response: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      this.#invalidateProcess(child, error as Error);
      return;
    }

    if (response.id === null) {
      return;
    }
    const pending = this.#pending.get(String(response.id));
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.#pending.delete(String(response.id));
    if (response.ok) {
      pending.resolve(response.result);
    } else {
      pending.reject(
        new NativeError(response.error.code, response.error.message),
      );
    }
  }

  #invalidateProcess(
    child: ChildProcessWithoutNullStreams,
    error: Error,
  ): void {
    if (this.#process !== child) {
      return;
    }
    this.#process = undefined;
    this.#rejectAll(error);
    if (child.exitCode === null) {
      child.kill("SIGTERM");
    }
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
