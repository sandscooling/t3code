import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

import { type ThreadTools, ThreadToolFailedError } from "./thread.ts";
import { type CliImage, readCliImages, sendThreadMessage } from "./threadAttachments.fork.ts";

const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13);
const GIF = new TextEncoder().encode("GIF89a");
// What a HEIC, BMP or text file renamed to .png looks like to the sniffer.
const UNKNOWN = Uint8Array.of(1, 2, 3, 4);

const stdinOf = (bytes: Uint8Array) =>
  Stdio.make({
    args: Effect.succeed([]),
    stdout: () => Sink.drain,
    stderr: () => Sink.drain,
    stdin: Stream.make(bytes.subarray(0, 4), bytes.subarray(4)),
  });

const errorDetail = <A, R>(effect: Effect.Effect<A, { readonly detail: string }, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.detail),
  );

it.layer(NodeServices.layer)("t3 thread --image", (it) => {
  it.effect("refuses a second stdin reader before reading anything", () =>
    Effect.gen(function* () {
      assert.match(yield* errorDetail(readCliImages(["-"], "-")), /cannot both read stdin/);
      assert.match(
        yield* errorDetail(readCliImages(["-", "-"], "hello")),
        /Only one --image can read from stdin/,
      );
    }).pipe(Effect.provideService(Stdio.Stdio, stdinOf(PNG))),
  );

  it.effect("checks the count, sizes and types before any upload", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-thread-image-" });
      // Paths that do not exist prove the count is checked before any read.
      assert.match(
        yield* errorDetail(
          readCliImages(
            Array.from({ length: 9 }, (_, index) => path.join(dir, `missing-${index}.png`)),
            "hello",
          ),
        ),
        /up to 8 images per message/,
      );

      const huge = path.join(dir, "huge.png");
      yield* fs.writeFile(huge, new Uint8Array(10 * 1024 * 1024 + 1));
      assert.match(yield* errorDetail(readCliImages([huge], "hello")), /up to 10 MiB each/);

      const renamed = path.join(dir, "renamed.png");
      yield* fs.writeFile(renamed, UNKNOWN);
      assert.match(
        yield* errorDetail(readCliImages([renamed], "hello")),
        /is not a PNG, JPEG, WebP, or GIF image/,
      );

      const empty = path.join(dir, "empty.png");
      yield* fs.writeFile(empty, new Uint8Array());
      assert.match(yield* errorDetail(readCliImages([empty], "hello")), /is empty/);

      const misnamed = path.join(dir, "shot.jpg");
      yield* fs.writeFile(misnamed, PNG);
      const images = yield* readCliImages([misnamed, "-"], "hello");
      assert.deepStrictEqual(
        images.map(({ name, mimeType, bytes }) => ({ name, mimeType, bytes: [...bytes] })),
        [
          { name: "shot.jpg", mimeType: "image/png", bytes: [...PNG] },
          { name: "image.png", mimeType: "image/png", bytes: [...PNG] },
        ],
      );
    }).pipe(Effect.scoped, Effect.provideService(Stdio.Stdio, stdinOf(PNG))),
  );
});

const threadId = ThreadId.make("thread-1");
const images: Array<CliImage> = [
  { name: "a.png", mimeType: "image/png", bytes: PNG },
  { name: "b.gif", mimeType: "image/gif", bytes: GIF },
];
const ids = ["pending-a", "pending-b"];

const upload = (image: CliImage) => ({
  type: "image",
  name: image.name,
  mimeType: image.mimeType,
  sizeBytes: image.bytes.byteLength,
});
const prepareCall = (index: number) => [
  "t3_attachment_prepare_upload",
  { upload: upload(images[index]!) },
];
const postCall = (index: number) => ["post", `/api/attachments/upload/${ids[index]}.sig`];
const discardCall = (index: number) => ["t3_attachment_discard", { attachmentId: ids[index] }];
const sendAttachmentsCall = [
  "t3_thread_send_attachments",
  {
    threadId,
    message: "look",
    attachments: images.map((image, index) => ({ ...upload(image), id: ids[index] })),
  },
];
const isToolFailure = Schema.is(ThreadToolFailedError);
const sendRejected = new ThreadToolFailedError({
  tool: "t3_thread_send_attachments",
  detail: "Thread not found.",
});

const sendCases = [
  {
    name: "a text-only send still queues through t3_thread_send",
    images: [],
    failPost: undefined,
    sendResult: { threadId, messageId: "m", runId: "r", status: "queued", delivery: "queued" },
    expected: [["t3_thread_send", { threadId, message: "look", mode: "queue" }]],
    error: undefined,
  },
  {
    name: "a send with images uploads each one and sends them as attachments",
    images,
    failPost: undefined,
    sendResult: { threadId, messageId: "m", runId: "r", status: "queued" },
    expected: [prepareCall(0), postCall(0), prepareCall(1), postCall(1), sendAttachmentsCall],
    error: undefined,
  },
  {
    name: "a failed upload discards every image staged so far and sends nothing",
    images,
    failPost: "b.gif",
    sendResult: undefined,
    expected: [
      prepareCall(0),
      postCall(0),
      prepareCall(1),
      postCall(1),
      discardCall(0),
      discardCall(1),
    ],
    error: "Could not upload 'b.gif': 400 Body was 0 bytes, expected 6.",
  },
  {
    name: "a refused send discards the uploads it carried",
    images,
    failPost: undefined,
    sendResult: sendRejected,
    expected: [
      prepareCall(0),
      postCall(0),
      prepareCall(1),
      postCall(1),
      sendAttachmentsCall,
      discardCall(0),
      discardCall(1),
    ],
    error: "Thread not found.",
  },
];

it.effect.each(sendCases)("$name", (testCase) =>
  Effect.gen(function* () {
    const log: Array<Array<unknown>> = [];
    const responses: Record<string, Array<unknown>> = {
      t3_attachment_prepare_upload: ids.map((id) => ({
        attachmentId: id,
        relativeUrl: `/api/attachments/upload/${id}.sig`,
        expiresAt: 1,
      })),
      t3_attachment_discard: [{}, {}],
      t3_thread_send: [testCase.sendResult],
      t3_thread_send_attachments: [testCase.sendResult],
    };
    const tools = {
      call: ((tool: string, args: unknown) => {
        log.push([tool, args]);
        const next = responses[tool]?.shift();
        if (isToolFailure(next)) return Effect.fail(next);
        return next === undefined ? Effect.die(`unscripted ${tool} call`) : Effect.succeed(next);
      }) as ThreadTools["call"],
    } satisfies ThreadTools;

    const outcome = yield* sendThreadMessage(
      tools,
      "http://127.0.0.1:3773",
      { threadId, message: "look", images: testCase.images },
      (url, image) =>
        Effect.suspend(() => {
          log.push(["post", new URL(url).pathname]);
          return image.name === testCase.failPost
            ? Effect.fail("400 Body was 0 bytes, expected 6.")
            : Effect.void;
        }),
    ).pipe(Effect.result);

    assert.deepStrictEqual(log, testCase.expected);
    if (outcome._tag === "Success") {
      assert.isUndefined(testCase.error);
      assert.strictEqual(outcome.success.delivery, "queued");
    } else {
      assert.strictEqual(outcome.failure.message, testCase.error);
    }
  }),
);
