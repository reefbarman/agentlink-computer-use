#!/usr/bin/env node

import { NativeClient } from "./native/client.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { access } from "node:fs/promises";
import { createServer } from "./server.js";
import { fileURLToPath } from "node:url";

function defaultNativePath(): string {
  return fileURLToPath(
    new URL("../native/.build/release/ComputerUseNative", import.meta.url),
  );
}

async function main(): Promise<void> {
  const executablePath =
    process.env.COMPUTER_USE_NATIVE_PATH ?? defaultNativePath();
  await access(executablePath);

  const native = new NativeClient({ executablePath });
  const server = createServer(native);
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await server.close();
    } finally {
      await native.close();
    }
  };
  const requestShutdown = (): void => {
    void shutdown().catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  };

  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);
  process.stdin.once("end", requestShutdown);
  process.stdin.once("close", requestShutdown);
  process.stdin.once("error", requestShutdown);
  process.stdout.once("error", requestShutdown);

  try {
    await server.connect(new StdioServerTransport());
  } catch (error) {
    await shutdown();
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
