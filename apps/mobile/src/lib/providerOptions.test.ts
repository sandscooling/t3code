import { describe, expect, it } from "vite-plus/test";

import type { ModelCapabilities } from "@t3tools/contracts";

import {
  applyProviderOptionSelection,
  providerOptionValueLabels,
  resolveProviderOptionDescriptors,
} from "./providerOptions";

const CODEX_CAPABILITIES: ModelCapabilities = {
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "medium", label: "Medium", isDefault: true },
        { id: "high", label: "High" },
      ],
      currentValue: "medium",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        { id: "priority", label: "Fast" },
      ],
      currentValue: "default",
    },
  ],
};

const CLAUDE_OUTPUT_STYLE_CAPABILITIES: ModelCapabilities = {
  optionDescriptors: [
    {
      id: "effort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "high", label: "High", isDefault: true },
        { id: "max", label: "Max" },
      ],
      currentValue: "high",
    },
    {
      id: "outputStyle",
      label: "Output Style",
      type: "select",
      options: [
        { id: "default", label: "Default", isDefault: true },
        { id: "Explanatory", label: "Explanatory" },
      ],
      currentValue: "default",
    },
  ],
};

describe("mobile provider options", () => {
  it("summarizes the option values currently in effect", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: CODEX_CAPABILITIES,
      selections: undefined,
    });

    expect(providerOptionValueLabels(descriptors)).toEqual(["Medium", "Standard"]);
  });

  it("updates generic select options without knowing provider-specific ids", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: CODEX_CAPABILITIES,
      selections: undefined,
    });

    expect(
      applyProviderOptionSelection(descriptors, { id: "serviceTier", value: "priority" }),
    ).toEqual([
      { id: "reasoningEffort", value: "medium" },
      { id: "serviceTier", value: "priority" },
    ]);
    // Choices the model doesn't advertise are rejected, not stored.
    expect(
      applyProviderOptionSelection(descriptors, { id: "serviceTier", value: "turbo" }),
    ).toBeNull();
    expect(applyProviderOptionSelection(descriptors, { id: "unknown", value: "high" })).toBeNull();
  });

  it("treats an unspecified boolean capability as off", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: {
        optionDescriptors: [{ id: "fastMode", label: "Fast Mode", type: "boolean" }],
      },
      selections: undefined,
    });

    expect(providerOptionValueLabels(descriptors)).toEqual([]);
    expect(applyProviderOptionSelection(descriptors, { id: "fastMode", value: true })).toEqual([
      { id: "fastMode", value: true },
    ]);
  });
  it("keeps an unset output style out of the summary pill", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: CLAUDE_OUTPUT_STYLE_CAPABILITIES,
      selections: undefined,
    });
    expect(providerOptionValueLabels(descriptors)).toEqual(["High"]);
  });

  it("summarizes an output style the user deliberately picked", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: CLAUDE_OUTPUT_STYLE_CAPABILITIES,
      selections: [{ id: "outputStyle", value: "Explanatory" }],
    });
    expect(providerOptionValueLabels(descriptors)).toEqual(["High", "Explanatory"]);
  });
});
