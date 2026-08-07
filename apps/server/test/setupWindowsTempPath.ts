// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

/**
 * Windows points `TEMP` and `TMP` at the 8.3 short form of the profile
 * directory whenever the account name contains a space, so `os.tmpdir()` hands
 * back something like `C:\Users\KEVINL~1\AppData\Local\Temp`. Anything that
 * canonicalises a path instead reports the long form: git, `realpath.native`,
 * and several of the services under test. A test that builds a path from
 * `os.tmpdir()` and compares it against a path the code resolved then fails on
 * spelling alone, with two strings that name the same directory.
 *
 * Resolving both variables once, before any test runs, makes the two sides
 * agree without touching a single assertion. Only Windows is adjusted: no other
 * platform has short names, and leaving their environment untouched keeps
 * `os.tmpdir()` returning exactly what it returns today. In particular macOS is
 * left with the `/var/folders` symlink it normally reports rather than being
 * silently moved to `/private/var/folders`.
 */
// oxlint-disable-next-line t3code/no-global-process-runtime -- Setup file runs before any Effect runtime exists.
if (process.platform === "win32") {
  const resolved = NodeFS.realpathSync.native(NodeOS.tmpdir());
  process.env["TEMP"] = resolved;
  process.env["TMP"] = resolved;
}
