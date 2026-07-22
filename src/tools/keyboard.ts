import {
  addCaptureAfter,
  interactionToolResult,
  withCaptureAfter,
} from "./post-action-capture.js";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NativeBridge } from "../native/client.js";
import { z } from "zod";

export const modifierSchema = z.enum(["command", "option", "control", "shift"]);

export const keyboardKeySchema = z.enum([
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
  "i",
  "j",
  "k",
  "l",
  "m",
  "n",
  "o",
  "p",
  "q",
  "r",
  "s",
  "t",
  "u",
  "v",
  "w",
  "x",
  "y",
  "z",
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "return",
  "tab",
  "escape",
  "space",
  "backspace",
  "delete",
  "forward-delete",
  "home",
  "end",
  "page-up",
  "page-down",
  "left-arrow",
  "right-arrow",
  "up-arrow",
  "down-arrow",
  "minus",
  "equal",
  "left-bracket",
  "right-bracket",
  "backslash",
  "semicolon",
  "quote",
  "comma",
  "period",
  "slash",
  "grave",
  "f1",
  "f2",
  "f3",
  "f4",
  "f5",
  "f6",
  "f7",
  "f8",
  "f9",
  "f10",
  "f11",
  "f12",
  "f13",
  "f14",
  "f15",
  "f16",
  "f17",
  "f18",
  "f19",
  "f20",
  "command",
  "option",
  "control",
  "shift",
  "caps-lock",
]);

export const keyboardStateSchema = z.object({
  heldKeys: z.array(keyboardKeySchema.exclude(["delete"])),
  heldModifiers: z.array(modifierSchema),
});

export function registerKeyboardTools(
  server: McpServer,
  native: NativeBridge,
): void {
  server.registerTool(
    "keyboard_type",
    {
      title: "Type text",
      description:
        "Type Unicode text into the focused application using keyboard events without modifying the clipboard. Optionally capture the resulting UI with captureAfter; capture failures are reported separately from the successful typing operation.",
      inputSchema: addCaptureAfter(
        z.object({
          text: z.string().min(1).max(4_096),
          intervalMs: z.number().int().min(0).max(1_000).default(0),
        }),
      ).refine(
        ({ text, intervalMs }) =>
          Math.max(0, Array.from(text).length - 1) * intervalMs <= 10_000,
        { message: "Keyboard typing delay may not exceed 10000 ms" },
      ),
      outputSchema: withCaptureAfter(keyboardStateSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      interactionToolResult(
        native,
        "keyboard.type",
        input,
        keyboardStateSchema,
      ),
  );

  server.registerTool(
    "keyboard_key",
    {
      title: "Send keyboard key",
      description:
        "Press, hold, or release a named key. Press actions may include transient modifiers and repeat count; held state is recoverable with input_release_all. Optionally capture the resulting UI with captureAfter; capture failures are reported separately from the successful key operation.",
      inputSchema: addCaptureAfter(
        z.object({
          key: keyboardKeySchema,
          action: z.enum(["press", "down", "up"]).default("press"),
          modifiers: z.array(modifierSchema).max(5).default([]),
          repeat: z.number().int().min(1).max(100).default(1),
        }),
      ).superRefine(({ key, action, modifiers, repeat }, context) => {
        if (new Set(modifiers).size !== modifiers.length) {
          context.addIssue({
            code: "custom",
            path: ["modifiers"],
            message: "Modifiers must not contain duplicates",
          });
        }
        if (action !== "press" && (modifiers.length > 0 || repeat !== 1)) {
          context.addIssue({
            code: "custom",
            message:
              "Modifiers and repeat are supported only for press actions",
          });
        }
        if (action === "press" && modifiers.includes(key as never)) {
          context.addIssue({
            code: "custom",
            path: ["modifiers"],
            message: "A key cannot also be its own transient modifier",
          });
        }
        if (
          key === "caps-lock" &&
          (action !== "press" || modifiers.length > 0 || repeat !== 1)
        ) {
          context.addIssue({
            code: "custom",
            message:
              "Caps Lock supports only a one-shot press without modifiers or repeat",
          });
        }
      }),
      outputSchema: withCaptureAfter(keyboardStateSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      interactionToolResult(native, "keyboard.key", input, keyboardStateSchema),
  );

  server.registerTool(
    "keyboard_shortcut",
    {
      title: "Send keyboard shortcut",
      description:
        "Press an ordered chord of distinct named keys, optionally hold it briefly, then release the keys in reverse order. Optionally capture the resulting UI with captureAfter; capture failures are reported separately from the successful shortcut.",
      inputSchema: addCaptureAfter(
        z.object({
          keys: z.array(keyboardKeySchema).min(2).max(8),
          holdMs: z.number().int().min(0).max(10_000).default(0),
        }),
      ).superRefine(({ keys }, context) => {
        if (new Set(keys).size !== keys.length) {
          context.addIssue({
            code: "custom",
            path: ["keys"],
            message: "Shortcut keys must not contain duplicates",
          });
        }
        if (keys.includes("caps-lock")) {
          context.addIssue({
            code: "custom",
            path: ["keys"],
            message: "Caps Lock cannot be part of a shortcut",
          });
        }
      }),
      outputSchema: withCaptureAfter(keyboardStateSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) =>
      interactionToolResult(
        native,
        "keyboard.shortcut",
        input,
        keyboardStateSchema,
      ),
  );
}
