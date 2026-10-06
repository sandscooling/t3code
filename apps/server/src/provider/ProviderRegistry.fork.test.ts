// Fork tests for ProviderRegistry.test.ts.
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CodexInstallation from "./CodexInstallation.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ClaudeSettings, EnvironmentId, type ServerProviderSlashCommand } from "@t3tools/contracts";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import { checkClaudeProviderStatus } from "./ClaudeProvider.ts";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  getClaudeCatalogModelCapabilities,
} from "./ClaudeModelCatalog.ts";
import * as ModelManifest from "./ModelManifest.ts";
import * as ServerSettingsModule from "../serverSettings.ts";

const defaultClaudeSettings: ClaudeSettings = Schema.decodeSync(ClaudeSettings)({});

const encoder = new TextEncoder();

// Provider metadata checks use a bundled manifest and stubbed HTTP.
const TestHttpClientLive = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
).pipe(Layer.provideMerge(ModelManifest.layerTest));

type TestClaudeCapabilities = {
  readonly email: string | undefined;
  readonly subscriptionType: string | undefined;
  readonly tokenSource: string | undefined;
  readonly apiProvider: string | undefined;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly outputStyles: ReadonlyArray<string>;
};

function claudeCapabilities(overrides: Partial<TestClaudeCapabilities> = {}) {
  return () =>
    Effect.succeed({
      email: undefined,
      subscriptionType: undefined,
      tokenSource: undefined,
      apiProvider: undefined,
      slashCommands: [],
      outputStyles: [],
      ...overrides,
    });
}

function mockHandle(result: { stdout: string; stderr: string; code: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout)),
    stderr: Stream.make(encoder.encode(result.stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockSpawnerLayer(
  handler: (args: ReadonlyArray<string>) => {
    stdout: string;
    stderr: string;
    code: number;
  },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as { args: ReadonlyArray<string> };
      return Effect.succeed(mockHandle(handler(cmd.args)));
    }),
  );
}

const TestNodeServices = Layer.mergeAll(
  NodeServices.layer,
  Layer.mock(CodexInstallation.CodexInstallation)({
    managedDirectory: "unused-managed-installation",
  }),
  Layer.mock(ServerSecretStore.ServerSecretStore)({}),
  Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
    getEnvironmentId: Effect.succeed(EnvironmentId.make("00000000-0000-4000-8000-000000000001")),
  }),
);

it.layer(Layer.mergeAll(TestNodeServices, ServerSettingsModule.layerTest(), TestHttpClientLive))(
  "ProviderRegistry",
  (it) => {
    describe("checkClaudeProviderStatus", () => {
      it.effect("publishes reported output styles as a trait on every model", () =>
        Effect.gen(function* () {
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities({ outputStyles: ["default", "Explanatory", "Team Voice"] }),
          );
          assert.ok(status.models.length > 0);
          for (const model of status.models) {
            const descriptors = model.capabilities?.optionDescriptors ?? [];
            const descriptor = descriptors.find((entry) => entry.id === "outputStyle");
            assert.ok(descriptor, `${model.slug} is missing the output style trait`);
            assert.strictEqual(descriptor.type, "select");
            assert.deepEqual(
              descriptor.type === "select" ? descriptor.options.map((option) => option.id) : [],
              ["default", "Explanatory", "Team Voice"],
            );
            // Appended last, never inserted: clients read the first select
            // descriptor as reasoning effort. Haiku advertises no select trait
            // of its own, so output style does land first there and the client
            // guard, not descriptor order, is what keeps it out of that slot.
            assert.strictEqual(descriptors.at(-1)?.id, "outputStyle");
            assert.deepEqual(
              descriptors.slice(0, -1).map((entry) => entry.id),
              (
                getClaudeCatalogModelCapabilities(BUNDLED_CLAUDE_MODEL_CATALOG, model.slug)
                  .optionDescriptors ?? []
              ).map((entry) => entry.id),
            );
          }
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );

      it.effect("leaves the output style trait off when only the default exists", () =>
        Effect.gen(function* () {
          // A lone "default" means no styles are installed; a one-choice picker
          // would be a control that can never change anything.
          const status = yield* checkClaudeProviderStatus(
            defaultClaudeSettings,
            claudeCapabilities({ outputStyles: ["default"] }),
          );
          assert.ok(status.models.length > 0);
          for (const model of status.models) {
            assert.ok(
              !(model.capabilities?.optionDescriptors ?? []).some(
                (entry) => entry.id === "outputStyle",
              ),
            );
          }
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      );
    });
  },
);
