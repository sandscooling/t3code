import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as SessionMcpService from "./SessionMcpService.ts";
import { OrchestrationToolkit } from "./tools.ts";

/**
 * The session tools act as the calling T3 thread, so only an agent inside one
 * may call them: reads need its thread, changes need its live run.
 */
export const OrchestrationToolkitHandlersLive = McpToolAccess.toLayer(OrchestrationToolkit, {
  session_spawn: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* SessionMcpService.SessionMcpService;
      return yield* service.spawn(scope, input);
    }),
  ),
  session_models: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* SessionMcpService.SessionMcpService;
      return yield* service.models(scope, input);
    }),
  ),
  session_projects: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* SessionMcpService.SessionMcpService;
      return yield* service.projects(scope, input);
    }),
  ),
  session_list: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* SessionMcpService.SessionMcpService;
      return yield* service.list(scope, input);
    }),
  ),
  session_wake: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* SessionMcpService.SessionMcpService;
      return yield* service.wake(scope, input);
    }),
  ),
  session_settle: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* SessionMcpService.SessionMcpService;
      return yield* service.settle(scope, input);
    }),
  ),
  session_rename: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* SessionMcpService.SessionMcpService;
      return yield* service.rename(scope, input);
    }),
  ),
  session_release: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* SessionMcpService.SessionMcpService;
      return yield* service.release(scope, input);
    }),
  ),
  session_idle_handoff: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* SessionMcpService.SessionMcpService;
      return yield* service.idleHandoff(scope, input);
    }),
  ),
});
