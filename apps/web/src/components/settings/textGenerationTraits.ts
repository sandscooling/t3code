import type { ServerProviderModel } from "@t3tools/contracts";

/**
 * Fork: the text-generation model's traits, without Claude's output style.
 *
 * Titles, commit messages, and branch names are generated against a JSON
 * schema, which an output style cannot usefully change and could fight.
 * Dropping the descriptor from the picker's capabilities hides the control,
 * keeps it out of the trigger label, and keeps it out of the selections
 * written back on change, so the picker never offers a control that silently
 * does nothing.
 */
export function withoutOutputStyleTrait(
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  return models.map((model) => {
    const descriptors = model.capabilities?.optionDescriptors;
    if (!descriptors?.some((descriptor) => descriptor.id === "outputStyle")) {
      return model;
    }
    return {
      ...model,
      capabilities: {
        ...model.capabilities,
        optionDescriptors: descriptors.filter((descriptor) => descriptor.id !== "outputStyle"),
      },
    };
  });
}
