// The fork's tests for settings.test.ts.
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ClientSettingsSchema, ClientSettingsPatch } from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);

describe("ClientSettings sidebar project groups", () => {
  it("keeps the flat sidebar by default and accepts grouping by project", () => {
    expect(decodeClientSettings({}).sidebarGroupThreadsByProject).toBe(false);
    expect(
      decodeClientSettings({ sidebarGroupThreadsByProject: true }).sidebarGroupThreadsByProject,
    ).toBe(true);
    expect(
      decodeClientSettingsPatch({ sidebarGroupThreadsByProject: true })
        .sidebarGroupThreadsByProject,
    ).toBe(true);
  });
});

describe("ClientSettings orchestrator colors", () => {
  it("starts with no tints and keeps a chosen one per project", () => {
    expect(decodeClientSettings({}).sidebarOrchestratorColors).toEqual({});
    const colors = { "env-1:/work/fleet": "teal" as const };
    expect(
      decodeClientSettings({ sidebarOrchestratorColors: colors }).sidebarOrchestratorColors,
    ).toEqual(colors);
    expect(
      decodeClientSettingsPatch({ sidebarOrchestratorColors: colors }).sidebarOrchestratorColors,
    ).toEqual(colors);
  });
});
