import type { ModelSelection } from "@t3tools/contracts";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
  resolvePromptInjectedEffort,
} from "@t3tools/shared/model";

import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  getClaudeCatalogModelCapabilities,
  normalizeClaudeCatalogEffort,
  resolveClaudeCatalogApiModelId,
  resolveClaudeCatalogEffort,
  resolveClaudeCatalogModel,
  resolveClaudeModelSlug,
  type ClaudeModelCatalog,
} from "./provider/ClaudeModelCatalog.ts";
// Fork: per-thread output style (see the settings block below).
import {
  CLAUDE_OUTPUT_STYLE_OPTION_ID,
  DEFAULT_CLAUDE_OUTPUT_STYLE,
} from "./provider/claudeOutputStyle.ts";

const CLAUDE_CODE_MODEL_ALIASES = new Set(["opus", "sonnet", "haiku", "fable"]);

export interface CompiledClaudeModelSelection {
  readonly apiModelId: string;
  readonly effort: string | undefined;
  readonly promptEffort: string | undefined;
  // Fork: string widens for outputStyle; the upstream flags keep their boolean type.
  readonly settings: Readonly<Record<string, boolean | string>> & {
    readonly alwaysThinkingEnabled?: boolean;
    readonly fastMode?: boolean;
    readonly ultracode?: boolean;
  };
  /** The alias of a custom model named like one, which Claude Code would otherwise expand. */
  readonly pinnedAlias: string | undefined;
  readonly queryIdentity: string;
}

export function compileClaudeModelSelection(
  selection: ModelSelection,
  catalog: ClaudeModelCatalog = BUNDLED_CLAUDE_MODEL_CATALOG,
): CompiledClaudeModelSelection {
  const capabilities = getClaudeCatalogModelCapabilities(catalog, selection.model);
  const descriptors = getProviderOptionDescriptors({
    caps: capabilities,
    selections: selection.options,
  });
  const supportsBoolean = (id: string) =>
    descriptors.some((descriptor) => descriptor.type === "boolean" && descriptor.id === id);
  const rawEffort = getModelSelectionStringOptionValue(selection, "effort");
  const resolvedEffort = resolveClaudeCatalogEffort(catalog, selection.model, rawEffort);
  const effort = normalizeClaudeCatalogEffort(catalog, resolvedEffort, selection.model);
  const fastMode = supportsBoolean("fastMode")
    ? (getModelSelectionBooleanOptionValue(selection, "fastMode") ?? false)
    : undefined;
  const inCatalog = resolveClaudeCatalogModel(catalog, selection.model) !== undefined;
  const thinking =
    !inCatalog || supportsBoolean("thinking")
      ? getModelSelectionBooleanOptionValue(selection, "thinking")
      : undefined;
  // Fork: the thread's output style rides the session-scoped settings on its
  // own CLI process, so it never leaks into another thread or settings.json.
  // "default" is the CLI zero state and is sent as absence, not a value.
  const rawOutputStyle = getModelSelectionStringOptionValue(
    selection,
    CLAUDE_OUTPUT_STYLE_OPTION_ID,
  );
  const outputStyle =
    rawOutputStyle && rawOutputStyle.toLowerCase() !== DEFAULT_CLAUDE_OUTPUT_STYLE
      ? rawOutputStyle
      : undefined;
  const ultracode = descriptors.find((descriptor) => descriptor.id === "ultracode")?.currentValue;
  const settings = {
    ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
    ...(typeof fastMode === "boolean" ? { fastMode } : {}),
    ...(typeof ultracode === "boolean" ? { ultracode } : {}),
    ...(outputStyle ? { outputStyle } : {}), // Fork: per-thread output style
  };
  const apiModelId = resolveClaudeCatalogApiModelId(catalog, selection);
  const promptEffort = resolvePromptInjectedEffort(capabilities, rawEffort) ?? undefined;
  // An alias the catalog routes a built-in model to is Claude Code's own and is not pinned.
  const pinnedAlias =
    CLAUDE_CODE_MODEL_ALIASES.has(apiModelId) &&
    resolveClaudeModelSlug(catalog, selection.model) === apiModelId
      ? apiModelId
      : undefined;
  return {
    apiModelId,
    effort,
    promptEffort,
    settings,
    pinnedAlias,
    queryIdentity: JSON.stringify({
      apiModelId,
      effort: effort ?? null,
      settings,
      pinnedAlias: pinnedAlias ?? null,
    }),
  };
}
