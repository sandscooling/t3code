// Fork-owned tests for ThreadNotificationCoordinator.
import { WORKING_EXIT_GRACE_MS } from "@t3tools/client-runtime/state/thread-inbox";
import type { AnyRouter } from "@tanstack/react-router";
import type { ClientSettings } from "@t3tools/contracts/settings";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { fakeTimers, stubGlobal } from "../../test/render";

const state = vi.hoisted(() => ({
  mode: "off" as ClientSettings["notificationMode"],
  inApp: true,
  active: { environmentId: "env-1", threadId: "other-thread" },
  focused: true,
  visible: "visible",
  live: true,
  completedAt: null as string | null,
  stopRequested: false,
  archivedAt: null as string | null,
  input: false,
  approval: false,
  sessionError: false,
  turnError: false,
  limited: false,
  subagent: false,
  gone: false,
  // Reuse the last thread object, as the shell reducer does for an unchanged thread.
  unchanged: false,
  background: [] as Array<{ taskId: string; kind: "command" | "monitor"; held?: boolean }>,
  add: vi.fn(
    (_toast: {
      id?: string;
      timeout?: number;
      title: string;
      description: string;
      data?: { dismissOnActiveThreadRef?: { environmentId: string; threadId: string } | null };
      actionProps: { onClick: () => void };
    }) => "toast-1",
  ),
  close: vi.fn(),
  navigate: vi.fn(),
  sound: vi.fn(),
  notification: vi.fn(function (_title: string, options: NotificationOptions) {
    return Object.assign(new EventTarget(), { tag: options.tag, close: vi.fn() });
  }),
}));

const SHELL_NOW = DateTime.makeUnsafe("2026-09-13T09:00:00.000Z");

function mockThreadShell() {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "Fix the login form",
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: "thread-1",
      parentThreadId: state.subagent ? "parent" : null,
      relationshipToParent: state.subagent ? "subagent" : null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: "run-1",
    latestRunStopRequested: state.stopRequested,
    activeRunId: null,
    status: state.completedAt
      ? "completed"
      : state.sessionError || state.turnError || state.limited
        ? "failed"
        : "running",
    lastErrorClass: state.limited ? "usage_limit" : null,
    pendingRuntimeRequest: state.input
      ? { id: "request-1", kind: "user_input", createdAt: SHELL_NOW }
      : state.approval
        ? { id: "request-1", kind: "command", createdAt: SHELL_NOW }
        : null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: state.background,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: SHELL_NOW,
    updatedAt: SHELL_NOW,
    latestRunRequestedAt: SHELL_NOW,
    latestRunStartedAt: SHELL_NOW,
    latestRunCompletedAt: state.completedAt ? DateTime.makeUnsafe(state.completedAt) : undefined,
    archivedAt: state.archivedAt ? DateTime.makeUnsafe(state.archivedAt) : null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

let lastThreadShell: ReturnType<typeof mockThreadShell> | undefined;
function threadShell() {
  if (!state.unchanged || lastThreadShell === undefined) lastThreadShell = mockThreadShell();
  return lastThreadShell;
}

vi.mock(import("../hooks/useSettings"), async (original) => ({
  ...(await original()),
  subscribeClientSettings: (() => () => {}) as never,
  getClientSettings: (() => ({
    notificationMode: state.mode,
    inAppNotificationsEnabled: state.inApp,
  })) as never,
}));
vi.mock(import("../state/shell"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentShell: {
      ...actual.environmentShell,
      stateValueAtom: ((id: string) => shellAtom(id)) as never,
    },
  };
});
vi.mock(import("../state/presentation"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentSummaries: {
      ...actual.environmentSummaries,
      // Read lazily: the factory runs before this module's own bindings exist.
      get environmentIdsAtom() {
        return environmentIdsAtom as never;
      },
    },
  };
});
vi.mock("../threadNotifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../threadNotifications")>()),
  playNotificationSound: state.sound,
  unlockNotificationAudio: vi.fn(),
  setNotificationBadge: vi.fn(),
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: state.add, close: state.close },
}));

import { startThreadNotifications } from "./ThreadNotificationCoordinator";

