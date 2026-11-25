import { describe, expect, test } from "bun:test";
import type { Section } from "../src/note/markers.js";
import { renderSections } from "../src/google/renderer.js";

describe("renderSections", () => {
  test("renders a section heading as a level-2 heading span", () => {
    const sections: readonly Section[] = [{ heading: "Summary", markdown: "Shipped." }];
    const { text, spans } = renderSections(sections);
    expect(text).toContain("Summary");
    expect(text).toContain("Shipped.");
    const heading = spans.find((span) => span.style.kind === "heading");
    expect(heading).toBeDefined();
    expect(text.slice(heading!.start, heading!.end)).toBe("Summary");
  });

  test("renders a bullet list as one bullet list span over one paragraph per item", () => {
    const sections: readonly Section[] = [
      { heading: "Decisions", markdown: "- Ship Friday\n- Skip the retro\n" },
    ];
    const { text, spans } = renderSections(sections);
    expect(text).toBe("Decisions\nShip Friday\nSkip the retro\n");
    const lists = spans.filter((span) => span.style.kind === "list");
    expect(lists).toEqual([{ start: 10, end: text.length, style: { kind: "list", preset: "bullet" } }]);
  });

  test("renders bold runs located within the plain text", () => {
    const sections: readonly Section[] = [{ heading: "Notes", markdown: "This is **important**." }];
    const { text, spans } = renderSections(sections);
    const bold = spans.find((span) => span.style.kind === "bold");
    expect(bold).toBeDefined();
    expect(text.slice(bold!.start, bold!.end)).toBe("important");
  });

  test("renders links with the URL captured on the span", () => {
    const sections: readonly Section[] = [
      { heading: "Notes", markdown: "See [the doc](https://example.com/x)." },
    ];
    const { text, spans } = renderSections(sections);
    const link = spans.find((span) => span.style.kind === "link");
    expect(link).toBeDefined();
    expect(link!.style.kind === "link" && link!.style.url).toBe("https://example.com/x");
    expect(text.slice(link!.start, link!.end)).toBe("the doc");
  });

  test("UTF-16 offsets stay correct across a multi-unit emoji", () => {
    const sections: readonly Section[] = [
      { heading: "Notes", markdown: "🎉 **great** work" },
    ];
    const { text, spans } = renderSections(sections);
    const bold = spans.find((span) => span.style.kind === "bold");
    expect(bold).toBeDefined();
    expect(text.slice(bold!.start, bold!.end)).toBe("great");
  });

  test("multiple sections concatenate in order, each with its own heading span", () => {
    const sections: readonly Section[] = [
      { heading: "Summary", markdown: "First." },
      { heading: "Decisions", markdown: "Second." },
    ];
    const { text, spans } = renderSections(sections);
    expect(text.indexOf("Summary")).toBeLessThan(text.indexOf("Decisions"));
    expect(spans.filter((span) => span.style.kind === "heading")).toHaveLength(2);
  });

  test("renders a bold run inside a loose bullet list item", () => {
    // A blank line between "- " items makes the list "loose": marked wraps
    // each item's content in a full "paragraph" token instead of the
    // tight-list "text" wrapper, which previously fell through to a raw-text
    // fallback and leaked "**Ship**" verbatim with no bold span.
    const sections: readonly Section[] = [
      { heading: "Decisions", markdown: "- **Ship** Friday\n\n- Skip the retro\n" },
    ];
    const { text, spans } = renderSections(sections);
    expect(text).not.toContain("**");
    const bold = spans.find((span) => span.style.kind === "bold");
    expect(bold).toBeDefined();
    expect(text.slice(bold!.start, bold!.end)).toBe("Ship");
    expect(text).toBe("Decisions\nShip Friday\nSkip the retro\n");
    expect(spans.filter((span) => span.style.kind === "list")).toHaveLength(1);
  });

  test("renders a link inside a loose bullet list item", () => {
    const sections: readonly Section[] = [
      {
        heading: "Decisions",
        markdown: "- See [the doc](https://example.com/x)\n\n- Skip the retro\n",
      },
    ];
    const { text, spans } = renderSections(sections);
    expect(text).not.toContain("[the doc]");
    expect(text).not.toContain("(https://example.com/x)");
    const link = spans.find((span) => span.style.kind === "link");
    expect(link).toBeDefined();
    expect(link!.style.kind === "link" && link!.style.url).toBe("https://example.com/x");
    expect(text.slice(link!.start, link!.end)).toBe("the doc");
    expect(spans.filter((span) => span.style.kind === "list")).toHaveLength(1);
  });

  test("a blank line between paragraphs does not create a spurious empty paragraph", () => {
    // Regression: marked emits a "space" token for the blank line between block
    // tokens. It used to fall through the generic fallback branch and append an
    // empty paragraph, which broke unchanged-detection idempotence for any
    // ordinary multi-paragraph section body.
    const sections: readonly Section[] = [{ heading: "Notes", markdown: "One.\n\nTwo." }];
    const { text } = renderSections(sections);
    expect(text).not.toContain("\n\n");
    expect(text).toBe("Notes\nOne.\nTwo.\n");
  });

  test("an empty bullet list item produces no paragraph and no zero-length span", () => {
    const sections: readonly Section[] = [
      { heading: "Decisions", markdown: "- \n- x\n" },
    ];
    const { text, spans } = renderSections(sections);
    expect(text).toBe("Decisions\nx\n");
    expect(spans.every((span) => span.end > span.start)).toBe(true);
  });

  test("nests a nested list one tab deeper inside the same list block", () => {
    const sections: readonly Section[] = [
      { heading: "Notes", markdown: "* Top item\n  * Nested item\n    * Deeper\n* Another top\n" },
    ];
    const { text, spans } = renderSections(sections);
    expect(text).toBe("Notes\nTop item\n\tNested item\n\t\tDeeper\nAnother top\n");
    expect(spans.filter((span) => span.style.kind === "list")).toHaveLength(1);
  });

  test("an ordered list becomes a numbered list", () => {
    const { spans } = renderSections([{ heading: "Steps", markdown: "1. One\n2. Two\n" }]);
    expect(spans.find((span) => span.style.kind === "list")!.style).toEqual({ kind: "list", preset: "numbered" });
  });

  test("a list of only tasks becomes a checklist, with done tasks struck through", () => {
    const { text, spans } = renderSections([
      { heading: "Actions", markdown: "* [ ] **Mike** to send the deck\n* [x] Book the room\n" },
    ]);
    expect(text).toBe("Actions\nMike to send the deck\nBook the room\n");
    expect(spans.find((span) => span.style.kind === "list")!.style).toEqual({ kind: "list", preset: "checkbox" });
    const struck = spans.filter((span) => span.style.kind === "strikethrough");
    expect(struck.map((span) => text.slice(span.start, span.end))).toEqual(["Book the room"]);
  });

  test("a task inside an ordinary list keeps a box glyph instead of its brackets", () => {
    const { text } = renderSections([{ heading: "Notes", markdown: "* An idea\n* [ ] A task\n* [x] Done\n" }]);
    expect(text).toBe("Notes\nAn idea\n\u2610 A task\n\u2611 Done\n");
  });

  test("separate list blocks get separate list spans", () => {
    const { spans } = renderSections([{ heading: "Notes", markdown: "* a\n\nText.\n\n1. b\n" }]);
    const presets = spans.flatMap((span) => (span.style.kind === "list" ? [span.style.preset] : []));
    expect(presets).toEqual(["bullet", "numbered"]);
  });

  test("italic and strikethrough runs get their own spans", () => {
    const { text, spans } = renderSections([{ heading: "Notes", markdown: "An *idea* and ~~a plan~~." }]);
    expect(text).toBe("Notes\nAn idea and a plan.\n");
    const kinds = spans.map((span) => `${span.style.kind}:${text.slice(span.start, span.end)}`);
    expect(kinds).toContain("italic:idea");
    expect(kinds).toContain("strikethrough:a plan");
  });

  test("a heading inside a section body becomes a level-3 heading", () => {
    const { text, spans } = renderSections([{ heading: "Notes", markdown: "## Sub\n\nBody." }]);
    expect(text).toBe("Notes\nSub\nBody.\n");
    const levels = spans.flatMap((span) => (span.style.kind === "heading" ? [span.style.level] : []));
    expect(levels).toEqual([2, 3]);
  });

  test("Obsidian-only syntax degrades to clean text", () => {
    const { text } = renderSections([
      {
        heading: "Notes",
        markdown: "> [!warning] The **launch** may slip\n\nA ==key== date for [[Project Plan]].\n\n| Owner | Task |\n|---|---|\n| Mike | Deck |\n",
      },
    ]);
    expect(text).toBe("Notes\nThe launch may slip\nA key date for Project Plan.\nOwner: Mike; Task: Deck\n");
  });

});
