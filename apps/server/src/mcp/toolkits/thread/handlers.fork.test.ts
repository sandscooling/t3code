import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import { NOTHING_TO_HOLD_MESSAGE } from "../../../orchestration-v2/BackgroundCommandHold.fork.ts";
import { OrchestratorCommandRejectedError } from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";

const threadId = ThreadId.make("thread:wait-for-background-commands");
const shell = McpToolAccessTestkit.liveThreadShell(threadId);
const projection = McpToolAccessTestkit.idleThreadProjection(shell);
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:wait-for-background-commands"),
  requestNamespace: "wait-for-background-commands",
  thread: {
    threadId,
    providerSessionId: "wait-for-background-commands",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "wait-for-background-commands", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "wait-for-background-commands", version: "1" },
  },
  getClient: Effect.die("unused"),
});

it.effect("tells the agent what to do when its wait finds nothing to hold", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: "wait_for_background_commands", arguments: {} })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    const text = result.content[0];
    expect(result.isError).toBe(true);
    expect(text?.type === "text" ? JSON.parse(text.text) : undefined).toEqual({
      _tag: "OrchestratorMcpFailure",
      code: "invalid_request",
      message: NOTHING_TO_HOLD_MESSAGE,
    });
  }).pipe(
    Effect.provide(
      McpHttpServer.layerThreadToolkit.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
        Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () => Effect.succeed(shell),
            getProjectThreadRecords: () => Effect.succeed(projection),
            // No command ever registers: the stream ends without one.
            getThreadEventSequence: () => Effect.succeed(0),
            getThreadRecords: () => Effect.succeed(projection),
            streamStoredEventsFrom: () => Stream.empty,
            dispatch: (command) =>
              Effect.fail(
                new OrchestratorCommandRejectedError({
                  commandId: command.commandId,
                  commandType: command.type,
                  cause: "No background commands its latest run started.",
                }),
              ),
          }),
        ),
      ),
    ),
  ),
);
