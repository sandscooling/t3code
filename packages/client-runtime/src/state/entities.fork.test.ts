// The fork's tests for entities.test.ts.
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { presentThreadShell } from "./models.ts";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";

const environmentId = EnvironmentId.make("environment-v2");

describe("V2 client presentation", () => {
  // Fork: lane, spawn lineage and successor reach the client only when sent.
  it("copies the fork's session fields when present and leaves them absent otherwise", () => {
    const shell = presentThreadShell(environmentId, {
      ...v2ThreadShell,
      group: "v2-web-sidebar",
      spawnedByThreadId: ThreadId.make("thread-orchestrator"),
      successorThreadId: null,
    });
    expect(shell.group).toBe("v2-web-sidebar");
    expect(shell.spawnedByThreadId).toBe("thread-orchestrator");
    expect(shell.successorThreadId).toBeNull();

    const bare = presentThreadShell(environmentId, v2ThreadShell);
    for (const key of ["group", "spawnedByThreadId", "successorThreadId"]) {
      expect(bare).not.toHaveProperty(key);
    }
  });
});