const shellAtom = Atom.family((_id: string) => Atom.make<unknown>(null));
const environmentIdsAtom = Atom.make<ReadonlyArray<string>>(["env-1"]);
const shellValue = () => ({
  status: state.live ? "live" : "disconnected",
  snapshot: Option.some({ threads: state.gone ? [] : [threadShell()] }),
});

// The mocked modules read `state`, so every test starts by resetting all of it. The first
// render is left to the test because some tests change state before the service starts.
function setup() {
  vi.clearAllMocks();
  Object.assign(state, {
    mode: "off",
    inApp: true,
    active: { environmentId: "env-1", threadId: "other-thread" },
    focused: true,
    visible: "visible",
    live: true,
    completedAt: null,
    stopRequested: false,
    archivedAt: null,
    input: false,
    approval: false,
    sessionError: false,
    turnError: false,
    limited: false,
    subagent: false,
    gone: false,
    unchanged: false,
    background: [],
  });
  lastThreadShell = undefined;
  const stack = new AsyncDisposableStack();
  stack.use(
    vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => state.visible as DocumentVisibilityState),
  );
  stack.use(vi.spyOn(document, "hasFocus").mockImplementation(() => state.focused));
  stack.use(
    stubGlobal("Notification", Object.assign(state.notification, { permission: "granted" })),
  );
  const registry = AtomRegistry.make();
  stack.defer(() => registry.dispose());
  const router = {
    get state() {
      return { matches: [{ params: state.active }] };
    },
    navigate: state.navigate,
  } as unknown as AnyRouter;
  let started = false;
  return {
    // Publishes the current shell; the first call also starts the service.
    render: async () => {
      registry.set(shellAtom("env-1"), shellValue());
      if (started) return;
      started = true;
      stack.defer(startThreadNotifications(registry, router));
    },
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}

