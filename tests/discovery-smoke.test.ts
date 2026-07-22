import { describe, expect, it } from "vitest";

import { NativeClient } from "../src/native/client.js";
import { resolve } from "node:path";

const helperPath = resolve("native/.build/release/ComputerUseNative");

interface Application {
  processId: number;
  bundleIdentifier: string | null;
}

interface Window {
  windowId: string;
  title: string;
}

describe("discovery and focus smoke", () => {
  it("activates VS Code and verifies focus for a discovered window", async () => {
    const client = new NativeClient({ executablePath: helperPath });
    try {
      const applicationResult = await client.request<{
        applications: Application[];
      }>("application.list", { includeBackground: false });
      const code = applicationResult.applications.find(
        (application) =>
          application.bundleIdentifier === "com.microsoft.VSCode",
      );
      if (!code) {
        throw new Error("VS Code is not running as a regular GUI application");
      }

      const windowResult = await client.request<{ windows: Window[] }>(
        "window.list",
        {
          processId: code.processId,
          onScreenOnly: true,
          includeUntitled: false,
        },
      );
      const window = windowResult.windows[0];
      if (!window) {
        throw new Error("VS Code has no titled on-screen window to focus");
      }

      const activated = await client.request<{ verified: boolean }>(
        "application.activate",
        { processId: code.processId },
      );
      expect(activated.verified).toBe(true);

      const focused = await client.request<{
        windowId: string;
        verified: boolean;
      }>("window.focus", { windowId: window.windowId });
      expect(focused).toMatchObject({
        windowId: window.windowId,
        verified: true,
      });
    } finally {
      await client.close();
    }
  });
});
