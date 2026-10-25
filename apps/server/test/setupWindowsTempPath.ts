// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

/**
 * Windows points `TEMP` and `TMP` at the 8.3 short profile path when the account name has a space,
 * while git, `realpath.native` and services under test report the long form, so path comparisons
 * fail on spelling alone. Resolving both once, before any test, makes them agree. Only Windows is
 * touched, so macOS keeps the `/var/folders` symlink it normally reports.
 */
// oxlint-disable-next-line t3code/no-global-process-runtime -- Setup file runs before any Effect runtime exists.
if (process.platform === "win32") {
  const resolved = NodeFS.realpathSync.native(NodeOS.tmpdir());
  process.env["TEMP"] = resolved;
  process.env["TMP"] = resolved;
}
