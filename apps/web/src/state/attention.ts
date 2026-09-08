import { createAttentionEnvironmentAtoms } from "@t3tools/client-runtime/state/attention";

import { connectionAtomRuntime } from "../connection/runtime";

export const attentionEnvironment = createAttentionEnvironmentAtoms(connectionAtomRuntime);
