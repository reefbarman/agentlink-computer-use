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
import {
  initialLmStudioStatus,
  lmStudioStatusSchema,
  type LmStudioStatus,
} from "./semantic/lm-studio-status.js";

const permissionStatusSchema = z.object({
  accessibility: z.boolean(),
  "post-event": z.boolean(),
  "screen-capture": z.boolean(),
});

const nativeComputerStatusSchema = z.object({
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

const computerStatusSchema = nativeComputerStatusSchema.extend({
  lmStudio: lmStudioStatusSchema,
});

export type ComputerStatus = z.infer<typeof computerStatusSchema>;

export function createServer(
  native: NativeBridge,
  candidateVisionSelector:
    | CandidateVisionSelector
    | null
    | undefined = createCandidateVisionSelectorFromEnvironment(),
): McpServer {
  const coordinatedNative = new OperationCoordinator(native);
  const server = new McpServer({
    name: "computer-use",
    version: "0.1.0",
  });

  const selector = candidateVisionSelector ?? undefined;
  let closed = false;
  const readLmStudioStatus = async (): Promise<LmStudioStatus> => {
    if (selector?.checkReadiness) return selector.checkReadiness();
    return selector?.status ?? initialLmStudioStatus(selector === undefined);
  };
  const publishLmStudioStatus = async (
    status: LmStudioStatus,
  ): Promise<void> => {
    if (closed || !native.updateLmStudioStatus) return;
    try {
      await native.updateLmStudioStatus(status);
    } catch {
      console.error(
        "Could not update LM Studio status in the Computer Use menu",
      );
    }
  };
  let latestPublication = Promise.resolve();
  const unsubscribe = selector?.subscribeStatus?.((status) => {
    latestPublication = publishLmStudioStatus(status);
  });
  const publishCheckedStatus = (status: LmStudioStatus): Promise<void> =>
    unsubscribe === undefined
      ? publishLmStudioStatus(status)
      : latestPublication;
  const timer = setInterval(() => {
    if (closed || native.isRunning !== true) return;
    void readLmStudioStatus()
      .then(publishCheckedStatus)
      .catch(() => {
        console.error("Could not refresh LM Studio readiness");
      });
  }, 10_000);
  timer.unref();
  const previousOnClose = server.server.onclose;
  server.server.onclose = () => {
    closed = true;
    clearInterval(timer);
    unsubscribe?.();
    previousOnClose?.();
  };

  server.registerTool(
    "computer_status",
    {
      title: "Computer status",
      description:
        "Report native-helper health, input and activity-indicator control state, operating system details, non-prompting macOS permission preflights, and LM Studio loaded-model readiness plus last successful use and last failure. Readiness checks never load models or run inference.",
      outputSchema: computerStatusSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const nativeStatus = nativeComputerStatusSchema.parse(
        await coordinatedNative.request<unknown>("health"),
      );
      const lmStudio = await readLmStudioStatus();
      await publishCheckedStatus(lmStudio);
      const status = computerStatusSchema.parse({ ...nativeStatus, lmStudio });
      return {
        structuredContent: status,
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
      };
    },
  );

  registerDiscoveryTools(server, coordinatedNative);
  registerUiQueryTool(server, coordinatedNative);
  registerUiWaitTool(server, coordinatedNative);
  registerUiActTool(server, coordinatedNative, selector);
  registerUiFillTool(server, coordinatedNative);
  registerUiWorkflowTool(server, coordinatedNative);
  registerCaptureTools(server, coordinatedNative);
  registerKeyboardTools(server, coordinatedNative);
  registerMouseTools(server, coordinatedNative);
  registerInputBatchTool(server, coordinatedNative);

  return server;
}
