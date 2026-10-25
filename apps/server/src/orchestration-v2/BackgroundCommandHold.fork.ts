import type { ThreadId } from "@t3tools/contracts";
import {
  backgroundCommandsToHold,
  collectBackgroundWork,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { CLAUDE_PROVIDER } from "./Adapters/ClaudeAdapterV2.ts";
import type * as ThreadManagement from "./ThreadManagementService.ts";

/**
 * How long a wait gives its command to register: Claude's roster update for a background Bash
 * trails the tool result (46 ms in the race this guards), so a batched wait can beat it. It is paid
 * in full only when nothing new comes, and stays far inside an MCP client's 60 s call timeout.
 */
export const BACKGROUND_COMMAND_REGISTRATION_WAIT = Duration.seconds(5);

/** What an agent reads when its wait finds nothing new to hold. */
export const NOTHING_TO_HOLD_MESSAGE =
  "Could not wait: this turn started no running background command that is not already waited for. A command started in the same message as this call may not have registered yet, so call wait_for_background_commands again. Commands from earlier turns, such as a dev server, are not waited for, and a command that already exited needs no wait.";

type ThreadReads = Pick<
  ThreadManagement.ThreadManagementService["Service"],
  "getThreadEventSequence" | "getThreadRecords" | "streamStoredEventsFrom"
>;

/**
 * Waits until the thread shows a background command a hold would add, so the
 * hold dispatched next takes it. Runs before the dispatch, never inside the
 * orchestrator's queue. Succeeds either way: the hold itself decides.
 */
export const awaitBackgroundCommandToHold = Effect.fn("awaitBackgroundCommandToHold")(function* (
  threads: ThreadReads,
  threadId: ThreadId,
  wait: Duration.Input = BACKGROUND_COMMAND_REGISTRATION_WAIT,
) {
  // Taken before the first read, so an update between the two still replays.
  const afterSequence = yield* threads.getThreadEventSequence(threadId);
  const addsCommand = threads
    .getThreadRecords(threadId, ["runs", "providerThreads", "turnItems"], {
      turnItemTypes: ["command_execution"],
      turnItemStatuses: ["pending", "running", "waiting"],
    })
    .pipe(
      Effect.map((projection) => {
        const { activeProviderThreadId } = projection.thread;
        // Claude names a background shell only in its roster. Its Bash item
        // is the tool call, running until the result lands, so counting it
        // would end the wait before the shell it started is listed.
        const rosterOnly = projection.providerThreads.some(
          (providerThread) =>
            providerThread.driver === CLAUDE_PROVIDER &&
            (activeProviderThreadId === null || providerThread.id === activeProviderThreadId),
        );
        return (
          backgroundCommandsToHold({
            tasks: collectBackgroundWork({
              providerThreads: projection.providerThreads,
              turnItems: rosterOnly ? [] : projection.turnItems,
              activeProviderThreadId,
              runs: projection.runs,
            }),
            runs: projection.runs,
            heldTaskIds: projection.thread.heldBackgroundTaskIds,
          }).added.length > 0
        );
      }),
    );
  if (yield* addsCommand) return;
  // Claude's commands arrive in the roster; Codex and Grok ones as items.
  yield* Stream.merge(
    threads.streamStoredEventsFrom({
      threadId,
      afterSequence,
      eventType: "provider-thread.updated",
    }),
    threads
      .streamStoredEventsFrom({ threadId, afterSequence, eventType: "turn-item.updated" })
      .pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "turn-item.updated" &&
            stored.event.payload.type === "command_execution",
        ),
      ),
  ).pipe(
    Stream.mapEffect(() => addsCommand),
    Stream.filter((added) => added),
    Stream.runHead,
    Effect.timeoutOption(wait),
    Effect.map(Option.flatten),
  );
});
