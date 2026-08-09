import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, type ProviderOptionDescriptor } from "@t3tools/contracts";
import { buildTraitsTriggerDisplay, shouldRenderTraitsControls } from "./TraitsPicker";

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

  it("renders Codex's Standard and Fast service tiers as fast mode", () => {
    const serviceTier = selectDescriptor(
      "serviceTier",
      [
        { id: "default", label: "Standard", isDefault: true },
        { id: "priority", label: "Fast" },
      ],
      "default",
    );

    expect(display([EFFORT, serviceTier])).toEqual({
      label: "High",
      showFastModeIcon: false,
    });
    expect(display([EFFORT, { ...serviceTier, currentValue: "priority" }])).toEqual({
      label: "High",
      showFastModeIcon: true,
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
