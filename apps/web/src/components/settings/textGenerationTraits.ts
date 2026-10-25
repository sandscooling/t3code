import type { ServerProviderModel } from "@t3tools/contracts";

/**
 * Fork: the text-generation model's traits, without Claude's output style. Titles, commit messages
 * and branch names are generated against a JSON schema an output style could only fight, so the
 * descriptor is dropped from the picker's control, trigger label and written-back selections.
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
