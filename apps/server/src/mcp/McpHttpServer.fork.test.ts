// Fork tests for McpHttpServer.test.ts.
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  PREVIEW_AUTOMATION_MAX_TIMEOUT_MS,
  PREVIEW_AUTOMATION_SERVER_OPERATIONS,
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
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import {
  PREVIEW_BROKER_GRACE_MS,
  PREVIEW_HOST_TIMED_OPERATIONS,
} from "./toolkits/preview/handlers.ts";

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
const TestLayer = McpHttpServer.layerPreviewToolkit.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
  Layer.provideMerge(PreviewAutomationBroker.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-http-server-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("preview waits end at the host before the broker, inside the 60 s tool-call limit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const routed: PreviewAutomationRequest[] = [];
      const events = yield* broker.connect({
        clientId: "mcp-timeout-client",
        environmentId,
        supportedOperations: [...PREVIEW_AUTOMATION_SERVER_OPERATIONS],
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

      const callTool = (name: string, args: Record<string, unknown>) => {
        routed.length = 0;
        // Only the routed request matters here, not whether the stub result decodes.
        return server.callTool({ name, arguments: args }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.map(() => routed[0]),
        );
      };
      // Every tool whose host waits on timeoutMs, with the smallest valid input.
      const timedTools = {
        preview_navigate: { operation: "navigate", args: { url: "localhost:5173" } },
        preview_resize: { operation: "resize", args: { mode: "fill" } },
        preview_click: { operation: "click", args: { x: 1, y: 1 } },
        preview_type: { operation: "type", args: { text: "Hi" } },
        preview_hover: { operation: "hover", args: { x: 1, y: 1 } },
        preview_select: { operation: "select", args: { locator: "#size", values: ["L"] } },
        preview_drag: { operation: "drag", args: { source: "#card", target: "#lane" } },
        preview_upload: { operation: "upload", args: { paths: ["/tmp/a.csv"] } },
        preview_wait_for: { operation: "waitFor", args: { text: "Example" } },
      } as const;
      // The test covers exactly the operations the handler treats as host-timed.
      expect(new Set(Object.values(timedTools).map((tool) => tool.operation))).toEqual(
        PREVIEW_HOST_TIMED_OPERATIONS,
      );
      const cases = [
        // Above the cap: the host gets 45 s, the broker 2 s more.
        { timeoutMs: 60_000, host: PREVIEW_AUTOMATION_MAX_TIMEOUT_MS },
        { timeoutMs: 5_000, host: 5_000 },
        // Absent: the documented default is sent, or both sides would wait 15 s.
        { timeoutMs: undefined, host: 15_000 },
      ];
      for (const [name, tool] of Object.entries(timedTools)) {
        for (const { timeoutMs, host } of cases) {
          const request = yield* callTool(name, {
            ...tool.args,
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
          });
          // The host waits on the input's timeoutMs; the broker on the request's.
          expect(request, `${name} ${timeoutMs}`).toMatchObject({
            operation: tool.operation,
            timeoutMs: host + PREVIEW_BROKER_GRACE_MS,
            input: { timeoutMs: host },
          });
          // Every call still ends inside the MCP client's 60 s limit.
          expect(request!.timeoutMs).toBeLessThan(60_000);
        }
      }

      // A tool with no host wait keeps the broker's own default and gets no timeoutMs.
      const press = yield* callTool("preview_press", { key: "Enter" });
      expect(press).toMatchObject({ operation: "press", timeoutMs: 15_000 });
      expect(press!.input).not.toHaveProperty("timeoutMs");
    }),
  ).pipe(Effect.provide(TestLayer)),
);
