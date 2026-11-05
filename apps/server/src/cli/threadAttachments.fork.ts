import {
  AttachmentCreateUploadUrlResult,
  getProviderAttachmentLimitError,
  MessageId,
  OrchestrationV2RunStatus,
  OrchestratorMcpThreadSendResult,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { Flag } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { fileHeaderMimeType } from "../workspace/fileHeaderMimeType.ts";
import type { ThreadTools } from "./thread.ts";

// t3_thread_launch and t3_thread_send_attachments accept at most 8 attachments.
const MCP_MAX_ATTACHMENTS = 8;
const MAX_IMAGES = Math.min(PROVIDER_SEND_TURN_MAX_ATTACHMENTS, MCP_MAX_ATTACHMENTS);
const MIB = 1024 * 1024;

type ImageMimeType = (typeof PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES)[number];

const EXTENSION_BY_MIME_TYPE: Record<ImageMimeType, string> = {
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

export class ThreadImageError extends Schema.TaggedError<ThreadImageError>()("ThreadImageError", {
  detail: Schema.String,
}) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return this.detail;
  }
}

export const imageFlag = Flag.String("image").pipe(
  Flag.withDescription(
    "Attach a PNG, JPEG, WebP, or GIF image. Repeat for more, or pass - to read one image from stdin. A send with images can reach a busy thread mid-turn.",
  ),
  Flag.atLeast(0),
);

export interface CliImage {
  readonly name: string;
  readonly mimeType: ImageMimeType;
  readonly bytes: Uint8Array;
}

/** Only the byte signature counts, so a renamed HEIC or text file never reaches the provider. */
const inferImageMimeType = (bytes: Uint8Array): ImageMimeType | undefined => {
  const sniffed = fileHeaderMimeType(bytes.subarray(0, 16));
  return PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES.find((type) => type === sniffed);
};

const fail = (detail: string) => Effect.fail(new ThreadImageError({ detail }));

const tooLarge = (name: string, sizeBytes: number) =>
  fail(
    `'${name}' is ${(sizeBytes / MIB).toFixed(1)} MiB. Images can be up to ${PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / MIB} MiB each.`,
  );

const readStdinImage = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const chunks = yield* stdio.stdin.pipe(
    Stream.runCollect,
    Effect.mapError(() => new ThreadImageError({ detail: "Could not read the image from stdin." })),
  );
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const mimeType = inferImageMimeType(bytes);
  return {
    label: "stdin",
    name: `image${mimeType ? EXTENSION_BY_MIME_TYPE[mimeType] : ""}`,
    bytes,
  };
});

const readFileImage = Effect.fn("cli.thread.readImageFile")(function* (file: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const unreadable = (cause: { readonly message: string }) =>
    new ThreadImageError({ detail: `Could not read '${file}': ${cause.message}` });
  const info = yield* fileSystem.stat(file).pipe(Effect.mapError(unreadable));
  if (info.type !== "File") return yield* fail(`'${file}' is not a file.`);
  // Checked before reading, so a huge file is refused without loading it.
  if (Number(info.size) > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
    return yield* tooLarge(file, Number(info.size));
  }
  const bytes = yield* fileSystem.readFile(file).pipe(Effect.mapError(unreadable));
  return { label: file, name: path.basename(file), bytes };
});

/**
 * Reads and checks every --image before anything is uploaded or sent. Stdin
 * has one reader, so `-` serves the message or one image, never both.
 */
export const readCliImages = Effect.fn("cli.thread.readImages")(function* (
  images: ReadonlyArray<string>,
  message: string,
) {
  const fromStdin = images.filter((image) => image === "-").length;
  if (fromStdin > 1) return yield* fail("Only one --image can read from stdin.");
  if (fromStdin === 1 && message === "-") {
    return yield* fail(
      "The message and --image - cannot both read stdin. Pass the message as an argument or the image as a file.",
    );
  }
  if (images.length > MAX_IMAGES) {
    return yield* fail(`You can attach up to ${MAX_IMAGES} images per message.`);
  }
  const checked: Array<CliImage> = [];
  for (const image of images) {
    const { label, name, bytes } =
      image === "-" ? yield* readStdinImage : yield* readFileImage(image);
    if (bytes.byteLength === 0) return yield* fail(`'${label}' is empty.`);
    if (bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      return yield* tooLarge(label, bytes.byteLength);
    }
    const mimeType = inferImageMimeType(bytes);
    if (mimeType === undefined) {
      return yield* fail(
        `'${label}' is not a PNG, JPEG, WebP, or GIF image. Its contents decide, not its file name.`,
      );
    }
    checked.push({ name, mimeType, bytes });
  }
  const limitError = getProviderAttachmentLimitError(
    checked.map((image) => ({
      type: "image",
      mimeType: image.mimeType,
      sizeBytes: image.bytes.byteLength,
    })),
  );
  if (limitError !== undefined) return yield* fail(limitError);
  return checked;
});

