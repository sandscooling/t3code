// Fork tests for PreviewAutomationBroker.test.ts.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewAutomationNoAvailableHostError,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationHost,
  type PreviewAutomationRequest,
  type PreviewAutomationStreamEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const makeBroker = PreviewAutomationBroker.make.pipe(Effect.provide(NodeServices.layer));

const scope = {
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session-1",
  thread: {
    threadId: ThreadId.make("thread-1"),
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};

const makeHost = (overrides: Partial<PreviewAutomationHost> = {}): PreviewAutomationHost => ({
  clientId: "client-1",
  environmentId: scope.environmentId,
  ...overrides,
});

type RoutedRequest = PreviewAutomationRequest & {
  readonly connectionId: PreviewAutomationStreamEvent["connectionId"];
};

const requestsFrom = (
  events: Stream.Stream<PreviewAutomationStreamEvent>,
): Stream.Stream<RoutedRequest> =>
  events.pipe(
    Stream.filterMap((event) => {
      if (event.type === "connected") {
        return Result.failVoid;
      }
      return Result.succeed({ ...event.request, connectionId: event.connectionId });
    }),
  );

it.effect("tells agents to retry once while a timed-out host reconnects, then stops", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const received = yield* Deferred.make<void>();
      yield* Stream.runForEach(requestsFrom(yield* broker.connect(makeHost())), () =>
        Deferred.succeed(received, undefined),
      ).pipe(Effect.forkScoped);
      const timedOut = yield* broker
        .invoke<void>({ scope, operation: "snapshot", input: {}, timeoutMs: 1_000 })
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Deferred.await(received);
      yield* TestClock.adjust(1_000);
      expect(yield* Fiber.join(timedOut)).toMatchObject({ _tag: "PreviewAutomationTimeoutError" });

      const reconnecting = yield* broker
        .invoke<void>({ scope, operation: "status", input: {} })
        .pipe(Effect.flip);
      expect(reconnecting).toBeInstanceOf(PreviewAutomationNoAvailableHostError);
      expect(reconnecting).toMatchObject({ hostResetAfterTimeout: true });
      expect(reconnecting.message).toContain("reset after a request timed out and is reconnecting");
      expect(reconnecting.message).not.toContain("Do not retry");

      yield* TestClock.adjust(PreviewAutomationBroker.HOST_RESET_RECONNECT_WINDOW_MS);
      const gone = yield* broker
        .invoke<void>({ scope, operation: "status", input: {} })
        .pipe(Effect.flip);
      expect(gone).toBeInstanceOf(PreviewAutomationNoAvailableHostError);
      expect(gone).not.toHaveProperty("hostResetAfterTimeout");
      expect(gone.message).toContain("Do not retry.");
    }),
  ),
);

it.effect("stops reporting a reconnect once the timed-out host has registered again", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const received = yield* Deferred.make<void>();
      yield* Stream.runForEach(requestsFrom(yield* broker.connect(makeHost())), () =>
        Deferred.succeed(received, undefined),
      ).pipe(Effect.forkScoped);
      const timedOut = yield* broker
        .invoke<void>({ scope, operation: "snapshot", input: {}, timeoutMs: 1_000 })
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Deferred.await(received);
      yield* TestClock.adjust(1_000);
      yield* Fiber.join(timedOut);

      // The desktop re-registers, then goes away for good inside the window.
      const consumer = yield* Stream.runDrain(yield* broker.connect(makeHost())).pipe(
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(consumer);

      const error = yield* broker
        .invoke<void>({ scope, operation: "status", input: {} })
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(PreviewAutomationNoAvailableHostError);
      expect(error.message).toContain("Do not retry.");
    }),
  ),
);
