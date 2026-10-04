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

  describe("a thread spawned from another project", () => {
    const at = (projectId: string) => ({ environmentId: "env", projectId });

    it("is an orchestrator when titled Orchestrator", () => {
      const ids = orchestratorThreadIds([
        { id: "home", ...at("t3code"), title: "Other", spawnedByThreadId: null },
        { id: "fleet", ...at("fleet"), title: "Orchestrator", spawnedByThreadId: "home" },
      ]);
      expect(ids.has("fleet")).toBe(true);
    });

    it("is an orchestrator when it spawned sessions in its own project", () => {
      const ids = orchestratorThreadIds([
        { id: "home", ...at("t3code"), spawnedByThreadId: null },
        { id: "fleet", ...at("fleet"), title: "Recovered", spawnedByThreadId: "home" },
        { id: "probe", ...at("fleet"), spawnedByThreadId: "fleet" },
      ]);
      expect(ids.has("fleet")).toBe(true);
      expect(ids.has("probe")).toBe(false);
    });

    it("leaves a same-project worker as crew, even one titled Orchestrator", () => {
      const ids = orchestratorThreadIds([
        { id: "boss", ...at("fleet"), spawnedByThreadId: null },
        { id: "worker", ...at("fleet"), title: "Orchestrator", spawnedByThreadId: "boss" },
      ]);
      expect([...ids]).toEqual(["boss"]);
    });

    it("is top-level when its spawner is no longer listed", () => {
      const ids = orchestratorThreadIds([
        { id: "orphan", ...at("fleet"), title: "Orchestrator", spawnedByThreadId: "gone" },
      ]);
      expect([...ids]).toEqual(["orphan"]);
    });
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
