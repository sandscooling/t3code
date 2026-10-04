import * as Effect from "effect/Effect";
import { nativeImage } from "electron";

import { PreviewOperationError } from "./Manager.ts";

/**
 * Per-entry cap for captured console and log text. The buffer bounds how many
 * entries survive but said nothing about their size, so one page logging a
 * serialized response could outweigh everything else in the snapshot.
 */
const MAX_DIAGNOSTIC_TEXT_LENGTH = 2_000;
const truncateDiagnosticText = (text: string): string =>
  text.length <= MAX_DIAGNOSTIC_TEXT_LENGTH
    ? text
    : `${text.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH)}…`;

/**
 * Fork: filters one CDP diagnostic message's effect on a tab's diagnostics.
 * console.debug is developer tracing for whoever wrote the page, not a signal
 * about its health, and libraries emit it by the hundred, so it is dropped.
 * Errors, warnings and ordinary logs still come through, since app output can
 * matter, but a console entry the message just appended has its text capped.
 */
export const filterDiagnosticMessage = <
  D extends { readonly consoleEntries: ReadonlyArray<{ readonly text: string }> },
>(
  method: string,
  params: Record<string, unknown>,
  current: D,
  next: D,
): D => {
  if (method === "Runtime.consoleAPICalled" && params["type"] === "debug") {
    return current;
  }
  if (next.consoleEntries === current.consoleEntries || next.consoleEntries.length === 0) {
    return next;
  }
  const last = next.consoleEntries.length - 1;
  const entry = next.consoleEntries[last]!;
  const text = truncateDiagnosticText(entry.text);
  if (text === entry.text) {
    return next;
  }
  return {
    ...next,
    consoleEntries: [...next.consoleEntries.slice(0, last), { ...entry, text }],
  } as D;
};

/**
 * Fork: pipe upstream's snapshot capture through this to prefer Electron's
 * compositor capture and fall back to CDP when it cannot deliver a frame.
 *
 * `capturePage` copies an existing compositor surface, so it fails with
 * `UnknownVizError` (or hands back an empty image) whenever the tab is not
 * being painted - a background thread's offscreen preview being the common
 * case. `Page.captureScreenshot` renders its own frame and needs no live viz
 * surface, which keeps snapshots working for tabs the human cannot see.
 *
 * Upstream's bounded, retrying capture runs first. Retrying cannot help a tab
 * that is never painted at all, which is what the debugger path is for.
 */
export const withScreenshotFallback =
  <E2, R2>(
    send: (
      method: string,
      commandParams?: Record<string, unknown>,
    ) => Effect.Effect<unknown, E2, R2>,
    tabId: string,
    webContentsId: number,
  ) =>
  <E extends { readonly _tag: string }, R>(
    capturePage: Effect.Effect<Electron.NativeImage, E, R>,
  ) => {
    const viaDebugger = send("Page.captureScreenshot", { format: "png" }).pipe(
      Effect.flatMap((rawResponse) => {
        const data = (rawResponse as { readonly data?: unknown }).data;
        if (typeof data !== "string" || data.length === 0) {
          return Effect.fail(
            new PreviewOperationError({
              tabId,
              webContentsId,
              operation: "automationSnapshot.captureScreenshot",
              cause: new Error("Page.captureScreenshot returned no image data"),
            }),
          );
        }
        return Effect.succeed(nativeImage.createFromBuffer(Buffer.from(data, "base64")));
      }),
    );
    // Both "rejected" and "resolved but empty" collapse into one absent frame so
    // the debugger path runs at most once, whichever way the capture came back.
    // A stalled capture means the compositor is hung; the debugger cannot fix
    // that and its own timeout would only bury a clearer error, so upstream's
    // timeout failure stays authoritative. A capture that merely *rejects* can
    // just be an unpainted tab, which is exactly what the debugger path is
    // for. A destroyed or replaced guest fails both ways, so it keeps
    // travelling too.
    return capturePage.pipe(
      Effect.catchIf(
        (error) =>
          error._tag === "PreviewOperationError" &&
          ((error as { readonly cause?: unknown }).cause as { readonly _tag?: string } | undefined)
            ?._tag !== "TimeoutError",
        () => Effect.succeed(undefined),
      ),
      Effect.flatMap((image) => (image && !image.isEmpty() ? Effect.succeed(image) : viaDebugger)),
    );
  };
