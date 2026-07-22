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
  const shutdown = async (): Promise<void> => {
    await server.close();
    await native.close();
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
