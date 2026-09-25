// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import {
  checkAttachedWorktree,
  isInsideDirectory,
  isInsideT3WorktreesDir,
  refuseAttachedWorktreeRemoval,
} from "./attachedWorktrees.ts";

const tempDir = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-attached-"));

const layer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-attached-config-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

it.effect("tells T3's own worktrees from attached ones, even when missing", () =>
  Effect.gen(function* () {
    const { worktreesDir } = yield* ServerConfig.ServerConfig;
    expect(yield* isInsideT3WorktreesDir(NodePath.join(worktreesDir, "repo", "gone"))).toBe(true);
    expect(yield* isInsideT3WorktreesDir(worktreesDir)).toBe(false);
    expect(yield* isInsideT3WorktreesDir(NodePath.join(tempDir(), "lane"))).toBe(false);
    expect(yield* isInsideT3WorktreesDir(`${worktreesDir}-sibling`)).toBe(false);
  }).pipe(Effect.provide(layer)),
);

it.effect("compares paths without regard to case or slash direction on Windows", () =>
  Effect.gen(function* () {
    // A root that does not exist compares by its normalized absolute path,
    // so this holds on any host once the platform says Windows.
    const root = NodePath.join(tempDir(), "Missing-Root");
    const child = NodePath.join(root, "Lane").toUpperCase().replaceAll("\\", "/");
    expect(yield* isInsideDirectory(root, child)).toBe(true);
  }).pipe(Effect.provideService(HostProcessPlatform, "win32"), Effect.provide(NodeServices.layer)),
);

it.effect("refuses to remove a worktree outside T3's own dir", () =>
  Effect.gen(function* () {
    const { worktreesDir } = yield* ServerConfig.ServerConfig;
    const outside = NodePath.join(tempDir(), "lane");
    const refused = yield* refuseAttachedWorktreeRemoval({ cwd: "/repo", path: outside }).pipe(
      Effect.flip,
    );
    expect(refused.detail).toBe(
      `T3 only deletes worktrees it created; ${outside} was left in place.`,
    );
    yield* refuseAttachedWorktreeRemoval({
      cwd: "/repo",
      path: NodePath.join(worktreesDir, "repo", "t3code-1234"),
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("accepts only a listed worktree with the named branch checked out", () =>
  Effect.gen(function* () {
    const projectRoot = tempDir();
    const lane = tempDir();
    const file = NodePath.join(lane, "file.txt");
    NodeFS.writeFileSync(file, "");
    // Git reports forward slashes on Windows; the caller may not.
    const gitReported = lane.replaceAll("\\", "/");
    const worktrees = [
      { branch: "main", path: projectRoot },
      { branch: "lane/T-1", path: gitReported },
    ];
    const check = (path: string, branch = "lane/T-1") =>
      checkAttachedWorktree({ projectRoot, path, branch, worktrees });

    expect(yield* check(NodePath.join(lane, "missing"))).toMatchObject({
      ok: false,
      detail: expect.stringContaining("does not exist"),
    });
    expect(yield* check(file)).toMatchObject({
      ok: false,
      detail: expect.stringContaining("is not a directory"),
    });
    expect(yield* check(projectRoot, "main")).toMatchObject({
      ok: false,
      detail: expect.stringContaining("project's own checkout"),
    });
    expect(yield* check(tempDir())).toMatchObject({
      ok: false,
      detail: expect.stringContaining("does not list"),
    });
    expect(yield* check(lane, "lane/T-2")).toMatchObject({
      ok: false,
      detail: expect.stringContaining("has lane/T-1 checked out, not lane/T-2"),
    });
    expect(yield* check(`${lane}${NodePath.sep}`)).toEqual({
      ok: true,
      branch: "lane/T-1",
      worktreePath: gitReported,
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);
