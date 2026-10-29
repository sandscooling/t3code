/**
 * Fork-owned: when a run holding a session_wake message (one it started, queued, or was steered)
 * ends failed, or is held behind a run that failed, the waking session gets one notice instead of
 * waiting on a reply that never comes. A Stop or a restart sends none.
 */
import {
  CommandId,
  MessageId,
  ThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import {
  latestExecutedRun,
  latestRootProviderFailure,
} from "@t3tools/shared/orchestrationV2ThreadError";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const WAKE_MESSAGE_PREFIX = "session-wake:";

/** The message id session_wake sends with, which marks a run's message as a wake. */
export const sessionWakeMessageId = (commandId: CommandId) =>
  MessageId.make(`${WAKE_MESSAGE_PREFIX}${commandId}`);

/** Handoffs a sender's successor link is followed through, a bound against a cycle. */
const MAX_SUCCESSOR_HOPS = 8;
const MAX_SUMMARY_LENGTH = 300;

export class SessionWakeFailureNotice extends Context.Service<
  SessionWakeFailureNotice,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/SessionWakeFailureNotice.fork/SessionWakeFailureNotice") {}

const summarize = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > MAX_SUMMARY_LENGTH ? `${line.slice(0, MAX_SUMMARY_LENGTH - 3)}...` : line;
};

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;

  /**
   * Where the sender lives now: a handed-off session's successor holds its
   * place. A settled, archived, or deleted one is finished work, and waking it
   * would reopen it for a run it no longer tracks, so it gets nothing.
   */
  const recipientFor = Effect.fn("SessionWakeFailureNotice.recipientFor")(function* (
    senderThreadId: ThreadId,
  ) {
    let shell = yield* threads.getThreadShell(senderThreadId);
    for (let hop = 0; hop < MAX_SUCCESSOR_HOPS && shell?.successorThreadId != null; hop += 1) {
      shell = yield* threads.getThreadShell(shell.successorThreadId);
    }
    if (
      shell === null ||
      shell.deletedAt !== null ||
      shell.archivedAt !== null ||
      shell.settledOverride === "settled"
    ) {
      return null;
    }
    return shell;
  });

  /** The senders of the session_wake messages in `messages`, the target itself excepted. */
  const wakeSenders = (
    messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
    targetThreadId: ThreadId,
  ) => {
    // A notice carries no sender, so a failure delivering one never sends another.
    const senders = new Set<ThreadId>();
    for (const message of messages) {
      if (
        message.id.startsWith(WAKE_MESSAGE_PREFIX) &&
        message.senderThreadId !== undefined &&
        message.senderThreadId !== targetThreadId
      ) {
        senders.add(message.senderThreadId);
      }
    }
    return senders;
  };

  const describeFailure = (failure: OrchestrationV2ProviderFailure | null) =>
    failure === null ? "the run failed without a provider error" : summarize(failure.message);

  const notifyFailed = Effect.fn("SessionWakeFailureNotice.notifyFailed")(function* (
    run: OrchestrationV2Run,
  ) {
    const records = yield* threads.getThreadRecords(run.threadId, ["messages", "turnItems"], {
      messageRunIds: [run.id],
      messageRoles: ["user"],
      turnItemRunIds: [run.id],
      turnItemTypes: ["error"],
    });
    const failure = latestRootProviderFailure(run, records.turnItems);
    const senders = wakeSenders(records.messages, run.threadId);
    if (senders.size > 0) {
      yield* deliver({
        key: `server:session-wake-failure:${run.id}`,
        run,
        senders,
        text: `T3 Code: your session_wake to ${records.thread.title} (${run.threadId}) failed: ${describeFailure(failure)}`,
      });
    }
    if (failure?.class === "usage_limit") {
      yield* notifyLimited(run, records.thread.title, failure);
    }
  });

  /**
   * A usage limit leaves the queue behind it waiting, neither held nor failed, so
   * its wakes hear of it here. A run an earlier Stop held is skipped: it will not
   * resume on its own.
   */
  const notifyLimited = Effect.fn("SessionWakeFailureNotice.notifyLimited")(function* (
    failed: OrchestrationV2Run,
    title: string,
    failure: OrchestrationV2ProviderFailure,
  ) {
    const { runs } = yield* threads.getThreadRecords(failed.threadId, ["runs"]);
    const queued = runs.filter((run) => run.status === "queued" && run.queueHeld !== true);
    const messageIds = queued.flatMap((run) =>
      run.userMessageId === null ? [] : [run.userMessageId],
    );
    if (messageIds.length === 0) return;
    const { messages } = yield* threads.getThreadRecords(failed.threadId, ["messages"], {
      messageIds,
    });
    const resetAt = failure.resetAt ?? null;
    const autoResume = yield* settings.getSettings.pipe(
      Effect.map((current) => current.autoResumeLimitedThreads),
      Effect.orElseSucceed(() => false),
    );
    const text = `T3 Code: your session_wake to ${title} (${failed.threadId}) is waiting behind a usage limit${
      resetAt === null ? "" : ` that resets at ${resetAt}`
    }, ${
      autoResume && resetAt !== null
        ? "and should resume on its own after the reset"
        : "until the user resumes it in the app"
    } (t3_queue action cancel drops it): ${describeFailure(failure)}`;
    for (const run of queued) {
      const senders = wakeSenders(
        messages.filter((message) => message.id === run.userMessageId),
        failed.threadId,
      );
      if (senders.size === 0) continue;
      yield* deliver({ key: `server:session-wake-limited:${run.id}`, run, senders, text });
    }
  });

  /**
   * After a provider failure the orchestrator holds the queued runs behind it
   * instead of failing them, so a queued wake never fails on its own. A Stop or
   * a restart holds the queue too, after a run that did not fail; those send nothing.
   */
  const notifyHeld = Effect.fn("SessionWakeFailureNotice.notifyHeld")(function* (
    run: OrchestrationV2Run,
  ) {
    if (run.userMessageId === null) return;
    const { runs } = yield* threads.getThreadRecords(run.threadId, ["runs"]);
    const ahead = latestExecutedRun(runs);
    if (ahead?.status !== "failed") return;
    const records = yield* threads.getThreadRecords(run.threadId, ["messages", "turnItems"], {
      messageIds: [run.userMessageId],
      turnItemRunIds: [ahead.id],
      turnItemTypes: ["error"],
    });
    // Behind a usage limit a hold is a Stop's, or the queue gate missed the limit (a session
    // error hid its class); notifyLimited speaks for the limit, so neither sends a held notice.
    const failure = latestRootProviderFailure(ahead, records.turnItems);
    if (failure?.class === "usage_limit") return;
    const senders = wakeSenders(records.messages, run.threadId);
    if (senders.size === 0) return;
    yield* deliver({
      key: `server:session-wake-held:${run.id}`,
      run,
      senders,
      text: `T3 Code: your session_wake to ${records.thread.title} (${run.threadId}) is held behind a run that failed, until the user resumes the queue in the app (t3_queue action cancel drops it): ${describeFailure(failure)}`,
    });
  });

  const deliver = Effect.fn("SessionWakeFailureNotice.deliver")(function* (input: {
    readonly key: string;
    readonly run: OrchestrationV2Run;
    readonly senders: ReadonlySet<ThreadId>;
    readonly text: string;
  }) {
    const { run, text } = input;
    for (const sender of input.senders) {
      // Keyed by the original sender, so a later run.updated or a handoff never repeats it.
      const commandId = CommandId.make(`${input.key}:${sender}`);
      if (yield* threads.hasReceipt(commandId)) continue;
      const recipient = yield* recipientFor(sender);
      if (recipient === null || recipient.id === run.threadId) continue;
      yield* threads
        .sendToThread({
          projectId: recipient.projectId,
          commandId,
          threadId: recipient.id,
          messageId: MessageId.make(commandId),
          text,
          attachments: [],
          // Never steers, as session_wake does not: a steer cuts off the sender's running turn.
          mode: "queue",
          createdBy: "system",
          creationSource: "server",
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not tell a session_wake sender its run failed", {
              runId: run.id,
              senderThreadId: sender,
              cause,
            }),
          ),
        );
    }
  });

  // Runs for every domain event; all but a failed or held run return at once.
  const handle: SessionWakeFailureNotice["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (event.type !== "run.updated") return;
      if (event.payload.status === "failed") {
        yield* notifyFailed(event.payload);
      } else if (event.payload.status === "queued" && event.payload.queueHeld === true) {
        yield* notifyHeld(event.payload);
      }
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Session wake failure notice failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const start: SessionWakeFailureNotice["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Session wake failure notice event stream failed", { cause }),
        ),
      ),
    );

  return SessionWakeFailureNotice.of({ start, handle });
});

export const layer = Layer.effect(SessionWakeFailureNotice, make);

/** The reactor, listening from server start. */
export const layerStarted = Layer.effectDiscard(
  Effect.gen(function* () {
    const notices = yield* SessionWakeFailureNotice;
    yield* notices.start();
  }),
).pipe(Layer.provide(layer));
