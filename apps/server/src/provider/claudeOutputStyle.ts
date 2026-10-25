/**
 * Fork: Claude's `/output-style` as a per-thread trait. The capabilities probe reads the styles the
 * CLI reports at init, every Claude model carries them as an `outputStyle` select descriptor, and
 * the adapter forwards the pick as `settings.outputStyle` (claudeModelOptions.ts).
 *
 * @module provider/claudeOutputStyle
 */
import type { ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

import { buildSelectOptionDescriptor } from "@t3tools/provider-core/server/snapshotProbe";

/**
 * The CLI's zero-state output style. Selecting it means "do not pass
 * `settings.outputStyle` at all", which is why the adapter treats it as the
 * absence of a choice rather than a value to forward.
 */
export const DEFAULT_CLAUDE_OUTPUT_STYLE = "default";
export const CLAUDE_OUTPUT_STYLE_OPTION_ID = "outputStyle";

/**
 * Styles arrive from the SDK init handshake, built-ins first, by frontmatter `name`; the CLI
 * resolves them, so T3 Code never scans the filesystem. Names stay verbatim, as the token
 * `settings.outputStyle` matches, and dedupe case-insensitively because the CLI resolves a
 * cross-scope name collision to one style.
 */
export function parseClaudeOutputStyles(
  styles: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  const stylesByKey = new Map<string, string>();

  for (const style of styles ?? []) {
    const name = style.trim();
    if (!name) {
      continue;
    }
    const key = name.toLowerCase();
    if (!stylesByKey.has(key)) {
      stylesByKey.set(key, name);
    }
  }

  return [...stylesByKey.values()];
}

/**
 * Output styles are CLI-wide, not per-model, but clients read traits only off the selected model's
 * capabilities, so the same descriptor rides on every model, as OpenCode's `agent` list does.
 */
export function withClaudeOutputStyleDescriptor(
  models: ReadonlyArray<ServerProviderModel>,
  outputStyles: ReadonlyArray<string>,
): ReadonlyArray<ServerProviderModel> {
  // A lone "default" is the CLI reporting no styles are installed. Publishing
  // a one-choice picker would add a control that can never change anything.
  if (outputStyles.length < 2) {
    return models;
  }

  const descriptor = buildSelectOptionDescriptor({
    id: CLAUDE_OUTPUT_STYLE_OPTION_ID,
    label: "Output Style",
    options: outputStyles.map((style) =>
      style.toLowerCase() === DEFAULT_CLAUDE_OUTPUT_STYLE
        ? { value: style, label: "Default", isDefault: true }
        : // User-authored names are shown verbatim; they are display strings
          // the author chose, not slugs for us to reformat.
          { value: style, label: style },
    ),
  });

  return models.map((model) => ({
    ...model,
    capabilities: createModelCapabilities({
      // Appended, never prepended: clients read the first select descriptor as
      // the model's primary trait (reasoning effort).
      optionDescriptors: [...(model.capabilities?.optionDescriptors ?? []), descriptor],
    }),
  }));
}
