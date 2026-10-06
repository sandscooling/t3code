// Fork tests for McpHttpServer.test.ts.
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  PREVIEW_AUTOMATION_MAX_TIMEOUT_MS,
  PREVIEW_AUTOMATION_V1_OPERATIONS,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationRequest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../config.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const environmentId = EnvironmentId.make("environment-mcp-test");
const threadId = ThreadId.make("thread-mcp-test");
const tabId = PreviewTabId.make("tab-mcp-test");
const invocation = {
  environmentId,
  requestNamespace: "provider-session-mcp-test",
  thread: {
    threadId,
    providerSessionId: "provider-session-mcp-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});
const TestLayer = McpHttpServer.PreviewToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(PreviewAutomationBroker.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-http-server-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("caps preview waits below the MCP client's 60 s tool-call limit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const routed: PreviewAutomationRequest[] = [];
      const events = yield* broker.connect({
        clientId: "mcp-timeout-client",
        environmentId,
        supportedOperations: [...PREVIEW_AUTOMATION_V1_OPERATIONS, "resize"],
      });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Effect.void;
        routed.push(event.request);
        return broker.respond({
          clientId: "mcp-timeout-client",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result: { available: true, tabId },
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const calls = [
        { name: "preview_wait_for", arguments: { text: "Example", timeoutMs: 60_000 } },
        { name: "preview_navigate", arguments: { url: "localhost:5173", timeoutMs: 60_000 } },
        { name: "preview_resize", arguments: { mode: "fill", timeoutMs: 60_000 } },
        { name: "preview_click", arguments: { x: 1, y: 1, timeoutMs: 60_000 } },
        { name: "preview_type", arguments: { text: "Hi", timeoutMs: 60_000 } },
        { name: "preview_wait_for", arguments: { text: "Example", timeoutMs: 5_000 } },
      ];
      for (const call of calls) {
        routed.length = 0;
        // Only the routed request matters here, not whether the stub result decodes.
        yield* server
          .callTool(call)
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        const expected = Math.min(call.arguments.timeoutMs, PREVIEW_AUTOMATION_MAX_TIMEOUT_MS);
        // The desktop waits on the input's timeoutMs; the broker on the request's.
        expect(routed[0]).toMatchObject({ timeoutMs: expected, input: { timeoutMs: expected } });
      }
    }),
  ).pipe(Effect.provide(TestLayer)),
);