export type PostImage = (url: string, image: CliImage) => Effect.Effect<void, string>;

/** The signed upload URL is its own credential, as for the web composer's upload. */
const postImage: PostImage = Effect.fn("cli.thread.postImage")(function* (
  url: string,
  image: CliImage,
) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .execute(
      HttpClientRequest.post(url).pipe(
        HttpClientRequest.bodyUint8Array(image.bytes, image.mimeType),
      ),
    )
    .pipe(Effect.mapError((error) => error.message));
  if (response.status >= 200 && response.status < 300) return;
  const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
  return yield* Effect.fail(`${response.status} ${text.trim()}`.trim());
}, Effect.provide(FetchHttpClient.layer));

/** Stages one image as a pending upload, the same path the composer uses. */
const stageImage = Effect.fn("cli.thread.stageImage")(function* (
  tools: ThreadTools,
  origin: string,
  image: CliImage,
  post: PostImage,
  staged: Array<string>,
) {
  const sizeBytes = image.bytes.byteLength;
  const minted = yield* tools.call(
    "t3_attachment_prepare_upload",
    { upload: { type: "image", name: image.name, mimeType: image.mimeType, sizeBytes } },
    AttachmentCreateUploadUrlResult,
  );
  staged.push(minted.attachmentId);
  yield* post(new URL(minted.relativeUrl, origin).href, image).pipe(
    Effect.mapError(
      (reason) => new ThreadImageError({ detail: `Could not upload '${image.name}': ${reason}` }),
    ),
  );
  return {
    type: "image" as const,
    id: minted.attachmentId,
    name: image.name,
    mimeType: image.mimeType,
    sizeBytes,
  };
});

const discardStaged = (tools: ThreadTools, staged: ReadonlyArray<string>) =>
  Effect.forEach(
    staged,
    (attachmentId) =>
      tools.call("t3_attachment_discard", { attachmentId }, Schema.Struct({})).pipe(Effect.ignore),
    { discard: true },
  );

/**
 * Uploads the images, then calls `tool` with them as `attachments`. If any
 * step fails, every upload staged so far is discarded instead of waiting for
 * the server's 24-hour sweep.
 */
export const callWithImages = <S extends Schema.Decoder<unknown>>(
  tools: ThreadTools,
  origin: string,
  images: ReadonlyArray<CliImage>,
  tool: string,
  args: Readonly<Record<string, unknown>>,
  schema: S,
  post: PostImage = postImage,
) => {
  const staged: Array<string> = [];
  return Effect.forEach(images, (image) => stageImage(tools, origin, image, post, staged)).pipe(
    Effect.flatMap((attachments) =>
      tools.call(tool, attachments.length > 0 ? { ...args, attachments } : args, schema),
    ),
    Effect.onError(() => discardStaged(tools, staged)),
  );
};

const AttachmentSendResult = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  runId: RunId,
  status: OrchestrationV2RunStatus,
});

/**
 * A text-only send queues behind a busy turn. t3_thread_send_attachments has
 * no queue mode, so a send with images is delivered into the running turn.
 */
export const sendThreadMessage = Effect.fn("cli.thread.sendMessage")(function* (
  tools: ThreadTools,
  origin: string,
  input: {
    readonly threadId: ThreadId;
    readonly message: string;
    readonly images: ReadonlyArray<CliImage>;
  },
  post: PostImage = postImage,
) {
  const { threadId, message, images } = input;
  if (images.length === 0) {
    return yield* tools.call(
      "t3_thread_send",
      { threadId, message, mode: "queue" },
      OrchestratorMcpThreadSendResult,
    );
  }
  const sent = yield* callWithImages(
    tools,
    origin,
    images,
    "t3_thread_send_attachments",
    { threadId, message },
    AttachmentSendResult,
    post,
  );
  const result: typeof AttachmentSendResult.Type & { readonly delivery?: "queued" } =
    sent.status === "queued" ? { ...sent, delivery: "queued" } : sent;
  return result;
});
