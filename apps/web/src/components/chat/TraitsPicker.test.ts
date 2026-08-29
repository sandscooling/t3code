import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, type ProviderOptionDescriptor } from "@t3tools/contracts";
import {
  buildTraitsTriggerDisplay,
  buildUnavailableModelOptionDescriptors,
  shouldRenderTraitsControls,
} from "./TraitsPicker";

function selectDescriptor(
  id: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
  currentValue: string,
): Extract<ProviderOptionDescriptor, { type: "select" }> {
  return { id, label: id, type: "select", options: [...options], currentValue };
}

function fastModeDescriptor(
  currentValue: boolean,
): Extract<ProviderOptionDescriptor, { type: "boolean" }> {
  return { id: "fastMode", label: "Fast Mode", type: "boolean", currentValue };
}

function serviceTierDescriptor(
  currentValue: "default" | "priority" | "flex",
): Extract<ProviderOptionDescriptor, { type: "select" }> {
  return {
    id: "serviceTier",
    label: "Service Tier",
    type: "select",
    options: [
      { id: "default", label: "Standard", isDefault: true },
      { id: "priority", label: "Fast" },
      { id: "flex", label: "Flex" },
    ],
    currentValue,
  };
}

const EFFORT = selectDescriptor(
  "reasoningEffort",
  [
    { id: "high", label: "High" },
    { id: "max", label: "Max" },
  ],
  "high",
);
const CONTEXT_WINDOW = selectDescriptor(
  "contextWindow",
  [
    { id: "200k", label: "200k" },
    { id: "1m", label: "1M" },
  ],
  "1m",
);

function outputStyleDescriptor(currentValue: string) {
  return selectDescriptor(
    "outputStyle",
    [
      { id: "default", label: "Default", isDefault: true },
      { id: "Explanatory", label: "Explanatory" },
    ],
    currentValue,
  );
}

const CODEX = ProviderDriverKind.make("codex");

function display(descriptors: ReadonlyArray<ProviderOptionDescriptor>) {
  return buildTraitsTriggerDisplay({
    provider: CODEX,
    descriptors,
    primarySelectDescriptorId: "reasoningEffort",
    ultrathinkPromptControlled: false,
  });
}

