/**
 * ElectronNotification - OS notifications raised on behalf of an agent.
 *
 * The renderer can play a sound, but only the main process can put something in
 * the Windows Action Center, and that is the half that survives a minimized
 * window. Clicking the notification brings the app forward, since the whole
 * point of the ping is that the user is needed here.
 *
 * @module ElectronNotification
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Electron from "electron";

import * as ElectronWindow from "./ElectronWindow.ts";

export interface DesktopNotificationInput {
  readonly title: string;
  readonly body: string;
  /**
   * The renderer already played the chosen tone, so the OS sound would be a
   * second, different noise on top of it. Left to the caller because a client
   * that could not play audio wants the opposite answer.
   */
  readonly silent: boolean;
}

export class ElectronNotification extends Context.Service<
  ElectronNotification,
  {
    /** Resolves false when the OS refuses notifications, so callers can say so. */
    readonly show: (input: DesktopNotificationInput) => Effect.Effect<boolean>;
  }
>()("@t3tools/desktop/electron/ElectronNotification") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const windows = yield* ElectronWindow.ElectronWindow;

  return ElectronNotification.of({
    show: (input) =>
      Effect.gen(function* () {
        if (!Electron.Notification.isSupported()) {
          return false;
        }
        const notification = new Electron.Notification({
          title: input.title,
          body: input.body,
          silent: input.silent,
        });
        notification.on("click", () => {
          void Effect.runPromise(
            Effect.gen(function* () {
              const window = yield* windows.focusedMainOrFirst;
              if (Option.isNone(window)) return;
              yield* windows.reveal(window.value);
            }).pipe(Effect.provideService(ElectronWindow.ElectronWindow, windows)),
          );
        });
        notification.show();
        return true;
      }).pipe(
        // A notification that throws must never take the ping's caller with it:
        // the sound has already played and the agent is waiting on a result.
        Effect.catchCause((cause) =>
          Effect.logWarning("desktop notification failed", { cause }).pipe(Effect.as(false)),
        ),
      ),
  });
});

export const layer = Layer.effect(ElectronNotification)(make);
