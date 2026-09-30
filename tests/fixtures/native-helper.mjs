#!/usr/bin/env node

import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.method === "health") {
    process.stdout.write(
      `${JSON.stringify({ id: request.id, ok: true, result: { healthy: true } })}\n`,
    );
  } else if (request.method === "lmStudio.status") {
    process.stdout.write(
      `${JSON.stringify({ id: request.id, ok: true, result: { lmStudio: request.params } })}\n`,
    );
  } else if (request.method === "quit") {
    process.exit(64);
  } else if (request.method === "ignoreShutdown") {
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1_000);
    process.stdout.write(
      `${JSON.stringify({ id: request.id, ok: true, result: { pid: process.pid } })}\n`,
    );
  } else if (request.method === "fail") {
    process.stdout.write(
      `${JSON.stringify({ id: request.id, ok: false, error: { code: "action_failed", message: "fixture failure" } })}\n`,
    );
  } else if (request.method === "hang") {
    continue;
  } else if (request.method === "accessibility.wait") {
    setTimeout(() => {
      process.stdout.write(
        `${JSON.stringify({ id: request.id, ok: true, result: { waited: true } })}\n`,
      );
    }, 125);
  } else if (
    request.method === "mouse.move" ||
    request.method === "keyboard.shortcut" ||
    request.method === "input.batch"
  ) {
    setTimeout(() => {
      process.stdout.write(
        `${JSON.stringify({ id: request.id, ok: true, result: { moved: true } })}\n`,
      );
    }, 75);
  } else if (request.method === "malformed") {
    process.stdout.write("not-json\n");
  }
}
