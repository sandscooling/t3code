import { describe, expect, it } from "vite-plus/test";

import {
  buildOrchestratorColorMenuItem,
  orchestratorThreadIds,
  parseOrchestratorColorMenuId,
  withOrchestratorColor,
} from "./orchestratorColor.logic";

describe("orchestratorThreadIds", () => {
  it("counts only top-level threads that spawned a session", () => {
    const ids = orchestratorThreadIds([
      { id: "orchestrator", spawnedByThreadId: null },
      { id: "dev", spawnedByThreadId: "orchestrator" },
      { id: "helper", spawnedByThreadId: "dev" },
      { id: "lone", spawnedByThreadId: null },
      { id: "legacy" },
    ]);
    expect([...ids]).toEqual(["orchestrator"]);
  });

  it("counts a spawner created in v2, whose own spawnedByThreadId key is absent", () => {
    const ids = orchestratorThreadIds([{ id: "boss" }, { id: "dev", spawnedByThreadId: "boss" }]);
    expect([...ids]).toEqual(["boss"]);
  });

  it("counts a top-level thread titled Orchestrator even with no spawned sessions", () => {
    const ids = orchestratorThreadIds([
      { id: "named", title: "Orchestrator", spawnedByThreadId: null },
      { id: "retired", title: "Orchestrator-2026-09-28", spawnedByThreadId: null },
      { id: "nested", title: "Orchestrator", spawnedByThreadId: "named" },
    ]);
    expect([...ids]).toEqual(["named"]);
  });
});

describe("orchestrator color menu", () => {
  it("checks the current tint, or None when there is none", () => {
    const checked = (current: Parameters<typeof buildOrchestratorColorMenuItem>[0]) =>
      buildOrchestratorColorMenuItem(current)
        .children?.filter((item) => item.checked)
        .map((item) => item.id);
    expect(checked("teal")).toEqual(["orchestrator-color:teal"]);
    expect(checked(null)).toEqual(["orchestrator-color:none"]);
  });

  it("reads a color, None, or an id that is not its own", () => {
    expect(parseOrchestratorColorMenuId("orchestrator-color:violet")).toBe("violet");
    expect(parseOrchestratorColorMenuId("orchestrator-color:none")).toBe(null);
    expect(parseOrchestratorColorMenuId("orchestrator-color:chartreuse")).toBe(undefined);
    expect(parseOrchestratorColorMenuId("rename")).toBe(undefined);
  });
});

describe("withOrchestratorColor", () => {
  it("sets every member project and clears them with null", () => {
    const set = withOrchestratorColor({ other: "red" }, ["a", "b"], "blue");
    expect(set).toEqual({ other: "red", a: "blue", b: "blue" });
    expect(withOrchestratorColor(set, ["a", "b"], null)).toEqual({ other: "red" });
  });
});
