import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as SessionMcpService from "./SessionMcpService.ts";
import { OrchestrationToolkit } from "./tools.ts";

const handlers = {
  session_spawn: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* SessionMcpService.SessionMcpService;
      return yield* service.spawn(scope, input);
    }),
  session_models: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* SessionMcpService.SessionMcpService;
      return yield* service.models(scope, input);
    }),
  session_projects: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* SessionMcpService.SessionMcpService;
      return yield* service.projects(scope, input);
    }),
  session_list: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* SessionMcpService.SessionMcpService;
      return yield* service.list(scope, input);
    }),
  session_wake: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* SessionMcpService.SessionMcpService;
      return yield* service.wake(scope, input);
    }),
  session_settle: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* SessionMcpService.SessionMcpService;
      return yield* service.settle(scope, input);
    }),
  session_rename: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* SessionMcpService.SessionMcpService;
      return yield* service.rename(scope, input);
    }),
} satisfies Parameters<typeof OrchestrationToolkit.toLayer>[0];

export const OrchestrationToolkitHandlersLive = OrchestrationToolkit.toLayer(handlers);
