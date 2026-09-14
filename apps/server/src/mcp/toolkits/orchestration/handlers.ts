import {
  ALL_PROJECTS,
  CommandId,
  isProviderAvailable,
  MessageId,
  OrchestrationToolError,
  ThreadId,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ProviderOptionDescriptor,
  type ServerProvider,
  type SessionModelOption,
  type SessionSpawnInput,
} from "@t3tools/contracts";
import {
  createModelSelection,
  getProviderOptionCurrentValue,
  resolveSelectableModel,
} from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { isOrchestrationThreadSettleBlocked } from "../../../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationToolkit } from "./tools.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const toolError = (reason: OrchestrationToolError["reason"], detail?: string) =>
  new OrchestrationToolError({ reason, ...(detail === undefined ? {} : { detail }) });

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Resolves who is calling and what the tools can reach: every project on this
 * server and every open thread in them, so one orchestrator can drive work
 * across projects. Archived threads are invisible, so a name freed by
 * archiving can be reused.
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
  const threads = snapshot.threads.filter((thread) => thread.archivedAt == null);
  return { caller: caller.value, threads, projects: snapshot.projects };
});

/** Finds a project by the projectId, name, or path session_projects reports. */
const resolveProject = (
  projects: ReadonlyArray<OrchestrationProjectShell>,
  ref: string,
): Effect.Effect<OrchestrationProjectShell, OrchestrationToolError> =>
  Effect.gen(function* () {
    const byId = projects.find((project) => project.id === ref);
    const matches = byId
      ? [byId]
      : projects.filter((project) => project.title === ref || project.workspaceRoot === ref);
    const target = matches[0];
    if (target === undefined) {
      return yield* toolError(
        "project-not-found",
        `no project is named ${ref}; session_projects lists ${projects.map((project) => project.title).join(", ")}`,
      );
    }
    if (matches.length > 1) {
      return yield* toolError(
        "ambiguous-name",
        `${matches.length} projects are named ${ref}; pass the projectId from session_projects`,
      );
    }
    return target;
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

/**
 * Finds the one open session a tool was pointed at. A threadId from
 * session_list reaches any project. It is unique, so an id hit wins outright
 * and is never ambiguous, and it is the only handle on a session whose prose
 * title could never pass the session name pattern. A name only resolves in
 * the caller's own project: names are unique per project, so the same name in
 * another project must never be the one a bare name picks.
 */
const resolveSession = (
  threads: ReadonlyArray<OrchestrationThreadShell>,
  caller: OrchestrationThreadShell,
  name: string,
): Effect.Effect<OrchestrationThreadShell, OrchestrationToolError> =>
  Effect.gen(function* () {
    const byId = threads.find((thread) => thread.id === name);
    const matches = byId
      ? [byId]
      : threads.filter((thread) => thread.projectId === caller.projectId && thread.title === name);
    if (matches.length === 0) {
      return yield* toolError(
        "thread-not-found",
        `no open session has the threadId ${name}, and none in your project has that name`,
      );
    }
    const target = matches[0];
    if (matches.length > 1 || target === undefined) {
      return yield* toolError(
        "ambiguous-name",
        `${matches.length} open sessions are named ${name}; rename all but one`,
      );
    }
    return target;
  });

const requireMessage = (message: string) =>
  message.trim().length === 0
    ? toolError("invalid-name", "message must not be empty")
    : Effect.void;

/** Providers a spawned session can actually start on, the same bar the model picker uses. */
const usableProviders = Effect.gen(function* () {
  const registry = yield* ProviderRegistry;
  const providers = yield* registry.getProviders;
  return providers.filter(
    (provider) => provider.enabled && provider.installed && isProviderAvailable(provider),
  );
});

const describeOption = (descriptor: ProviderOptionDescriptor): SessionModelOption => {
  const fallback = getProviderOptionCurrentValue(descriptor);
  return {
    id: descriptor.id,
    label: descriptor.label,
    type: descriptor.type,
    ...(descriptor.type === "select"
      ? { choices: descriptor.options.map((choice) => choice.id) }
      : {}),
    ...(fallback === undefined ? {} : { default: fallback }),
  };
};

const modelOptionDescriptors = (model: ServerProvider["models"][number]) =>
  model.capabilities?.optionDescriptors ?? [];

/**
 * Turns spawn's optional provider, model, and options into the selection the
 * new thread runs on. Nothing asked for means an exact copy of the caller's.
 * Everything asked for is checked against the provider registry here, because
 * a bad slug would otherwise only fail inside the provider after the thread
 * exists, leaving the orchestrator a broken session and no reason why.
 */
const resolveSpawnModel = (inherited: ModelSelection, input: SessionSpawnInput) =>
  Effect.gen(function* () {
    if (
      input.instanceId === undefined &&
      input.model === undefined &&
      input.options === undefined
    ) {
      return inherited;
    }
    const providers = yield* usableProviders;
    const instanceId = input.instanceId ?? inherited.instanceId;
    const provider = providers.find((candidate) => candidate.instanceId === instanceId);
    if (provider === undefined) {
      return yield* toolError(
        "invalid-model",
        `no usable provider ${instanceId}; session_models lists ${providers.map((candidate) => candidate.instanceId).join(", ")}`,
      );
    }

    const sameProvider = provider.instanceId === inherited.instanceId;
    const requested =
      input.model ??
      (sameProvider
        ? inherited.model
        : (provider.models.find((model) => model.isDefault) ?? provider.models[0])?.slug);
    const slug =
      requested === undefined
        ? null
        : resolveSelectableModel(provider.driver, requested, provider.models);
    const model = provider.models.find((candidate) => candidate.slug === slug);
    if (model === undefined) {
      return yield* toolError(
        "invalid-model",
        `${provider.instanceId} has no model ${requested ?? "(none listed)"}; call session_models with instanceId ${provider.instanceId} for its slugs`,
      );
    }

    if (input.options === undefined) {
      // The caller's options only mean something on the caller's own model.
      const keepOptions = sameProvider && model.slug === inherited.model;
      return createModelSelection(
        provider.instanceId,
        model.slug,
        keepOptions ? inherited.options : undefined,
      );
    }
    const descriptors = modelOptionDescriptors(model);
    for (const option of input.options) {
      const descriptor = descriptors.find((candidate) => candidate.id === option.id);
      const valid =
        descriptor?.type === "select"
          ? descriptor.options.some((choice) => choice.id === option.value)
          : descriptor?.type === "boolean" && typeof option.value === "boolean";
      if (!valid) {
        return yield* toolError(
          "invalid-model",
          `${model.slug} does not accept ${option.id}=${String(option.value)}; it takes ${
            descriptors
              .map((candidate) =>
                candidate.type === "select"
                  ? `${candidate.id}=${candidate.options.map((choice) => choice.id).join("|")}`
                  : `${candidate.id}=true|false`,
              )
              .join(", ") || "no options"
          }`,
        );
      }
    }
    return createModelSelection(provider.instanceId, model.slug, input.options);
  });

const handlers = {
  session_spawn: (input) =>
    Effect.gen(function* () {
      yield* requireMessage(input.message);
      const { caller, threads, projects } = yield* requireScope;
      const projectId =
        input.project === undefined
          ? caller.projectId
          : (yield* resolveProject(projects, input.project)).id;
      const clash = threads.find(
        (thread) => thread.projectId === projectId && thread.title === input.name,
      );
      if (clash !== undefined) {
        // A settled session keeps its name, so say which kind of session is
        // holding it: session_list no longer shows the settled one, and
        // "already exists" about an invisible session reads as a bug.
        return yield* toolError(
          "already-exists",
          clash.settledOverride === "settled"
            ? `a settled session named ${input.name} still holds that name; session_wake reopens it, or archive it to free the name`
            : `an open session named ${input.name} already exists; use session_wake`,
        );
      }
      const modelSelection = yield* resolveSpawnModel(caller.modelSelection, input);
      const engine = yield* OrchestrationEngineService;

      // The caller stays out of the group on purpose: one orchestrator drives
      // many tickets, and groups are the tickets, not the driver. It is the
      // parent instead, so settling it settles what it started. A handoff
      // makes the new session the caller's sibling, since settling the old
      // orchestrator must not take its successor with it.
      const handoff = input.handoff === true;
      const parentThreadId = handoff ? (caller.parentThreadId ?? null) : caller.id;
      const threadId = ThreadId.make(yield* randomId);
      const createdAt = yield* nowIso;
      yield* engine
        .dispatch({
          type: "thread.create",
          commandId: yield* serverCommandId("thread-create"),
          threadId,
          projectId,
          title: input.name,
          modelSelection,
          runtimeMode: caller.runtimeMode,
          interactionMode: caller.interactionMode,
          branch: null,
          worktreePath: null,
          group: input.group,
          parentThreadId,
          createdAt,
        })
        .pipe(Effect.mapError((error) => toolError("dispatch-failed", describe(error))));

      const created: OrchestrationThreadShell = {
        ...caller,
        id: threadId,
        projectId,
        title: input.name,
        modelSelection,
        group: input.group,
        parentThreadId,
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

      // Only after the successor is running: a failed start deletes it, and a
      // roster moved onto a deleted thread would settle with nothing.
      const adopted = handoff
        ? threads.filter((thread) => thread.parentThreadId === caller.id)
        : [];
      for (const child of adopted) {
        yield* engine
          .dispatch({
            type: "thread.meta.update",
            commandId: yield* serverCommandId("thread-adopt"),
            threadId: child.id,
            parentThreadId: threadId,
          })
          .pipe(Effect.mapError((error) => toolError("dispatch-failed", describe(error))));
      }

      return {
        threadId,
        name: input.name,
        group: input.group,
        projectId,
        instanceId: modelSelection.instanceId,
        model: modelSelection.model,
        options: modelSelection.options ?? [],
        adopted: adopted.map((child) => child.title),
      };
    }),

  session_models: (input) =>
    Effect.gen(function* () {
      const { caller } = yield* requireScope;
      const providers = yield* usableProviders;
      return {
        providers: providers
          .filter(
            (provider) =>
              input?.instanceId === undefined || provider.instanceId === input.instanceId,
          )
          .map((provider) => ({
            instanceId: provider.instanceId,
            driver: provider.driver,
            displayName: provider.displayName ?? provider.instanceId,
            status: provider.status,
            current: provider.instanceId === caller.modelSelection.instanceId,
            models: provider.models.map((model) => ({
              slug: model.slug,
              name: model.name,
              isDefault: model.isDefault === true,
              options: modelOptionDescriptors(model).map(describeOption),
            })),
          })),
      };
    }),

  session_projects: (input) =>
    Effect.gen(function* () {
      const { caller, projects } = yield* requireScope;
      const match = input?.match?.toLowerCase();
      return {
        projects: projects
          .filter(
            (project) =>
              match === undefined ||
              project.title.toLowerCase().includes(match) ||
              project.workspaceRoot.toLowerCase().includes(match),
          )
          .map((project) => ({
            projectId: project.id,
            name: project.title,
            path: project.workspaceRoot,
            current: project.id === caller.projectId,
          })),
      };
    }),

  session_list: (input) =>
    Effect.gen(function* () {
      const { caller, threads, projects } = yield* requireScope;
      const group = input?.group;
      const scope = input?.project;
      // Own project by default: an orchestrator polling its group should not
      // pay for every other project's roster unless it asks for one.
      const projectId =
        scope === undefined
          ? caller.projectId
          : scope === ALL_PROJECTS
            ? null
            : (yield* resolveProject(projects, scope)).id;
      const projectNames = new Map(projects.map((project) => [project.id, project.title]));
      const sessions = threads
        .filter((thread) => projectId === null || thread.projectId === projectId)
        // A settled session is finished work, out of the user's inbox, and
        // listing it beside the open ones reads as "still running": an
        // orchestrator polling its group settles the same sessions again on
        // every pass. The caller's own row stays regardless, since it is the
        // only place a session reads its own threadId.
        .filter((thread) => thread.id === caller.id || thread.settledOverride !== "settled")
        .filter((thread) => group === undefined || thread.group === group)
        .map((thread) => ({
          threadId: thread.id,
          name: thread.title,
          group: thread.group ?? null,
          projectId: thread.projectId,
          project: projectNames.get(thread.projectId) ?? thread.projectId,
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
      const { caller, threads } = yield* requireScope;
      const target = yield* resolveSession(threads, caller, input.name);
      yield* startTurn(target, input.message);
      return { threadId: target.id, name: target.title };
    }),

  session_settle: (input) =>
    Effect.gen(function* () {
      const { caller, threads } = yield* requireScope;
      const target = yield* resolveSession(threads, caller, input.name);
      // The decider refuses to settle a running thread, and the caller is
      // running by definition while its tool call is in flight. Saying so here
      // beats a dispatch round trip that can only ever be refused.
      if (target.id === caller.id) {
        return yield* toolError(
          "settle-blocked",
          "a session cannot settle itself while its own turn is running; ask the user, or have the session that spawned it settle it",
        );
      }
      const engine = yield* OrchestrationEngineService;
      const commandId = yield* serverCommandId("thread-settle");
      yield* engine.dispatch({ type: "thread.settle", commandId, threadId: target.id }).pipe(
        Effect.mapError((error) =>
          // The server owns settle eligibility, so its refusal is a distinct
          // answer: the session still needs attention, and a retry after it
          // stops or is answered will work.
          isOrchestrationThreadSettleBlocked(error)
            ? toolError(
                "settle-blocked",
                `session ${target.title} is still running, waiting on the user, or holding a queued turn`,
              )
            : toolError("dispatch-failed", describe(error)),
        ),
      );
      return { threadId: target.id, name: target.title };
    }),
} satisfies Parameters<typeof OrchestrationToolkit.toLayer>[0];

export const OrchestrationToolkitHandlersLive = OrchestrationToolkit.toLayer(handlers);
