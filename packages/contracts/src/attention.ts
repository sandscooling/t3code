import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { IsoDateTime, ThreadId } from "./baseSchemas.ts";

/**
 * An agent asking for the user in person, rather than in the transcript.
 *
 * Hooks fire for every agent, which is why this is a tool instead: one session
 * decides that something needs the user, and only that call rings. The ping is
 * deliberately not event-sourced. It is a doorbell, not history: the reason the
 * agent rang is already written in its thread, and a ping replayed after a
 * reconnect would ring for work the user has long since answered.
 */
/**
 * `custom` means the sound file the user picked; the rest are synthesised by
 * the client. A client that cannot reach the file falls back to `chime`, so an
 * unreadable file costs the tone rather than the ping.
 */
export const AttentionSound = Schema.Literals(["chime", "ping", "alert", "knock", "custom"]);
export type AttentionSound = typeof AttentionSound.Type;

export const DEFAULT_ATTENTION_SOUND: AttentionSound = "chime";

/**
 * Audio the browser can play from a plain Audio element. Deliberately short:
 * every entry is a format Chromium decodes on all three desktop platforms, so
 * a file that passes this check plays everywhere the app runs.
 */
const ATTENTION_SOUND_MIME_BY_EXTENSION = new Map([
  [".aac", "audio/aac"],
  [".flac", "audio/flac"],
  [".m4a", "audio/mp4"],
  [".mp3", "audio/mpeg"],
  [".oga", "audio/ogg"],
  [".ogg", "audio/ogg"],
  [".opus", "audio/ogg"],
  [".wav", "audio/wav"],
  [".weba", "audio/webm"],
]);

/** Extensions without the dot, which is the shape a file dialog filter wants. */
export const ATTENTION_SOUND_FILE_EXTENSIONS = [...ATTENTION_SOUND_MIME_BY_EXTENSION.keys()].map(
  (extension) => extension.slice(1),
);

/** Null for anything the user should not be able to point the picker at. */
export function attentionSoundMimeTypeFromExtension(extension: string): string | null {
  if (!/^[.][a-z0-9]+$/i.test(extension)) return null;
  return ATTENTION_SOUND_MIME_BY_EXTENSION.get(extension.toLowerCase()) ?? null;
}

/** Bounded so a runaway agent cannot push a wall of text into a toast. */
export const ATTENTION_MESSAGE_MAX_LENGTH = 200;

export const AttentionPing = Schema.Struct({
  threadId: ThreadId,
  /** Session name, so the user knows which agent is asking before opening it. */
  threadTitle: Schema.String,
  message: Schema.String,
  sound: AttentionSound,
  requestedAt: IsoDateTime,
});
export type AttentionPing = typeof AttentionPing.Type;

const attentionMessage = (() => {
  const encoded = Schema.String.annotate({
    description:
      "One line telling the user what you need, shown in the notification. Keep it to the ask itself, for example 'Ticket 15.8.5 needs a decision on the migration order'.",
  }).check(Schema.isNonEmpty(), Schema.isMaxLength(ATTENTION_MESSAGE_MAX_LENGTH));
  return encoded.pipe(Schema.decodeTo(encoded, SchemaTransformation.trim()));
})();

export const AttentionSubscribeInput = Schema.Struct({});
export type AttentionSubscribeInput = typeof AttentionSubscribeInput.Type;

export const SessionNotifyInput = Schema.Struct({
  // Annotated on the encoded side so the description survives into the JSON
  // Schema the agent actually reads, then trimmed on decode so a whitespace
  // ask is rejected rather than rung. Same shape as t3ProjectFile.
  message: attentionMessage,
  sound: Schema.optional(
    AttentionSound.annotate({
      description:
        "Which sound to play. Omit to use the user's chosen default. `chime` is neutral, `ping` is short, `knock` is soft, `alert` is the most urgent.",
    }),
  ),
});
export type SessionNotifyInput = typeof SessionNotifyInput.Type;

export const SessionNotifyResult = Schema.Struct({
  /** How many connected clients the ping reached. Zero means nobody heard it. */
  delivered: Schema.Number,
  sound: AttentionSound,
});
export type SessionNotifyResult = typeof SessionNotifyResult.Type;
