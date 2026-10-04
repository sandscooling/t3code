import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, type ServerProviderModel } from "@t3tools/contracts";

import { shouldRenderTraitsControls } from "../chat/TraitsPicker";
import { withoutOutputStyleTrait } from "./textGenerationTraits";

const OUTPUT_STYLE = {
  id: "outputStyle",
  label: "Output Style",
  type: "select" as const,
  options: [
    { id: "default", label: "Default", isDefault: true },
    { id: "Explanatory", label: "Explanatory" },
  ],
  currentValue: "Explanatory",
};
const EFFORT = {
  id: "effort",
  label: "Effort",
  type: "select" as const,
  options: [
    { id: "high", label: "High", isDefault: true },
    { id: "max", label: "Max" },
  ],
};

function model(slug: string, optionDescriptors: ServerProviderModel["capabilities"]) {
  return { slug, name: slug, isCustom: false, capabilities: optionDescriptors };
}

describe("withoutOutputStyleTrait", () => {
  it("leaves no picker for a model whose only trait is the output style", () => {
    // Text generation is schema-constrained, so the style can never matter
    // there. An empty menu would be worse than no picker.
    const models = [model("styled-only", { optionDescriptors: [OUTPUT_STYLE] })];
    const input = {
      provider: ProviderDriverKind.make("claudeAgent"),
      model: "styled-only",
      prompt: "",
      modelOptions: undefined,
      planModeEnabled: false,
    };
    expect(shouldRenderTraitsControls({ ...input, models })).toBe(true);
    expect(shouldRenderTraitsControls({ ...input, models: withoutOutputStyleTrait(models) })).toBe(
      false,
    );
  });

  it("keeps every other trait, and models without the style untouched", () => {
    const styled = model("styled", { optionDescriptors: [EFFORT, OUTPUT_STYLE] });
    const plain = model("plain", { optionDescriptors: [EFFORT] });
    const [styledResult, plainResult] = withoutOutputStyleTrait([styled, plain]);
    expect(styledResult?.capabilities?.optionDescriptors).toEqual([EFFORT]);
    expect(plainResult).toBe(plain);
  });
});
