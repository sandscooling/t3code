import {
  CommandId,
  MessageId,
  OrchestrationToolError,
  ThreadId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationToolkit } from "./tools.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const toolError = (reason: OrchestrationToolError["reason"], detail?: string) =>
  new OrchestrationToolError({ reason, ...(detail === undefined ? {} : { detail }) });

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Resolves who is calling and which sessions they can see: every open thread
 * in the caller's own project. A tool never reaches across projects, and
 * archived threads are invisible to it, so a name freed by archiving can be
 * reused.
 */
const requireScope = Effect.gen(function* () {
  const invocation = yield* McpInvocationContext.requireMcpCapability("orchestration").pipe(
    Effect.mapError((error) => toolError("capability-unavailable", error.message)),
  );
  const query = yield* ProjectionSnapshotQuery;
  const caller = yield* query
    .getThreadShellById(invocation.threadId)
    .pipe(Effect.mapError((error) => toolError("thread-not-found", describe(error))));
  if (Option.isNone(caller)) {
    return yield* toolError("thread-not-found", "the calling session has no thread");
  }
  const snapshot = yield* query
    .getShellSnapshot()
    .pipe(Effect.mapError((error) => toolError("dispatch-failed", describe(error))));
  const siblings = snapshot.threads.filter(
    (thread) => thread.projectId === caller.value.projectId && thread.archivedAt == null,
  );
  return { caller: caller.value, siblings };
});

const serverCommandId = (tag: string) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    return CommandId.make(`server:orchestration-${tag}:${uuid}`);
  });

const randomId = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  return yield* crypto.randomUUIDv4.pipe(Effect.orDie);
});

/**
 * Starts a turn on an existing thread. This is what makes a session real: a
 * thread with no turn has no provider process, and a stopped one gets a fresh
 * process here. No titleSeed on purpose, so the title is never auto-replaced
 * and the peer name derived from it stays put.
 */
const startTurn = (thread: OrchestrationThreadShell, text: string) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const commandId = yield* serverCommandId("turn-start");
    const messageId = MessageId.make(yield* randomId);
    const createdAt = yield* nowIso;
    yield* engine
      .dispatch({
        type: "thread.turn.start",
        commandId,
        threadId: thread.id,
        message: { messageId, role: "user", text, attachments: [] },
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt,
      })
      .pipe(Effect.mapError((error) => toolError("dispatch-failed", describe(error))));
  });

const requireMessage = (message: string) =>
  message.trim().length === 0
    ? toolError("invalid-name", "message must not be empty")
    : Effect.void;

const handlers = {
  session_spawn: (input) =>
    Effect.gen(function* () {
      yield* requireMessage(input.message);
      const { caller, siblings } = yield* requireScope;
      if (siblings.some((thread) => thread.title === input.name)) {
        return yield* toolError(
          "already-exists",
          `an open session named ${input.name} already exists; use session_wake`,
        );
      }
      const engine = yield* OrchestrationEngineService;

      // The caller stays out of the group on purpose: one orchestrator drives
      // many tickets, and groups are the tickets, not the driver.
      const threadId = ThreadId.make(yield* randomId);
      const createdAt = yield* nowIso;
      yield* engine
        .dispatch({
          type: "thread.create",
          commandId: yield* serverCommandId("thread-create"),
          threadId,
          projectId: caller.projectId,
          title: input.name,
          modelSelection: caller.modelSelection,
          runtimeMode: caller.runtimeMode,
          interactionMode: caller.interactionMode,
          branch: null,
          worktreePath: null,
          group: input.group,
          createdAt,
        })
        .pipe(Effect.mapError((error) => toolError("dispatch-failed", describe(error))));

      const created: OrchestrationThreadShell = {
        ...caller,
        id: threadId,
        title: input.name,
        group: input.group,
      };
      yield* startTurn(created, input.message).pipe(
        // A thread that never got its first turn is a draft nobody asked for.
        // Delete it so a retry can reuse the name, mirroring the bootstrap
        // cleanup the WebSocket path does.
        Effect.tapError(() =>
          Effect.uninterruptible(
            Effect.gen(function* () {
              const commandId = yield* serverCommandId("thread-delete");
              yield* engine.dispatch({ type: "thread.delete", commandId, threadId });
            }),
          ).pipe(Effect.ignoreCause({ log: true })),
        ),
      );

      return { threadId, name: input.name, group: input.group };
    }),

  session_list: (input) =>
    Effect.gen(function* () {
      const { caller, siblings } = yield* requireScope;
      const group = input?.group;
      const sessions = siblings
        .filter((thread) => group === undefined || thread.group === group)
        .map((thread) => ({
          threadId: thread.id,
          name: thread.title,
          group: thread.group ?? null,
          status: thread.session?.status ?? ("stopped" as const),
          // Marks the caller's own row, which is the only way a session learns
          // its own threadId and can therefore hand another session a reply
          // address. session_wake starts a turn and returns; it carries no answer back.
          self: thread.id === caller.id,
        }));
      return { sessions };
    }),

  session_wake: (input) =>
    Effect.gen(function* () {
      yield* requireMessage(input.message);
      const { siblings } = yield* requireScope;
      // A threadId from session_list is accepted in place of a name. It is
      // unique, so an id hit wins outright and is never ambiguous, and it is
      // the only handle on a session whose prose title could never pass the
      // session name pattern.
      const byId = siblings.find((thread) => thread.id === input.name);
      const matches = byId ? [byId] : siblings.filter((thread) => thread.title === input.name);
      if (matches.length === 0) {
        return yield* toolError(
          "thread-not-found",
          `no open session has the name or threadId ${input.name}`,
        );
      }
      const target = matches[0];
      if (matches.length > 1 || target === undefined) {
        return yield* toolError(
          "ambiguous-name",
          `${matches.length} open sessions are named ${input.name}; rename all but one`,
        );
      }
      yield* startTurn(target, input.message);
      return { threadId: target.id, name: target.title };
    }),
} satisfies Parameters<typeof OrchestrationToolkit.toLayer>[0];

export const OrchestrationToolkitHandlersLive = OrchestrationToolkit.toLayer(handlers);
