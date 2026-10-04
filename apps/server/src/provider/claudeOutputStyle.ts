/**
 * Fork: Claude's `/output-style` as a per-thread trait.
 *
 * The capabilities probe reads the styles the CLI reports on its init
 * handshake, and every model in the Claude snapshot carries them as an
 * `outputStyle` select descriptor. The adapter forwards the selection as
 * `settings.outputStyle` (see claudeModelOptions.ts).
 *
 * @module provider/claudeOutputStyle
 */
import type { ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

import { buildSelectOptionDescriptor } from "./providerSnapshot.ts";

/**
 * The CLI's zero-state output style. Selecting it means "do not pass
 * `settings.outputStyle` at all", which is why the adapter treats it as the
 * absence of a choice rather than a value to forward.
 */
export const DEFAULT_CLAUDE_OUTPUT_STYLE = "default";
export const CLAUDE_OUTPUT_STYLE_OPTION_ID = "outputStyle";

/**
 * Normalize the output style names reported by the SDK init handshake.
 *
 * The CLI resolves these itself from its built-ins plus the user-level
 * `output-styles` directory, so T3 Code never scans the filesystem for them.
 * They arrive built-ins first, by name (a style file's frontmatter `name`,
 * not its filename). Names are kept verbatim (they are the token
 * `settings.outputStyle` matches on) and deduped case-insensitively, since two
 * scopes can define the same name and the CLI resolves such a collision to a
 * single style.
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
 * Append an output-style trait to every model in the snapshot.
 *
 * Output styles are a CLI-wide setting rather than a per-model one, so the
 * same descriptor rides on each model; clients read traits off the selected
 * model's capabilities and have no other channel for it. Mirrors how
 * OpenCode publishes its discovered `agent` list.
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
