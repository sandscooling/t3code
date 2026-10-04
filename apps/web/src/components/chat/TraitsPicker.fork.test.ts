// Fork-owned tests for TraitsPicker.test.ts.
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
  it("omits the output style from the label while it is the default", () => {
    // The Claude trigger never truncates, so the near-universal default must
    // not spend horizontal space the way a deliberate style does.
    expect(display([EFFORT, CONTEXT_WINDOW, outputStyleDescriptor("default")])).toEqual({
      label: "High · 1M",
      speedIcon: null,
    });
  });

  it("shows the output style once it is set to something deliberate", () => {
    expect(display([EFFORT, CONTEXT_WINDOW, outputStyleDescriptor("Explanatory")])).toEqual({
      label: "High · 1M · Explanatory",
      speedIcon: null,
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
    expect(display([EFFORT, unset])).toEqual({ label: "High", speedIcon: null });
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
});
