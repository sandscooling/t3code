const MAX_ACCESSIBILITY_NODES = 300;

/**
 * Roles that only ever restate page text, dropped even when they carry a name.
 *
 * `visibleText` is `document.body.innerText`, so every StaticText and
 * InlineTextBox name is already in the payload verbatim. Keeping them made the
 * tree mostly a second, worse copy of the prose: on a catalogue page they were
 * the bulk of 597 nodes, which then pushed genuinely addressable controls past
 * the node cap. What the tree is for is roles, names and states of things you
 * can act on.
 */
const TEXT_DUPLICATE_ACCESSIBILITY_ROLES = new Set(["StaticText", "InlineTextBox"]);

/** Layout roles that carry no meaning of their own, dropped when unnamed. */
const IGNORED_ACCESSIBILITY_ROLES = new Set(["none", "generic", "GenericContainer"]);
/** Node states worth keeping; the rest of the CDP property bag is noise here. */
const KEPT_ACCESSIBILITY_STATES = new Set([
  "checked",
  "disabled",
  "expanded",
  "focused",
  "invalid",
  "level",
  "pressed",
  "required",
  "selected",
]);

const axValue = (node: Record<string, unknown>, key: string): string | null => {
  const raw = node[key];
  if (typeof raw !== "object" || raw === null) return null;
  const value = (raw as { value?: unknown }).value;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
};

/**
 * Compact `Accessibility.getFullAXTree` for the snapshot payload.
 *
 * The raw CDP tree was the one field here with no cap, and it dominated the
 * token cost of every snapshot: a node per DOM element, each carrying nodeId,
 * backendDOMNodeId, a childIds array, and an AXValue whose `sources` records
 * how the name was computed. None of that is addressable by a caller, which
 * works in selectors, and the interactive elements list already covers the
 * things worth acting on. What survives is what identifies the page: role,
 * name, and the states that change how a control reads.
 *
 * Reports its own truncation, so a reader can tell a short tree from a
 * trimmed one rather than assuming it saw everything.
 */
export function compactAccessibilityTree(tree: unknown): {
  readonly nodes: ReadonlyArray<Record<string, unknown>>;
  readonly totalNodes: number;
  readonly truncated: boolean;
} {
  const rawNodes = (tree as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(rawNodes)) {
    return { nodes: [], totalNodes: 0, truncated: false };
  }

  const kept: Record<string, unknown>[] = [];
  for (const raw of rawNodes) {
    if (typeof raw !== "object" || raw === null) continue;
    const node = raw as Record<string, unknown>;
    if (node["ignored"] === true) continue;

    const role = axValue(node, "role");
    const name = axValue(node, "name");
    if (role === null && name === null) continue;
    if (role !== null && TEXT_DUPLICATE_ACCESSIBILITY_ROLES.has(role)) continue;
    if (role !== null && IGNORED_ACCESSIBILITY_ROLES.has(role) && name === null) continue;

    const entry: Record<string, unknown> = {};
    if (role !== null) entry["role"] = role;
    if (name !== null) entry["name"] = name;
    const description = axValue(node, "description");
    if (description !== null) entry["description"] = description;
    const value = axValue(node, "value");
    if (value !== null) entry["value"] = value;

    const properties = node["properties"];
    if (Array.isArray(properties)) {
      const states: Record<string, unknown> = {};
      for (const property of properties) {
        if (typeof property !== "object" || property === null) continue;
        const propertyName = (property as { name?: unknown }).name;
        if (typeof propertyName !== "string" || !KEPT_ACCESSIBILITY_STATES.has(propertyName)) {
          continue;
        }
        const state = axValue(property as Record<string, unknown>, "value");
        if (state !== null) states[propertyName] = state;
      }
      if (Object.keys(states).length > 0) entry["states"] = states;
    }

    kept.push(entry);
  }

  return {
    nodes: kept.slice(0, MAX_ACCESSIBILITY_NODES),
    totalNodes: kept.length,
    truncated: kept.length > MAX_ACCESSIBILITY_NODES,
  };
}
