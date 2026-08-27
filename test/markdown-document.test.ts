import { describe, expect, test } from "bun:test";
import {
  readMarkdownDocument,
  scaffoldMarkdownDocument,
  updateMarkdownDocument,
  type MarkdownTextEdit,
} from "shorthand-core/markdown";
import { AI_BLOCK_END, AI_BLOCK_START, type Section } from "../src/note/markers.js";

const SECTIONS: readonly Section[] = [
  { heading: "Summary", markdown: "Fresh" },
  { heading: "Decisions", markdown: "- Ship it" },
];

function applyEdit(content: string, edit: MarkdownTextEdit): string {
  return content.slice(0, edit.from) + edit.replacement + content.slice(edit.to);
}

describe("Markdown document codec", () => {
  test("reads sections, user notes, and one stable opaque revision", () => {
    const content = `# Meeting\n\n<!-- shorthand:notes -->\nUser fact.\n\n${AI_BLOCK_START}\n## Summary\nOld\n${AI_BLOCK_END}\n`;
    const first = readMarkdownDocument(content);
    const second = readMarkdownDocument(content);
    expect(first).toEqual(second);
    if (!first.ok) throw new Error(first.error.message);
    expect(first.value.sections).toEqual([{ heading: "Summary", markdown: "Old" }]);
    expect(first.value.userNotes).toBe("User fact.");
    expect(first.value.revision).toHaveLength(64);
  });

  test("returns exact UTF-16 editor offsets and preserves every foreign byte", () => {
    const before = "😀 title\r\nforeign\t  ";
    const after = "\r\nfooter 雪  ";
    const content = `${before}${AI_BLOCK_START}\r\nold\r\n${AI_BLOCK_END}${after}`;
    const read = readMarkdownDocument(content);
    if (!read.ok) throw new Error(read.error.message);
    const result = updateMarkdownDocument(content, SECTIONS, read.value.revision);
    expect(result.status).toBe("written");
    if (result.status !== "written") return;

    expect(result.edit.from).toBe(before.length + AI_BLOCK_START.length);
    expect(result.edit.to).toBe(content.indexOf(AI_BLOCK_END));
    expect(result.edit.replacement).toBe("\r\n## Summary\r\nFresh\r\n\r\n## Decisions\r\n- Ship it\r\n");
    expect(applyEdit(content, result.edit)).toBe(result.content);
    expect(result.content.slice(0, result.edit.from)).toBe(content.slice(0, result.edit.from));
    expect(result.content.slice(result.edit.from + result.edit.replacement.length)).toBe(content.slice(result.edit.to));

    const reread = readMarkdownDocument(result.content);
    if (!reread.ok) throw new Error(reread.error.message);
    expect(reread.value.revision).toBe(result.revision);
  });

  test("checks invalid sections before revision and stale revision before equality", () => {
    const content = `${AI_BLOCK_START}\n## Summary\nOld\n${AI_BLOCK_END}`;
    expect(updateMarkdownDocument(
      content,
      [{ heading: "Bad", markdown: AI_BLOCK_END }],
      "stale",
    )).toMatchObject({ status: "error", error: { code: "invalid-content" } });

    expect(updateMarkdownDocument(
      content,
      [{ heading: "Summary", markdown: "Old" }],
      "stale",
    )).toMatchObject({ status: "stale", actualRevision: expect.any(String) });
  });

  test("reports unchanged only with the current revision", () => {
    const content = `${AI_BLOCK_START}\n## Summary\nOld\n${AI_BLOCK_END}`;
    const read = readMarkdownDocument(content);
    if (!read.ok) throw new Error(read.error.message);
    expect(updateMarkdownDocument(content, read.value.sections, read.value.revision)).toEqual({
      status: "unchanged",
      revision: read.value.revision,
    });
  });

  test("scaffolds by one exact insertion and refuses malformed ownership markers", () => {
    const content = "# Existing\n\nUser text.";
    const result = scaffoldMarkdownDocument(content, SECTIONS);
    expect(result.status).toBe("written");
    if (result.status !== "written") return;
    expect(result.edit).toEqual({
      from: content.length,
      to: content.length,
      replacement: result.content.slice(content.length),
    });
    expect(applyEdit(content, result.edit)).toBe(result.content);
    expect(scaffoldMarkdownDocument(result.content, [])).toEqual({ status: "unchanged" });
    expect(scaffoldMarkdownDocument(`${AI_BLOCK_START}\nbroken`, SECTIONS))
      .toMatchObject({ status: "error", error: { code: "invalid-target" } });
  });

  test("maps malformed stored sections to invalid-content", () => {
    expect(readMarkdownDocument(`${AI_BLOCK_START}\n## \nbody\n${AI_BLOCK_END}`))
      .toMatchObject({ ok: false, error: { code: "invalid-content" } });
  });
});
