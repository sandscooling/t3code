/**
 * Fork-owned: idle handoff for sessions. A session that opts in, through
 * session_idle_handoff or session_spawn's `idleHandoff`, and then sits idle
 * for `afterMinutes` after a turn that ended at `minTokens` of context or more,
 * gets one message asking it to hand off while its provider's prompt cache is
 * still warm. Otherwise the next turn, often hours later, re-reads the whole
 * context cold.
 *
 * Idle is the thread's own state only: no run in flight or queued, no question
 * or approval pending, no subagent or held background command running. Other
 * sessions it spawned are separate threads and do not count.
 *
 * The setting lives in a table this service creates itself rather than in a
 * migration, since a fork migration has to be renumbered above upstream's on
 * every sync. Idle time comes from persisted state (the last run's end), so a
 * restart neither loses a reminder nor repeats one: the message's command id
 * names the run it follows, and command receipts make a second send a no-op.
 */
import {
  CommandId,
  IDLE_HANDOFF_DEFAULT_AFTER_MINUTES,
  IDLE_HANDOFF_DEFAULT_MIN_TOKENS,
  MessageId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type SessionIdleHandoffSetting,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Scheduler from "../scheduling/Scheduler.ts";
import type * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export class IdleHandoffStoreError extends Schema.TaggedError<IdleHandoffStoreError>()(
  "IdleHandoffStoreError",
  {
    operation: Schema.Literals(["read", "write"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not ${this.operation} the idle handoff settings.`;
  }
}

export class SessionIdleHandoffService extends Context.Service<
  SessionIdleHandoffService,
  {
    /** Every thread's setting, by threadId. */
    readonly list: Effect.Effect<
      ReadonlyMap<string, SessionIdleHandoffSetting>,
      IdleHandoffStoreError
    >;
    readonly get: (
      threadId: ThreadId,
    ) => Effect.Effect<SessionIdleHandoffSetting | null, IdleHandoffStoreError>;
    /** Turns a thread's idle handoff on or changes it; null turns it off. */
    readonly set: (
      threadId: ThreadId,
      setting: SessionIdleHandoffSetting | null,
    ) => Effect.Effect<void, IdleHandoffStoreError>;
    /**
     * Epoch ms the reminder falls due if the thread stays idle, by the same
     * rules the worker fires on; null unless it is armed. Past due means the
     * worker sends it on its next look.
     */
    readonly dueAt: (
      threadId: ThreadId,
    ) => Effect.Effect<number | null, IdleHandoffStoreError | Orchestrator.OrchestratorV2Error>;
  }
>()("t3/orchestration-v2/SessionIdleHandoff.fork/SessionIdleHandoffService") {}

/**
 * A setting as a tool passed it: fields left out keep `current`, the setting
 * already in force, or take the defaults when there is none.
 */
export const withIdleHandoffDefaults = (
  options: {
    readonly afterMinutes?: number | undefined;
    readonly minTokens?: number | undefined;
  },
  current: SessionIdleHandoffSetting | null = null,
): SessionIdleHandoffSetting => ({
  afterMinutes: options.afterMinutes ?? current?.afterMinutes ?? IDLE_HANDOFF_DEFAULT_AFTER_MINUTES,
  minTokens: options.minTokens ?? current?.minTokens ?? IDLE_HANDOFF_DEFAULT_MIN_TOKENS,
});

/** How often one thread is looked at, at most; the scheduler ticks every 5 seconds. */
const CHECK_SPACING_MS = 30_000;

const ACTIVE_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

/**
 * The thread's own work in flight. A background command only counts when
 * someone waits for it (wait_for_background_commands); one left running on
 * purpose, like a dev server, does not.
 */
const isBusy = (shell: OrchestrationV2ThreadShell) =>
  shell.activeRunId !== null ||
  shell.activityRunStatus != null ||
  ACTIVE_STATUSES.has(shell.status) ||
  shell.pendingRuntimeRequest !== null ||
  (shell.pendingBackgroundTasks ?? []).some(
    (task) => task.kind === "subagent" || (task.kind === "command" && task.held === true),
  );

/** Context size at the root provider thread's newest usage report, as the context meter reads it. */
const lastContextTokens = (
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "providerTurns">,
) => {
  const root = projection.thread.activeProviderThreadId;
  let latest: { readonly usedTokens: number; readonly at: number } | null = null;
  for (const turn of projection.providerTurns) {
    if (turn.tokenUsage === undefined || (root !== null && turn.providerThreadId !== root)) {
      continue;
    }
    const at = Date.parse(turn.tokenUsage.updatedAt);
    if (latest === null || at >= latest.at) latest = { usedTokens: turn.tokenUsage.usedTokens, at };
  }
  return latest?.usedTokens ?? null;
};

/**
 * Where a thread's idle window stands, from its shell alone: `busy` restarts
 * the window, `idle` says when the reminder falls due, `off` means this state
 * never sends one. `lastBusyAtMs` is the worker's in-memory busy mark.
 */
export type IdleHandoffWindow =
  | { readonly state: "off" }
  | { readonly state: "busy" }
  | { readonly state: "idle"; readonly idleSinceMs: number; readonly dueMs: number };

export const idleHandoffWindow = (
  shell: OrchestrationV2ThreadShell,
  setting: SessionIdleHandoffSetting,
  lastBusyAtMs: number | undefined,
): IdleHandoffWindow => {
  if (shell.deletedAt !== null) return { state: "off" };
  // A handed-off session was replaced; its successor holds the reminder.
  if (shell.successorThreadId != null) return { state: "off" };
  // A settled or archived thread is finished work, held like a busy one so
  // that reopening it starts a fresh window instead of firing at once.
  if (isBusy(shell) || shell.settledOverride === "settled" || shell.archivedAt !== null) {
    return { state: "busy" };
  }
  // A failed last run waits on the user; a reminder would only fail the same way.
  if (shell.status === "failed") return { state: "off" };
  if (shell.latestRunId === null || shell.latestRunCompletedAt == null) return { state: "off" };

  // unsettledAt carries a reopen across a restart. An unarchive leaves no
  // such mark, so only the in-memory busy stretch covers it.
  const idleSinceMs = Math.max(
    DateTime.toEpochMillis(shell.latestRunCompletedAt),
    shell.unsettledAt == null ? 0 : DateTime.toEpochMillis(shell.unsettledAt),
    lastBusyAtMs ?? 0,
  );
  return { state: "idle", idleSinceMs, dueMs: idleSinceMs + setting.afterMinutes * 60_000 };
};

/**
 * What the run records add to an idle window: a `queued` run is work the
 * shell hides (a queue the server held after a Stop or a restart), `below`
 * means the last turn ended under the token line.
 */
export const idleHandoffLine = (
  records: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "providerTurns">,
  setting: SessionIdleHandoffSetting,
):
  | { readonly state: "queued" }
  | { readonly state: "below" }
  | { readonly state: "armed"; readonly usedTokens: number } => {
  if (records.runs.some((run) => run.status === "queued")) return { state: "queued" };
  const usedTokens = lastContextTokens(records);
  if (usedTokens === null || usedTokens < setting.minTokens) return { state: "below" };
  return { state: "armed", usedTokens };
};

const roundedThousands = (tokens: number) => `${Math.round(tokens / 1000)}k`;

const idleHandoffMessage = (input: {
  readonly idleMinutes: number;
  readonly usedTokens: number;
  readonly setting: SessionIdleHandoffSetting;
}) =>
  `IDLE HANDOFF: this session has been idle for ${input.idleMinutes} minutes at ` +
  `${roundedThousands(input.usedTokens)} context (your idle handoff is set to ` +
  `${input.setting.afterMinutes} minutes above ${roundedThousands(input.setting.minTokens)}), ` +
  "and the prompt cache expires after about an hour. If the user has not spoken since and " +
  "nothing is in flight, HAND OFF NOW per your handoff procedure: write your handoff state, " +
  "spawn your successor with session_spawn and handoff: true, and end your turn. Do not tell " +
  "the user you are waiting or ask first: this was set up so they come back to a small " +
  "session. Sessions you spawned that are still running are not in flight: your successor " +
  "adopts them. If something of your own is in flight, finish it first; this reminder comes " +
  "again after the " +
  "next idle stretch. session_idle_handoff with enabled: false turns it off.";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const scheduler = yield* Scheduler.Scheduler;

  // A broken table only disables this feature, never the server: every read
  // and write below reports its own failure.
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_session_idle_handoff (
      thread_id TEXT PRIMARY KEY NOT NULL,
      after_minutes INTEGER NOT NULL,
      min_tokens INTEGER NOT NULL
    )
  `.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not create the idle handoff table", { cause }),
    ),
  );

  type Row = {
    readonly thread_id: string;
    readonly after_minutes: number;
    readonly min_tokens: number;
  };
  const toSetting = (row: Row): SessionIdleHandoffSetting => ({
    afterMinutes: row.after_minutes,
    minTokens: row.min_tokens,
  });
  const readError = (cause: unknown) => new IdleHandoffStoreError({ operation: "read", cause });

  const list: SessionIdleHandoffService["Service"]["list"] = sql<Row>`
    SELECT thread_id, after_minutes, min_tokens FROM fork_session_idle_handoff
  `.pipe(
    Effect.map((rows) => new Map(rows.map((row) => [row.thread_id, toSetting(row)]))),
    Effect.mapError(readError),
  );

  const get: SessionIdleHandoffService["Service"]["get"] = (threadId) =>
    sql<Row>`
      SELECT thread_id, after_minutes, min_tokens FROM fork_session_idle_handoff
      WHERE thread_id = ${threadId}
    `.pipe(
      Effect.map((rows) => (rows[0] === undefined ? null : toSetting(rows[0]))),
      Effect.mapError(readError),
    );

  const set: SessionIdleHandoffService["Service"]["set"] = (threadId, setting) =>
    (setting === null
      ? sql`DELETE FROM fork_session_idle_handoff WHERE thread_id = ${threadId}`
      : sql`
          INSERT INTO fork_session_idle_handoff (thread_id, after_minutes, min_tokens)
          VALUES (${threadId}, ${setting.afterMinutes}, ${setting.minTokens})
          ON CONFLICT (thread_id) DO UPDATE SET
            after_minutes = excluded.after_minutes,
            min_tokens = excluded.min_tokens
        `
    ).pipe(
      Effect.asVoid,
      Effect.mapError((cause) => new IdleHandoffStoreError({ operation: "write", cause })),
    );

  // In memory only, so a restart starts from persisted state. `lastBusyAt`
  // catches work that ends without a new run, such as a held background
  // command; `nextCheckAt` spaces out reads of a thread that cannot fire yet;
  // `belowLine` remembers a run already found under the token line, which
  // dueAt honours too.
  const lastBusyAt = new Map<string, number>();
  const nextCheckAt = new Map<string, number>();
  const belowLine = new Map<string, string>();

  const forget = (threadId: string) => {
    lastBusyAt.delete(threadId);
    nextCheckAt.delete(threadId);
    belowLine.delete(threadId);
  };

  const lineKeyOf = (runId: string, setting: SessionIdleHandoffSetting) =>
    `${runId}:${setting.minTokens}`;

  const checkThread = Effect.fn("SessionIdleHandoff.checkThread")(function* (
    threadId: ThreadId,
    setting: SessionIdleHandoffSetting,
    nowMs: number,
  ) {
    if ((nextCheckAt.get(threadId) ?? 0) > nowMs) return;
    nextCheckAt.set(threadId, nowMs + CHECK_SPACING_MS);

    const shell = yield* threads.getThreadShell(threadId);
    if (shell === null || shell.deletedAt !== null) {
      forget(threadId);
      return yield* set(threadId, null);
    }
    const window = idleHandoffWindow(shell, setting, lastBusyAt.get(threadId));
    if (window.state === "busy") {
      lastBusyAt.set(threadId, nowMs);
      return;
    }
    if (window.state === "off" || shell.latestRunId === null) return;
    const { idleSinceMs, dueMs } = window;
    if (dueMs > nowMs) {
      nextCheckAt.set(threadId, Math.min(dueMs, nowMs + CHECK_SPACING_MS));
      return;
    }
    const lineKey = lineKeyOf(shell.latestRunId, setting);
    if (belowLine.get(threadId) === lineKey) return;

    const line = idleHandoffLine(
      yield* threads.getThreadRecords(threadId, ["runs", "providerTurns"]),
      setting,
    );
    if (line.state === "queued") {
      lastBusyAt.set(threadId, nowMs);
      return;
    }
    if (line.state === "below") {
      belowLine.set(threadId, lineKey);
      return;
    }
    const { usedTokens } = line;

    const fireKey = `idle-handoff:${threadId}:${shell.latestRunId}`;
    yield* threads.sendToThread({
      projectId: shell.projectId,
      commandId: CommandId.make(fireKey),
      threadId,
      messageId: MessageId.make(fireKey),
      text: idleHandoffMessage({
        idleMinutes: Math.round((nowMs - idleSinceMs) / 60_000),
        usedTokens,
        setting,
      }),
      attachments: [],
      // Never steer: the thread is idle, so this starts a turn.
      mode: "queue",
      createdBy: "system",
      creationSource: "server",
    });
    forget(threadId);
  });

  // A broken table would fail every 5-second tick; it is logged once per
  // streak of failures instead.
  let listFailing = false;
  const sweep = Effect.fn("SessionIdleHandoff.sweep")(function* () {
    const listed = yield* Effect.result(list);
    if (listed._tag === "Failure") {
      if (!listFailing) {
        yield* Effect.logWarning("Could not read the idle handoff settings", {
          cause: listed.failure,
        });
      }
      listFailing = true;
      return;
    }
    listFailing = false;
    const settings = listed.success;
    for (const threadId of nextCheckAt.keys()) {
      if (!settings.has(threadId)) forget(threadId);
    }
    if (settings.size === 0) return;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    for (const [threadId, setting] of settings) {
      yield* checkThread(ThreadId.make(threadId), setting, nowMs).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Idle handoff check failed", { threadId, cause }),
        ),
      );
    }
  });

  const dueAt = Effect.fn("SessionIdleHandoff.dueAt")(function* (threadId: ThreadId) {
    const setting = yield* get(threadId);
    if (setting === null) return null;
    const shell = yield* threads.getThreadShell(threadId);
    if (shell === null || shell.latestRunId === null) return null;
    const window = idleHandoffWindow(shell, setting, lastBusyAt.get(threadId));
    if (window.state !== "idle") return null;
    // A run the worker found below the line stays below it, so the card
    // cannot promise a reminder the worker will not send.
    if (belowLine.get(threadId) === lineKeyOf(shell.latestRunId, setting)) return null;
    const line = idleHandoffLine(
      yield* threads.getThreadRecords(threadId, ["runs", "providerTurns"]),
      setting,
    );
    return line.state === "armed" ? window.dueMs : null;
  });

  yield* scheduler.register("session-idle-handoff", sweep());

  return SessionIdleHandoffService.of({ list, get, set, dueAt });
});

export const layer = Layer.effect(SessionIdleHandoffService, make);
