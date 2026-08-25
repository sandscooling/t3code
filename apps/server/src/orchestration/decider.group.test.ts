import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const MODEL = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

function makeReadModel(input: { readonly withThread: boolean }): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [
      {
        id: ProjectId.make("project-1"),
        title: "Project",
        workspaceRoot: "/repo",
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
    ],
    threads: input.withThread
      ? [
          {
            id: ThreadId.make("thread-1"),
            projectId: ProjectId.make("project-1"),
            title: "Thread",
            modelSelection: MODEL,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            group: null,
            latestTurn: null,
            createdAt: NOW,
            updatedAt: NOW,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            pinnedAt: null,
            pinOrderKey: null,
            deletedAt: null,
            messages: [],
            proposedPlans: [],
            activities: [],
            checkpoints: [],
            session: null,
          },
        ]
      : [],
    updatedAt: NOW,
  };
}

const createCommand = (group?: string) => ({
  type: "thread.create" as const,
  commandId: CommandId.make("cmd-create"),
  threadId: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "T-1234-dev",
  modelSelection: MODEL,
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  ...(group !== undefined ? { group } : {}),
  createdAt: NOW,
});

it.layer(NodeServices.layer)("thread group decider", (it) => {
  it.effect("stamps the group onto thread.created", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: createCommand("T-1234"),
        readModel: makeReadModel({ withThread: false }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.created");
      if (events[0]?.type === "thread.created") {
        expect(events[0].payload.group).toBe("T-1234");
      }
    }),
  );

  it.effect("creates an ungrouped thread with a null group, never an absent one", () =>
    Effect.gen(function* () {
      // Null rather than undefined so the projected read model and the SQL
      // row agree without every reader having to coalesce.
      const event = yield* decideOrchestrationCommand({
        command: createCommand(),
        readModel: makeReadModel({ withThread: false }),
      });
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.created") {
        expect(events[0].payload.group).toBeNull();
      }
    }),
  );

  it.effect("meta update sets and clears the group", () =>
    Effect.gen(function* () {
      const set = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-meta-set"),
          threadId: ThreadId.make("thread-1"),
          group: "T-1234",
        },
        readModel: makeReadModel({ withThread: true }),
      });
      const setEvents = Array.isArray(set) ? set : [set];
      expect(setEvents[0]?.type).toBe("thread.meta-updated");
      if (setEvents[0]?.type === "thread.meta-updated") {
        expect(setEvents[0].payload.group).toBe("T-1234");
      }

      const clear = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-meta-clear"),
          threadId: ThreadId.make("thread-1"),
          group: null,
        },
        readModel: makeReadModel({ withThread: true }),
      });
      const clearEvents = Array.isArray(clear) ? clear : [clear];
      if (clearEvents[0]?.type === "thread.meta-updated") {
        expect(clearEvents[0].payload.group).toBeNull();
      }
    }),
  );

  it.effect("meta update without a group leaves the payload key absent", () =>
    Effect.gen(function* () {
      // Absent means "unchanged" downstream; a null here would clear it.
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-meta-title"),
          threadId: ThreadId.make("thread-1"),
          title: "Renamed",
        },
        readModel: makeReadModel({ withThread: true }),
      });
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.meta-updated") {
        expect("group" in events[0].payload).toBe(false);
      }
    }),
  );
});