describe("buildTraitsTriggerDisplay", () => {
  it("omits fast mode from the label entirely when it is off", () => {
    expect(display([EFFORT, fastModeDescriptor(false), CONTEXT_WINDOW])).toEqual({
      label: "High · 1M",
      showFastModeIcon: false,
    });
  });

  it("shows the bolt instead of a text label when fast mode is on", () => {
    expect(display([EFFORT, fastModeDescriptor(true), CONTEXT_WINDOW])).toEqual({
      label: "High · 1M",
      showFastModeIcon: true,
    });
  });

  it("treats Codex standard and fast service tiers as fast mode states", () => {
    expect(display([EFFORT, serviceTierDescriptor("default")])).toEqual({
      label: "High",
      showFastModeIcon: false,
    });
    expect(display([EFFORT, serviceTierDescriptor("priority")])).toEqual({
      label: "High",
      showFastModeIcon: true,
    });
  });

  it("keeps other Codex service tiers in the label", () => {
    expect(display([EFFORT, serviceTierDescriptor("flex")])).toEqual({
      label: "High · Flex",
      showFastModeIcon: false,
    });
  });

  it("keeps the Codex service tier readable when it is the only trait", () => {
    expect(display([serviceTierDescriptor("default")])).toEqual({
      label: "Standard",
      showFastModeIcon: false,
    });
    expect(display([serviceTierDescriptor("priority")])).toEqual({
      label: "Fast",
      showFastModeIcon: false,
    });
  });

  it("keeps non-fastMode booleans as text labels", () => {
    const thinking: Extract<ProviderOptionDescriptor, { type: "boolean" }> = {
      id: "thinking",
      label: "Thinking",
      type: "boolean",
      currentValue: true,
    };
    expect(display([EFFORT, thinking])).toEqual({
      label: "High · Thinking On",
      showFastModeIcon: false,
    });
  });

  it("falls back to a text label when fast mode is the only trait", () => {
    expect(display([fastModeDescriptor(true)])).toEqual({
      label: "Fast",
      showFastModeIcon: false,
    });
    expect(display([fastModeDescriptor(false)])).toEqual({
      label: "Normal",
      showFastModeIcon: false,
    });
  });

  it("stays blank when descriptors resolve to no label and there is no fast mode", () => {
    // A select with neither a currentValue nor an isDefault option yields no
    // label. Without a fastMode descriptor present that must stay blank rather
    // than falling through to a bogus "Normal".
    const unresolved: Extract<ProviderOptionDescriptor, { type: "select" }> = {
      id: "effort",
      label: "effort",
      type: "select",
      options: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
    };
    expect(display([unresolved])).toEqual({ label: "", showFastModeIcon: false });
  });

  it("omits the output style from the label while it is the default", () => {
    // The Claude trigger never truncates, so the near-universal default must
    // not spend horizontal space the way a deliberate style does.
    expect(display([EFFORT, CONTEXT_WINDOW, outputStyleDescriptor("default")])).toEqual({
      label: "High · 1M",
      showFastModeIcon: false,
    });
  });

  it("shows the output style once it is set to something deliberate", () => {
    expect(display([EFFORT, CONTEXT_WINDOW, outputStyleDescriptor("Explanatory")])).toEqual({
      label: "High · 1M · Explanatory",
      showFastModeIcon: false,
    });
  });

  it("omits an output style that resolves to its default without an explicit value", () => {
    // A thread that never touched the trait resolves through isDefault rather
    // than a stored currentValue, and must read the same as an explicit default.
    const unset: Extract<ProviderOptionDescriptor, { type: "select" }> = {
      id: "outputStyle",
      label: "Output Style",
      type: "select",
      options: [
        { id: "default", label: "Default", isDefault: true },
        { id: "Learning", label: "Learning" },
      ],
    };
    expect(display([EFFORT, unset])).toEqual({ label: "High", showFastModeIcon: false });
  });

  it("drops an excluded trait so it cannot be the only reason controls render", () => {
    // The text-generation picker excludes output style, since that work is
    // schema-constrained. A model whose only trait is the excluded one must
    // render no picker at all rather than an empty menu.
    const models = [
      {
        slug: "styled-only",
        name: "Styled Only",
        isCustom: false,
        capabilities: {
          optionDescriptors: [outputStyleDescriptor("Explanatory")],
        },
      },
    ];
    const input = {
      provider: ProviderDriverKind.make("claudeAgent"),
      models,
      model: "styled-only",
      prompt: "",
      modelOptions: undefined,
      planModeEnabled: false,
    };
    expect(shouldRenderTraitsControls(input)).toBe(true);
    expect(shouldRenderTraitsControls({ ...input, excludeDescriptorIds: ["outputStyle"] })).toBe(
      false,
    );
  });

  it("still renders the prompt-controlled ultrathink label alongside the bolt", () => {
    expect(
      buildTraitsTriggerDisplay({
        provider: CODEX,
        descriptors: [EFFORT, fastModeDescriptor(true)],
        primarySelectDescriptorId: "reasoningEffort",
        ultrathinkPromptControlled: true,
      }),
    ).toEqual({ label: "Ultrathink", showFastModeIcon: true });
  });
});

describe("buildUnavailableModelOptionDescriptors", () => {
  it("shows only saved values without inventing alternatives", () => {
    expect(
      buildUnavailableModelOptionDescriptors([
        { id: "variant", value: "max" },
        { id: "agent", value: "build" },
        { id: "fastMode", value: true },
      ]),
    ).toEqual([
      {
        id: "variant",
        label: "Variant",
        type: "select",
        options: [{ id: "max", label: "max" }],
        currentValue: "max",
      },
      {
        id: "agent",
        label: "Agent",
        type: "select",
        options: [{ id: "build", label: "build" }],
        currentValue: "build",
      },
      {
        id: "fastMode",
        label: "Fast Mode",
        type: "boolean",
        currentValue: true,
      },
    ]);
  });
});
