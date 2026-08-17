import { describe, expect, test } from "bun:test";
import {
  AI_BLOCK_END,
  AI_BLOCK_START,
  appendNoteScaffold,
  buildNoteScaffold,
  locateAiBlock,
  parseSections,
  renderSections,
  type MarkerErrorCode,
  type Section,
} from "../src/note/markers.js";

describe("AI block marker parsing", () => {
  const anomalies: readonly [string, string, MarkerErrorCode][] = [
    ["returns markers-missing for zero markers", "plain note", "markers-missing"],
    ["returns start-marker-missing for a lone end", AI_BLOCK_END, "start-marker-missing"],
    ["returns end-marker-missing for a lone start", AI_BLOCK_START, "end-marker-missing"],
    ["returns duplicate-start-marker for a second non-nested start", `${AI_BLOCK_START}${AI_BLOCK_END}${AI_BLOCK_START}`, "duplicate-start-marker"],
    ["returns duplicate-end-marker for a second end", `${AI_BLOCK_START}${AI_BLOCK_END}${AI_BLOCK_END}`, "duplicate-end-marker"],
    ["returns nested-markers for nested pairs", `${AI_BLOCK_START}${AI_BLOCK_START}${AI_BLOCK_END}${AI_BLOCK_END}`, "nested-markers"],
    ["returns end-before-start for inverted markers", `${AI_BLOCK_END}${AI_BLOCK_START}`, "end-before-start"],
  ];

  for (const [name, content, code] of anomalies) {
    test(name, () => {
      const result = locateAiBlock(content);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatchObject({ kind: "marker-error", code });
    });
  }

  test("locates the exact bytes strictly between the markers", () => {
    const body = "\r\n## Summary\r\nhello\r\n";
    const content = `before${AI_BLOCK_START}${body}${AI_BLOCK_END}after`;
    const result = locateAiBlock(content);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.body).toBe(body);
  });

  test("reports byte offsets and line numbers for offending marker tokens", () => {
    const content = `雪 café\n${AI_BLOCK_START}\n${AI_BLOCK_END}\n${AI_BLOCK_END}`;
    const result = locateAiBlock(content);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const offendingOffset = content.lastIndexOf(AI_BLOCK_END);
    expect(result.error.locations).toEqual([{ offset: Buffer.byteLength(content.slice(0, offendingOffset), "utf8"), line: 4 }]);
    expect(result.error.message).toContain("line 4");
  });
});

