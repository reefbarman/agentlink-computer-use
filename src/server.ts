import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NativeBridge } from "./native/client.js";
import { OperationCoordinator } from "./semantic/operation-coordinator.js";
import {
  createCandidateVisionSelectorFromEnvironment,
  type CandidateVisionSelector,
} from "./semantic/lm-studio-candidate-selector.js";
import { registerCaptureTools } from "./tools/capture.js";
import { registerDiscoveryTools } from "./tools/discovery.js";
import { registerInputBatchTool } from "./tools/input-batch.js";
import { registerKeyboardTools } from "./tools/keyboard.js";
import { registerMouseTools } from "./tools/mouse.js";
import { registerUiActTool } from "./tools/ui-act.js";
import { registerUiFillTool } from "./tools/ui-fill.js";
import { registerUiQueryTool } from "./tools/ui-query.js";
import { registerUiWaitTool } from "./tools/ui-wait.js";
import { registerUiWorkflowTool } from "./tools/ui-workflow.js";
import { z } from "zod";

const permissionStatusSchema = z.object({
  accessibility: z.boolean(),
  "post-event": z.boolean(),
  "screen-capture": z.boolean(),
});

const computerStatusSchema = z.object({
  control: z.object({
    inputEnabled: z.boolean(),
    indicatorAvailable: z.boolean(),
    state: z.enum(["idle", "capture", "control", "paused"]),
  }),
  permissions: permissionStatusSchema,
  process: z.object({
    pid: z.number(),
  }),
  system: z.object({
    operatingSystemVersion: z.string(),
    architecture: z.string(),
  }),
});

export type ComputerStatus = z.infer<typeof computerStatusSchema>;

export function createServer(
  native: NativeBridge,
  candidateVisionSelector:
    | CandidateVisionSelector
    | undefined = createCandidateVisionSelectorFromEnvironment(),
): McpServer {
  const coordinatedNative = new OperationCoordinator(native);
  const server = new McpServer({
    name: "computer-use",
    version: "0.1.0",
  });

  server.registerTool(
    "computer_status",
    {
      title: "Computer status",
      description:
        "Report native-helper health, input and activity-indicator control state, operating system details, and non-prompting macOS permission preflights.",
      outputSchema: computerStatusSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const status = computerStatusSchema.parse(
        await coordinatedNative.request<unknown>("health"),
      );
      return {
        structuredContent: status,
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
      };
    },
  );

  registerDiscoveryTools(server, coordinatedNative);
  registerUiQueryTool(server, coordinatedNative);
  registerUiWaitTool(server, coordinatedNative);
  registerUiActTool(server, coordinatedNative, candidateVisionSelector);
  registerUiFillTool(server, coordinatedNative);
  registerUiWorkflowTool(server, coordinatedNative);
  registerCaptureTools(server, coordinatedNative);
  registerKeyboardTools(server, coordinatedNative);
  registerMouseTools(server, coordinatedNative);
  registerInputBatchTool(server, coordinatedNative);

  return server;
}
