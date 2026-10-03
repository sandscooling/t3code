import { describe, expect, it } from "@effect/vitest";

import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ProviderInstanceId, RuntimeRequestId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { projectThreadAwarenessV2 } from "./agentAwareness.ts";
import { isCrewSession, isIdleCrewSession, isSilencedCrewAlert } from "./crewSession.ts";

const crew = { spawnedByThreadId: "orchestrator" as ThreadId, settledOverride: null };
// A top-level orchestrator (and its handoff successor) has no spawner.
const orchestrator = { spawnedByThreadId: null, settledOverride: null };
// v2-created threads omit the key entirely.
const ownThread: { readonly spawnedByThreadId?: ThreadId | null; readonly settledOverride: null } =
  { settledOverride: null };

describe("isCrewSession", () => {
  it("is a crew session only when a spawner is set", () => {
    expect(isCrewSession(crew)).toBe(true);
    expect(isCrewSession(orchestrator)).toBe(false);
    expect(isCrewSession(ownThread)).toBe(false);
  });
});

describe("isIdleCrewSession", () => {
  it("reads an unsettled crew session between turns as idle", () => {
    expect(isIdleCrewSession(crew, "ready")).toBe(true);
    expect(isIdleCrewSession({ ...crew, settledOverride: "active" }, "ready")).toBe(true);
  });

  it.each(["working", "waiting", "approval", "input", "limited", "failed"])(
    "lets %s outrank idle",
    (status) => {
      expect(isIdleCrewSession(crew, status)).toBe(false);
    },
  );

  it("never reads a settled crew session as idle", () => {
    expect(isIdleCrewSession({ ...crew, settledOverride: "settled" }, "ready")).toBe(false);
  });

  it("leaves orchestrators and the user's own threads alone", () => {
    expect(isIdleCrewSession(orchestrator, "ready")).toBe(false);
    expect(isIdleCrewSession(ownThread, "ready")).toBe(false);
  });
});

describe("isSilencedCrewAlert", () => {
  it("silences only a crew session's completion", () => {
    expect(isSilencedCrewAlert(crew, "completion")).toBe(true);
    expect(isSilencedCrewAlert(crew, "failure")).toBe(false);
    expect(isSilencedCrewAlert(crew, "input")).toBe(false);
    expect(isSilencedCrewAlert(crew, "approval")).toBe(false);
  });

  it("keeps completion alerts for orchestrators and the user's own threads", () => {
    expect(isSilencedCrewAlert(orchestrator, "completion")).toBe(false);
    expect(isSilencedCrewAlert(ownThread, "completion")).toBe(false);
  });
});

describe("crew session mobile push", () => {
  const thread = (
    spawnedByThreadId: ThreadId | null,
    status: "completed" | "failed" | "running",
    pendingRuntimeRequest: Parameters<
      typeof projectThreadAwarenessV2
    >[0]["thread"]["pendingRuntimeRequest"] = null,
  ) =>
    projectThreadAwarenessV2({
      environmentId: "env-1" as EnvironmentId,
      project: { title: "t3code" },
      thread: {
        id: "thread-1" as ThreadId,
        lineage: {
          rootThreadId: "thread-1" as ThreadId,
          parentThreadId: null,
          relationshipToParent: null,
        },
        title: "Crew worker",
        modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "opus" },
        status,
        pendingRuntimeRequest,
        spawnedByThreadId,
        updatedAt: DateTime.makeUnsafe("2026-10-03T12:00:00.000Z"),
      },
    });

  it("publishes no completed state for a crew session, so no push is sent", () => {
    expect(thread("orchestrator" as ThreadId, "completed")).toBeNull();
  });

  it("still publishes a crew session's failure and work", () => {
    expect(thread("orchestrator" as ThreadId, "failed")).toMatchObject({ phase: "failed" });
    expect(thread("orchestrator" as ThreadId, "running")).toMatchObject({ phase: "running" });
  });

  it("still publishes a crew session's question and approval", () => {
    const request = (kind: "user_input" | "dynamic_tool_call") => ({
      id: RuntimeRequestId.make("request-1"),
      kind,
      createdAt: DateTime.makeUnsafe("2026-10-03T12:00:00.000Z"),
    });
    expect(thread("orchestrator" as ThreadId, "running", request("user_input"))).toMatchObject({
      phase: "waiting_for_input",
    });
    // Any request other than a question or an auth refresh is an approval.
    expect(
      thread("orchestrator" as ThreadId, "running", request("dynamic_tool_call")),
    ).toMatchObject({
      phase: "waiting_for_approval",
    });
  });

  it("still publishes an orchestrator's completion", () => {
    expect(thread(null, "completed")).toMatchObject({ phase: "completed" });
  });
});
