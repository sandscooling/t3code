// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/**
 * Writes a fake CLI that tests put on `PATH` so production code spawns it
 * instead of the real provider binary.
 *
 * POSIX gets exactly the `#!/bin/sh` wrapper these tests have always written,
 * so nothing about that path changes. Windows cannot execute an extensionless
 * shell script: the spawn fails with `EFTYPE` before the fake ever runs, which
 * is why every test built on this pattern failed there. Windows instead gets a
 * `.cmd` file, which `PATHEXT` makes directly executable, delegating to a
 * generated Node launcher. Keeping the Windows-side logic in JavaScript rather
 * than batch avoids `cmd.exe` quoting rules, which mangle the JSON and
 * tab-delimited argv these tests assert on.
 */
export async function writeFakeExecutable(options: {
  /** Directory to write into. Created if absent. */
  readonly directory: string;
  /** Base name without extension; the platform suffix is appended. */
  readonly name: string;
  /** Interpreter to exec, normally `process.execPath`. */
  readonly command: string;
  /** Arguments placed before the caller's own argv. */
  readonly args: ReadonlyArray<string>;
  /** Environment exported to the spawned process. */
  readonly env?: Record<string, string> | undefined;
  /** Appends the received argv, tab separated and newline terminated. */
  readonly argvLogPath?: string | undefined;
  /** Stalls before exec, to exercise startup timeouts. */
  readonly initialDelaySeconds?: number | undefined;
}): Promise<string> {
  const { directory, name, command, args, env, argvLogPath, initialDelaySeconds } = options;
  await NodeFSP.mkdir(directory, { recursive: true });

  if (process.platform !== "win32") {
    const wrapperPath = NodePath.join(directory, `${name}.sh`);
    const lines = ["#!/bin/sh"];
    if (argvLogPath) {
      lines.push(
        `printf '%s\\t' "$@" >> ${JSON.stringify(argvLogPath)}`,
        `printf '\\n' >> ${JSON.stringify(argvLogPath)}`,
      );
    }
    for (const [key, value] of Object.entries(env ?? {})) {
      lines.push(`export ${key}=${JSON.stringify(value)}`);
    }
    if (initialDelaySeconds) {
      lines.push(`sleep ${JSON.stringify(String(initialDelaySeconds))}`);
    }
    lines.push(
      `exec ${JSON.stringify(command)} ${args.map((arg) => JSON.stringify(arg)).join(" ")} "$@"`,
      "",
    );
    await NodeFSP.writeFile(wrapperPath, lines.join("\n"), "utf8");
    await NodeFSP.chmod(wrapperPath, 0o755);
    return wrapperPath;
  }

  const launcherPath = NodePath.join(directory, `${name}.launcher.mjs`);
  // `spawnSync` with `stdio: "inherit"` keeps the fake transparent: the parent's
  // pipes reach the mock agent unchanged, which the ACP tests depend on.
  const launcher = `import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const forwarded = process.argv.slice(2);
${
  argvLogPath
    ? `appendFileSync(${JSON.stringify(argvLogPath)}, forwarded.map((arg) => arg + "\\t").join("") + "\\n");\n`
    : ""
}${
    initialDelaySeconds
      ? `await new Promise((resolve) => setTimeout(resolve, ${Math.round(initialDelaySeconds * 1000)}));\n`
      : ""
  }const result = spawnSync(${JSON.stringify(command)}, [...${JSON.stringify(args)}, ...forwarded], {
  stdio: "inherit",
  env: { ...process.env, ...${JSON.stringify(env ?? {})} },
});
process.exit(result.status ?? 1);
`;
  await NodeFSP.writeFile(launcherPath, launcher, "utf8");

  const wrapperPath = NodePath.join(directory, `${name}.cmd`);
  // `%*` forwards argv with quoting intact; the launcher path is quoted because
  // temp directories under a profile name with a space are routine on Windows.
  const wrapper = `@echo off\r\n"${process.execPath}" "${launcherPath}" %*\r\n`;
  await NodeFSP.writeFile(wrapperPath, wrapper, "utf8");
  return wrapperPath;
}

/**
 * Writes a fake CLI that only prints and exits, for tests that probe a
 * provider's version or capabilities rather than drive a session.
 *
 * The POSIX body is used verbatim, so those platforms keep the exact script
 * they had. Windows cannot exec it, so callers supply the equivalent as Node
 * source, which runs behind a `.cmd`. Translating shell to batch automatically
 * is not worth the quoting risk, and an explicit pair keeps both behaviours
 * visible at the call site.
 */
export async function writeFakeScript(options: {
  readonly directory: string;
  /** Base name. POSIX keeps it bare so `PATH` lookup by command name works. */
  readonly name: string;
  /** Shell body, including the `#!/bin/sh` line. */
  readonly sh: string;
  /** Node source; reads arguments from `process.argv.slice(2)`. */
  readonly mjs: string;
}): Promise<string> {
  const { directory, name, sh, mjs } = options;
  await NodeFSP.mkdir(directory, { recursive: true });

  if (process.platform !== "win32") {
    const scriptPath = NodePath.join(directory, name);
    await NodeFSP.writeFile(scriptPath, sh, "utf8");
    await NodeFSP.chmod(scriptPath, 0o755);
    return scriptPath;
  }

  const implPath = NodePath.join(directory, `${name}.impl.mjs`);
  await NodeFSP.writeFile(implPath, mjs, "utf8");
  const scriptPath = NodePath.join(directory, `${name}.cmd`);
  await NodeFSP.writeFile(
    scriptPath,
    `@echo off\r\n"${process.execPath}" "${implPath}" %*\r\n`,
    "utf8",
  );
  return scriptPath;
}
