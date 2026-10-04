import { describe, expect, it } from "@effect/vitest";

import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";

import { compileClaudeModelSelection } from "./claudeModelOptions.ts";

const selection = (
  model: string,
  options: NonNullable<ModelSelection["options"]>,
): ModelSelection => ({
  instanceId: ProviderInstanceId.make("claude_test"),
  model,
  options,
});

describe("compileClaudeModelSelection (fork)", () => {
  // MCP, scheduled, and mobile turns omit fastMode while the web composer
  // sends false; both must open the same Claude query.
  it("compiles absent fast mode the same as explicit false", () => {
    const absent = compileClaudeModelSelection(selection("claude-opus-4-6", []));
    const explicitFalse = compileClaudeModelSelection(
      selection("claude-opus-4-6", [{ id: "fastMode", value: false }]),
    );
    const explicitTrue = compileClaudeModelSelection(
      selection("claude-opus-4-6", [{ id: "fastMode", value: true }]),
    );
    expect(absent.queryIdentity).toBe(explicitFalse.queryIdentity);
    expect(explicitTrue.queryIdentity).not.toBe(absent.queryIdentity);
  });

  it("adds no fast mode setting for models without it", () => {
    expect(compileClaudeModelSelection(selection("claude-haiku-4-5", [])).settings).toEqual({});
  });
});
