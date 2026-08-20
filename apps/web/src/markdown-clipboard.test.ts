import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  restoreMarkdownImageSourcesForClipboard,
  serializeMarkdownImageElement,
  serializeRenderedMarkdownFragment,
} from "./markdown-clipboard";
import { resolveMarkdownImageFileLinkMeta } from "./markdown-links";

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

class FakeText {
  readonly nodeType = TEXT_NODE;
  readonly childNodes: ReadonlyArray<never> = [];

  constructor(readonly textContent: string) {}
}

class FakeElement {
  readonly nodeType = ELEMENT_NODE;
  readonly childNodes: Array<FakeElement | FakeText> = [];
  readonly classList = {
    contains: (name: string) => this.classNames.includes(name),
  };

  constructor(
    readonly tagName: string,
    private readonly classNames: ReadonlyArray<string> = [],
  ) {}

  get localName(): string {
    return this.tagName.toLowerCase();
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join("");
  }

  append(...children: Array<FakeElement | FakeText>): this {
    this.childNodes.push(...children);
    return this;
  }

  getAttribute(): string | null {
    return null;
  }

  hasAttribute(): boolean {
    return false;
  }
}

function asNode(element: FakeElement): Node {
  return element as unknown as Node;
}

function shikiCodeLine(text: string): FakeElement {
  const token = new FakeElement("SPAN").append(new FakeText(text));
  return new FakeElement("SPAN", ["line"]).append(token);
}

describe("serializeRenderedMarkdownFragment", () => {
  beforeEach(() => {
    vi.stubGlobal("Node", { TEXT_NODE, ELEMENT_NODE });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("wraps inline code in backticks", () => {
    const paragraph = new FakeElement("P").append(
      new FakeText("run "),
      new FakeElement("CODE").append(new FakeText("git status")),
      new FakeText(" first"),
    );
    const container = new FakeElement("DIV").append(paragraph);

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe("run `git status` first");
  });

  it("keeps a highlighted block code selection plain when its pre wrapper is outside the range", () => {
    const code = new FakeElement("CODE").append(
      shikiCodeLine("git show-ref --verify refs/remotes/origin/opt/deploy/dev"),
    );
    const container = new FakeElement("DIV").append(code);

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe(
      "git show-ref --verify refs/remotes/origin/opt/deploy/dev",
    );
  });

  it("keeps a multi-line code selection plain instead of inline-wrapping it", () => {
    const code = new FakeElement("CODE").append(new FakeText("first line\nsecond line"));
    const container = new FakeElement("DIV").append(code);

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe("first line\nsecond line");
  });
});

function makeImageAttributes(initial: Record<string, string>) {
  const attributes = new Map(Object.entries(initial));
  return {
    attributes,
    element: {
      getAttribute(name: string) {
        return attributes.get(name) ?? null;
      },
      removeAttribute(name: string) {
        attributes.delete(name);
      },
      setAttribute(name: string, value: string) {
        attributes.set(name, value);
      },
    },
  };
}

describe("workspace image clipboard serialization", () => {
  it("uses the original Markdown source instead of the signed rendering URL", () => {
    const { element } = makeImageAttributes({
      alt: "Result",
      "data-markdown-src": "screenshots/result.png",
      src: "https://environment.example/api/assets/signed-token/result.png",
    });

    expect(serializeMarkdownImageElement(element)).toBe("![Result](screenshots/result.png)");
  });

  it("round-trips an encoded Windows path copied from a work-log image", () => {
    const imagePath = "C:\\Users\\mike\\dev-stuff\\t3code\\result.png";
    const encodedImagePath = encodeURIComponent(imagePath);
    const { element } = makeImageAttributes({
      alt: "Generated image",
      "data-markdown-src": encodedImagePath,
      src: "https://environment.example/api/assets/signed-token/result.png",
    });

    const copiedMarkdown = serializeMarkdownImageElement(element);
    const copiedSource = /^!\[[^\]]*\]\((.*)\)$/.exec(copiedMarkdown)?.[1];

    expect(copiedMarkdown).toBe(`![Generated image](${encodedImagePath})`);
    expect(resolveMarkdownImageFileLinkMeta(copiedSource)?.filePath).toBe(imagePath);
  });

  it("restores original sources and removes signed-URL metadata before rich copy", () => {
    const { attributes, element } = makeImageAttributes({
      alt: "Result",
      "data-markdown-src": "screenshots/result.png",
      src: "https://environment.example/api/assets/signed-token/result.png",
    });

    restoreMarkdownImageSourcesForClipboard([element]);

    expect(Object.fromEntries(attributes)).toEqual({
      alt: "Result",
      src: "screenshots/result.png",
    });
  });

  it("keeps ordinary remote image sources unchanged", () => {
    const { element } = makeImageAttributes({
      alt: "Remote",
      src: "https://example.com/result.png",
    });

    expect(serializeMarkdownImageElement(element)).toBe(
      "![Remote](https://example.com/result.png)",
    );
  });
});
