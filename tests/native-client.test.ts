/// <reference types="node" />

import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { NativeClient } from "../src/native/client.js";
import { NativeError } from "../src/native/protocol.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/native-helper.mjs", import.meta.url),
);
const clients: NativeClient[] = [];

beforeAll(async () => {
  await chmod(fixturePath, 0o755);
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

function createClient(
  requestTimeoutMs = 1_000,
  inputRequestTimeoutMs?: number,
): NativeClient {
  const client = new NativeClient({
    executablePath: fixturePath,
    requestTimeoutMs,
    ...(inputRequestTimeoutMs === undefined ? {} : { inputRequestTimeoutMs }),
  });
  clients.push(client);
  return client;
}

describe("NativeClient", () => {
  it("correlates a successful response", async () => {
    await expect(createClient().request("health")).resolves.toEqual({
      healthy: true,
    });
  });

  it("maps structured native errors", async () => {
    await expect(createClient().request("fail")).rejects.toMatchObject({
      name: "NativeError",
      code: "action_failed",
      message: "fixture failure",
    } satisfies Partial<NativeError>);
  });

  it("terminates a timed-out helper and recovers with a fresh process", async () => {
    const client = createClient(250);
    await expect(client.request("hang")).rejects.toMatchObject({
      code: "timeout",
    });
    await expect(client.request("health")).resolves.toEqual({ healthy: true });
  });

  it("uses separate timeout budgets for input and post-action capture", async () => {
    const client = createClient(25, 250);
    await expect(client.request("mouse.move")).resolves.toEqual({
      moved: true,
    });
    await expect(client.request("keyboard.shortcut")).resolves.toEqual({
      moved: true,
    });
    await expect(client.request("input.batch")).resolves.toEqual({
      moved: true,
    });

    const compositeClient = createClient(25, 25);
    await expect(
      compositeClient.request("mouse.move", { captureAfter: {} }),
    ).resolves.toEqual({ moved: true });
  });

  it("rejects malformed native output and starts a fresh helper", async () => {
    const client = createClient();
    await expect(client.request("malformed")).rejects.toMatchObject({
      code: "native_unavailable",
    });
    await expect(client.request("health")).resolves.toEqual({ healthy: true });
  });

  it("rejects a request when close races initial startup", async () => {
    const client = createClient();
    const rejection = expect(client.request("health")).rejects.toMatchObject({
      code: "native_unavailable",
    });

    await client.close();
    await rejection;
  });
});