describe("thread notifications", () => {
  // Fork: keeps the toast up until answered (clears on answer).
  it.each(["input", "approval"] as const)(
    "keeps the %s toast up until the thread is answered",
    async (event) => {
      await using app = setup();
      await app.render();
      state[event] = true;
      await app.render();

      const toast = state.add.mock.calls[0]?.[0];
      // No auto-dismiss, and a per-thread id so a follow-up question on the same
      // thread replaces this toast instead of stacking a second one.
      expect(toast).toMatchObject({
        id: "thread-attention:env-1:thread-1",
        timeout: 0,
        data: { dismissOnActiveThreadRef: { environmentId: "env-1", threadId: "thread-1" } },
      });

      state[event] = false;
      await app.render();
      expect(state.close).toHaveBeenCalledWith("thread-attention:env-1:thread-1");
    },
  );

  // Fork: a question that turns into a failure or a limit no longer wants an answer.
  it.each(["sessionError", "limited"] as const)(
    "closes the standing toast when the question turns into %s",
    async (event) => {
      await using app = setup();
      await app.render();
      state.input = true;
      await app.render();
      expect(state.close).not.toHaveBeenCalled();

      state.input = false;
      state[event] = true;
      await app.render();
      expect(state.close).toHaveBeenCalledWith("thread-attention:env-1:thread-1");
      expect(state.add).toHaveBeenLastCalledWith(
        expect.objectContaining({
          title: event === "limited" ? "Usage limit reached" : "Thread failed",
        }),
      );
    },
  );

  // Fork: `previous` is wiped while disconnected, so first sight must clean up.
  it.each(["is answered", "disappears"] as const)(
    "closes the standing toast when its thread %s while disconnected",
    async (change) => {
      await using app = setup();
      await app.render();
      state.input = true;
      await app.render();
      state.live = false;
      await app.render();
      if (change === "is answered") state.input = false;
      else state.gone = true;
      state.live = true;
      await app.render();
      expect(state.close).toHaveBeenCalledWith("thread-attention:env-1:thread-1");
    },
  );

  it("keeps the standing toast across a reconnect while the question still waits", async () => {
    await using app = setup();
    await app.render();
    state.input = true;
    await app.render();
    state.live = false;
    await app.render();
    state.live = true;
    await app.render();
    expect(state.close).not.toHaveBeenCalled();
  });

  // Fork: upstream skips a thread whose shell object did not change; it still waits.
  it("keeps the standing toast when the shell refreshes without changing its thread", async () => {
    await using app = setup();
    await app.render();
    state.input = true;
    await app.render();
    state.unchanged = true;
    await app.render();
    await app.render();
    expect(state.close).not.toHaveBeenCalled();
    state.unchanged = false;
    state.input = false;
    await app.render();
    expect(state.close).toHaveBeenCalledWith("thread-attention:env-1:thread-1");
  });

  // Fork: a question raised in the background still waits as a toast.
  it("leaves a question's toast waiting when it arrives while the app is unfocused", async () => {
    await using app = setup();
    state.mode = "notifications";
    state.focused = false;
    await app.render();
    state.input = true;
    await app.render();
    expect(state.add).toHaveBeenCalledWith(
      expect.objectContaining({ id: "thread-attention:env-1:thread-1", timeout: 0 }),
    );
    expect(state.notification).toHaveBeenCalledTimes(1);
  });

  it("does not raise a question's toast for the thread already open", async () => {
    await using app = setup();
    state.active.threadId = "thread-1";
    state.focused = false;
    await app.render();
    state.input = true;
    await app.render();
    expect(state.add).not.toHaveBeenCalled();
  });

  it("restores a question's toast, silently, for a thread already waiting on load", async () => {
    await using app = setup();
    state.mode = "notifications-and-sound";
    state.approval = true;
    await app.render();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.add).toHaveBeenCalledWith(
      expect.objectContaining({ id: "thread-attention:env-1:thread-1", title: "Approval needed" }),
    );
    expect(state.sound).not.toHaveBeenCalled();
    expect(state.notification).not.toHaveBeenCalled();
  });

  // Fork: only a held command re-arms the completion alert; a pull request
  // watch makes the thread wait too, but its run already alerted.
  it("does not alert the same completion again after a pull request watch ends", async () => {
    await using app = setup();
    state.mode = "notifications-and-sound";
    await app.render();
    using _timers = fakeTimers();
    state.completedAt = "2026-09-13T10:00:00.000Z";
    await app.render();
    await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);
    expect(state.sound).toHaveBeenCalledTimes(1);
    state.background = [{ taskId: "pull-request-watch:github.com/acme/app#1", kind: "monitor" }];
    await app.render();
    state.background = [];
    await app.render();
    await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);
    expect(state.sound).toHaveBeenCalledTimes(1);
  });

  it("still alerts again when a held command ends alongside a pull request watch", async () => {
    await using app = setup();
    state.mode = "notifications-and-sound";
    await app.render();
    using _timers = fakeTimers();
    state.completedAt = "2026-09-13T10:00:00.000Z";
    await app.render();
    await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);
    state.background = [
      { taskId: "pull-request-watch:github.com/acme/app#1", kind: "monitor" },
      { taskId: "bench", kind: "command", held: true },
    ];
    await app.render();
    expect(state.sound).toHaveBeenCalledTimes(1);
    state.background = [];
    await app.render();
    await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);
    expect(state.sound).toHaveBeenCalledTimes(2);
  });

  // Fork: a finished thread raises no toast, only its sound and background system popup.
  it("gives a completion its sound but no toast", async () => {
    await using app = setup();
    state.mode = "notifications-and-sound";
    await app.render();
    using _timers = fakeTimers();
    state.completedAt = "2026-09-13T10:00:00.000Z";
    await app.render();
    await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);
    expect(state.sound).toHaveBeenCalledWith("completion", expect.any(Function));
    expect(state.add).not.toHaveBeenCalled();
    expect(state.notification).not.toHaveBeenCalled();
  });

  it("stays silent for a completion the reader stopped", async () => {
    await using app = setup();
    state.mode = "notifications-and-sound";
    state.focused = false;
    await app.render();
    using _timers = fakeTimers();
    state.stopRequested = true;
    state.completedAt = "2026-09-13T10:00:00.000Z";
    await app.render();
    await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);
    expect(state.sound).not.toHaveBeenCalled();
    expect(state.notification).not.toHaveBeenCalled();
  });

  it("lets a failure toast fall away on its own", async () => {
    await using app = setup();
    await app.render();
    state.sessionError = true;
    await app.render();
    const toast = state.add.mock.calls[0]?.[0];
    expect(toast).not.toHaveProperty("timeout");
    expect(toast).not.toHaveProperty("id");
    expect(toast?.data?.dismissOnActiveThreadRef).toBe(null);
  });
});
