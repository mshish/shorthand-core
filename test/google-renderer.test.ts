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

  test("renders a bullet list with one bullet span per item", () => {
    const sections: readonly Section[] = [
      { heading: "Decisions", markdown: "- Ship Friday\n- Skip the retro\n" },
    ];
    const { text, spans } = renderSections(sections);
    const bullets = spans.filter((span) => span.style.kind === "bullet");
    expect(bullets).toHaveLength(2);
    expect(text.slice(bullets[0]!.start, bullets[0]!.end)).toContain("Ship Friday");
    expect(text.slice(bullets[1]!.start, bullets[1]!.end)).toContain("Skip the retro");
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
    expect(spans.filter((span) => span.style.kind === "bullet")).toHaveLength(2);
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
    expect(spans.filter((span) => span.style.kind === "bullet")).toHaveLength(2);
  });

  test("flattens a nested bullet list to same-level bullets, each with its own span", () => {
    const sections: readonly Section[] = [
      { heading: "Notes", markdown: "- Top item\n  - Nested item\n- Another top\n" },
    ];
    const { text, spans } = renderSections(sections);
    const bullets = spans.filter((span) => span.style.kind === "bullet");
    expect(bullets).toHaveLength(3);
    expect(text.slice(bullets[0]!.start, bullets[0]!.end)).toBe("Top item");
    expect(text.slice(bullets[1]!.start, bullets[1]!.end)).toBe("Nested item");
    expect(text.slice(bullets[2]!.start, bullets[2]!.end)).toBe("Another top");
  });
});
