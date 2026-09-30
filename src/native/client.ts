import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import {
  lmStudioStatusSchema,
  type LmStudioStatus,
} from "../semantic/lm-studio-status.js";

import {
  NativeError,
  nativeResponseSchema,
  type NativeRequest,
  type NativeResponse,
} from "./protocol.js";

// Shared with NativeLifecycle.swift: local Quit disables respawning for this client.
const nativeUserQuitExitCode = 64;

export interface NativeBridge {
  request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
  readonly isRunning?: boolean;
  updateLmStudioStatus?(status: LmStudioStatus): Promise<void>;
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

  get isRunning(): boolean {
    return (
      !this.#closed &&
      this.#process !== undefined &&
      this.#process.exitCode === null &&
      this.#process.signalCode === null
    );
  }

  updateLmStudioStatus(status: LmStudioStatus): Promise<void> {
    const params = lmStudioStatusSchema.parse(status);
    const result = this.#requestQueue.then(async () => {
      // The check happens inside the queue, so a queued update cannot revive a helper.
      if (!this.isRunning) return;
      const response = await this.#dispatchRequest<{ lmStudio: unknown }>(
        "lmStudio.status",
        params,
      );
      lmStudioStatusSchema.parse(response.lmStudio);
    });
    this.#requestQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    await new Promise<void>((resolve) => {
      const terminate = setTimeout(() => {
        child.kill("SIGTERM");
      }, 1_000);
      this.#scheduleForceKill(child);
      child.once("exit", () => {
        clearTimeout(terminate);
        resolve();
      });
      child.stdin.end();
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
      if (code === nativeUserQuitExitCode) this.#closed = true;
      const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      this.#rejectAll(
        new NativeError(
          "native_unavailable",
          code === nativeUserQuitExitCode
            ? "Computer use was quit from the menu bar; reconnect the MCP server to restart it"
            : `Native helper exited with ${detail}`,
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
    if (child.exitCode === null && child.signalCode === null) {
      this.#scheduleForceKill(child);
      child.kill("SIGTERM");
    }
  }

  #scheduleForceKill(child: ChildProcessWithoutNullStreams): void {
    const timeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 4_000);
    child.once("exit", () => clearTimeout(timeout));
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
