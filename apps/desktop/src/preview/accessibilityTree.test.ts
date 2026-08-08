import { assert, describe, it } from "@effect/vitest";

import { compactAccessibilityTree } from "./accessibilityTree.ts";

const axNode = (input: {
  readonly role?: string;
  readonly name?: string;
  readonly description?: string;
  readonly value?: string;
  readonly ignored?: boolean;
  readonly properties?: ReadonlyArray<{ readonly name: string; readonly value: unknown }>;
}) => ({
  nodeId: "42",
  backendDOMNodeId: 4242,
  childIds: ["43", "44"],
  ignored: input.ignored ?? false,
  ...(input.role === undefined
    ? {}
    : { role: { type: "role", value: input.role, sources: [{ type: "attribute" }] } }),
  ...(input.name === undefined
    ? {}
    : {
        name: {
          type: "computedString",
          value: input.name,
          // The expensive part of a real tree: how the name was computed.
          sources: [{ type: "relatedElement", attribute: "aria-labelledby" }],
        },
      }),
  ...(input.description === undefined
    ? {}
    : { description: { type: "computedString", value: input.description } }),
  ...(input.value === undefined ? {} : { value: { type: "string", value: input.value } }),
  ...(input.properties === undefined
    ? {}
    : {
        properties: input.properties.map((property) => ({
          name: property.name,
          value: { type: "booleanOrUndefined", value: property.value },
        })),
      }),
});

describe("compactAccessibilityTree", () => {
  it("keeps role, name and useful states while dropping CDP bookkeeping", () => {
    const compacted = compactAccessibilityTree({
      nodes: [
        axNode({
          role: "button",
          name: "Save",
          description: "Persist the draft",
          properties: [
            { name: "disabled", value: true },
            { name: "focused", value: false },
            // Not in the kept set.
            { name: "hasPopup", value: "menu" },
          ],
        }),
      ],
    });

    assert.deepStrictEqual(compacted.nodes, [
      {
        role: "button",
        name: "Save",
        description: "Persist the draft",
        states: { disabled: "true", focused: "false" },
      },
    ]);
    assert.strictEqual(compacted.truncated, false);
  });

  it("drops ignored nodes, nameless layout roles, and nodes with neither role nor name", () => {
    const compacted = compactAccessibilityTree({
      nodes: [
        axNode({ role: "button", name: "Visible", ignored: false }),
        axNode({ role: "button", name: "Hidden", ignored: true }),
        axNode({ role: "generic" }),
        axNode({ role: "InlineTextBox" }),
        axNode({}),
      ],
    });

    assert.deepStrictEqual(compacted.nodes, [{ role: "button", name: "Visible" }]);
  });

  it("keeps a layout role when it carries an accessible name", () => {
    const compacted = compactAccessibilityTree({
      nodes: [axNode({ role: "generic", name: "Labelled wrapper" })],
    });

    assert.deepStrictEqual(compacted.nodes, [{ role: "generic", name: "Labelled wrapper" }]);
  });

  it("caps the node count and reports the truncation", () => {
    const compacted = compactAccessibilityTree({
      nodes: Array.from({ length: 512 }, (_, index) =>
        axNode({ role: "listitem", name: `Row ${index}` }),
      ),
    });

    assert.strictEqual(compacted.nodes.length, 300);
    assert.strictEqual(compacted.totalNodes, 512);
    assert.strictEqual(compacted.truncated, true);
    // A reader must be able to tell a short tree from a trimmed one.
    assert.deepStrictEqual(compacted.nodes[0], { role: "listitem", name: "Row 0" });
  });

  it("survives a malformed or absent tree rather than throwing", () => {
    for (const input of [null, undefined, {}, { nodes: "nope" }, { nodes: [null, 7, "x"] }]) {
      const compacted = compactAccessibilityTree(input);
      assert.deepStrictEqual(compacted.nodes, []);
      assert.strictEqual(compacted.truncated, false);
    }
  });
});
