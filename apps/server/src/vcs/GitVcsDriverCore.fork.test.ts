// Fork tests for GitVcsDriverCore.test.ts.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, describe } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";

import { GitCommandError } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-git-vcs-driver-test-",
});
const TestLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);

const makeTmpDir = (
  prefix = "git-vcs-driver-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });

const writeTextFile = (
  cwd: string,
  relativePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const filePath = pathService.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(pathService.dirname(filePath), { recursive: true });
    yield* fileSystem.writeFileString(filePath, contents);
  });

const git = (
  cwd: string,
  args: ReadonlyArray<string>,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<string, GitCommandError, GitVcsDriver.GitVcsDriver> =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "GitVcsDriver.test.git",
      cwd,
      args,
      ...(env ? { env } : {}),
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

const initRepoWithCommit = (
  cwd: string,
): Effect.Effect<
  { readonly initialBranch: string },
  GitCommandError | PlatformError.PlatformError,
  GitVcsDriver.GitVcsDriver | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.initRepo({ cwd });
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* writeTextFile(cwd, "README.md", "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
    const initialBranch = yield* git(cwd, ["branch", "--show-current"]);
    return { initialBranch };
  });

it.layer(TestLayer)("GitVcsDriver core integration", (it) => {
  describe("remote operations", () => {
    it.effect("ensureRemote reuses a remote whose url is a local path with spaces", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const driver = yield* GitVcsDriver.GitVcsDriver;

        // `git remote -v` separates name, url and direction with whitespace, so
        // a url that itself contains a space is only recoverable by anchoring on
        // the trailing "(fetch)". Parsing the url as a run of non-whitespace
        // dropped such remotes without a trace, and callers then behaved as
        // though the remote was absent: this call invented a second remote
        // instead of reusing origin. Local paths with spaces are ordinary, from
        // "C:\Users\First Last" to "~/My Projects".
        const remoteParent = yield* makeTmpDir("git-vcs-driver-spaced remote-");
        const remotePath = pathService.join(remoteParent, "bare repo.git");
        yield* fileSystem.makeDirectory(remotePath, { recursive: true });
        yield* git(remotePath, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remotePath]);

        const reused = yield* driver.ensureRemote({
          cwd,
          preferredName: "upstream",
          url: remotePath,
        });

        assert.equal(reused, "origin");
        assert.equal(yield* git(cwd, ["remote"]), "origin");
      }),
    );
  });
});