describe("section rendering", () => {
  const sections: readonly Section[] = [
    { heading: "Summary", markdown: "Unicode café 🚀\n\n- one\n- two" },
    { heading: "Decisions", markdown: "" },
    { heading: "Actions", markdown: "| Who | What |\n| --- | --- |\n| Me | Ship |" },
  ];

  test("round-trips sections through LF block markdown", () => {
    const rendered = renderSections(sections);
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(parseSections(rendered.value)).toEqual({ ok: true, value: sections });
  });

  test("round-trips sections through a CRLF block body with marker-adjacent newlines", () => {
    const rendered = renderSections(sections, "\r\n");
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(parseSections(`\r\n${rendered.value}\r\n`)).toEqual({ ok: true, value: sections });
  });

  test("normalizes CRLF and lone-CR markdown before rendering CRLF output", () => {
    const rendered = renderSections([{ heading: "Summary", markdown: "one\r\ntwo\rthree" }], "\r\n");
    expect(rendered).toEqual({ ok: true, value: "## Summary\r\none\r\ntwo\r\nthree" });
    if (rendered.ok) expect(rendered.value).not.toContain("\r\r\n");
  });

  test("tolerates blank lines between sections and trims chunk-edge newlines", () => {
    expect(parseSections("\n\n## Summary\nFirst\n\n\n## Decisions\n\nSecond\n\n")).toEqual({
      ok: true,
      value: [
        { heading: "Summary", markdown: "First" },
        { heading: "Decisions", markdown: "Second" },
      ],
    });
  });

  test("preserves leading prose in a synthetic Notes section", () => {
    expect(parseSections("Context typed by a person.\n\n## Summary\nResult")).toEqual({
      ok: true,
      value: [
        { heading: "Notes", markdown: "Context typed by a person." },
        { heading: "Summary", markdown: "Result" },
      ],
    });
  });

  test("treats headings inside backtick and tilde fences as section markdown", () => {
    const fenced = [
      "## Examples",
      "```markdown",
      "## Backtick example",
      "```",
      "",
      "~~~md",
      "## Tilde example",
      "~~~",
      "",
      "## Outcome",
      "Done",
    ].join("\n");
    expect(parseSections(fenced)).toEqual({
      ok: true,
      value: [
        { heading: "Examples", markdown: "```markdown\n## Backtick example\n```\n\n~~~md\n## Tilde example\n~~~" },
        { heading: "Outcome", markdown: "Done" },
      ],
    });
    expect(renderSections([{ heading: "Examples", markdown: "```md\n## Allowed\n```" }]).ok).toBe(true);
  });

  test("rejects either marker token in section content", () => {
    for (const marker of [AI_BLOCK_START, AI_BLOCK_END]) {
      const result = renderSections([{ heading: "Summary", markdown: `unsafe ${marker}` }]);
      expect(result).toMatchObject({ ok: false, error: { code: "marker-in-markdown", sectionIndex: 0 } });
    }
  });

  test("rejects markdown that would create an ambiguous section boundary", () => {
    expect(renderSections([{ heading: "Summary", markdown: "text\n## Injected" }])).toMatchObject({
      ok: false,
      error: { code: "section-heading-in-markdown" },
    });
  });

  test("returns a distinct typed error for every section shape that cannot round-trip", () => {
    const cases: readonly [Section, string][] = [
      [{ heading: "   ", markdown: "" }, "empty-heading"],
      [{ heading: "one\ntwo", markdown: "" }, "multiline-heading"],
      [{ heading: `unsafe ${AI_BLOCK_START}`, markdown: "" }, "marker-in-heading"],
      [{ heading: "Summary", markdown: `unsafe ${AI_BLOCK_END}` }, "marker-in-markdown"],
      [{ heading: "Summary", markdown: "text\n## Split" }, "section-heading-in-markdown"],
      [{ heading: "Summary", markdown: "\nedge" }, "edge-newline-in-markdown"],
    ];
    for (const [section, code] of cases) {
      expect(renderSections([section])).toMatchObject({ ok: false, error: { kind: "section-error", code } });
    }
  });

  test("builds the initial scaffold with metadata, user region, and seeded sections", () => {
    const scaffold = buildNoteScaffold({
      captureTimestamp: "2026-08-15T14:03:20-07:00",
      transcriptWikilink: "Meetings\\Transcripts\\standup.md",
      title: "Standup",
      sections,
    });
    expect(scaffold.ok).toBe(true);
    if (!scaffold.ok) return;
    expect(scaffold.value).toStartWith("---\nshorthand-capture: 2026-08-15T14:03:20-07:00\nshorthand-transcript: \"[[Meetings/Transcripts/standup]]\"");
    expect(scaffold.value).toContain("# Standup\n\n<!-- shorthand:notes -->");
    expect(scaffold.value).toContain(`${AI_BLOCK_START}\n## Summary`);
    expect(locateAiBlock(scaffold.value).ok).toBe(true);
  });

  test("appends a scaffold to an existing note without changing existing bytes", () => {
    const original = "# Meeting\r\n\r\nTyped café\t  ";
    const result = appendNoteScaffold(original, [{ heading: "Summary", markdown: "" }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.slice(0, original.length)).toBe(original);
    expect(result.value).toContain("\r\n\r\n<!-- shorthand:notes -->\r\n\r\n<!-- shorthand:ai:start -->\r\n## Summary\r\n<!-- shorthand:ai:end -->");
  });

  test("refuses to repair malformed marker scaffolds", () => {
    expect(appendNoteScaffold(`text\n${AI_BLOCK_START}`, [])).toMatchObject({
      ok: false,
      error: { code: "end-marker-missing" },
    });
  });
});
