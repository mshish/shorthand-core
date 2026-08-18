import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MAX_HEADING_CHARACTERS, MAX_SECTIONS } from "../src/agent/contract.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { AI_BLOCK_END, AI_BLOCK_START } from "../src/note/markers.js";
import { parseTemplateSections } from "../src/note/template.js";
import { ensureNoteScaffold } from "../src/note/writer.js";

const scratchDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(scratchDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("parseTemplateSections", () => {
  test("takes one heading per line, trimmed, with blank lines ignored", () => {
    expect(parseTemplateSections("  Agenda \n\n\tDecisions\n \nOpen questions\n")).toEqual({
      ok: true,
      sections: [
        { heading: "Agenda", markdown: "" },
        { heading: "Decisions", markdown: "" },
        { heading: "Open questions", markdown: "" },
      ],
    });
  });

  test("handles CRLF, because a Windows text field and a synced data.json both produce it", () => {
    expect(parseTemplateSections("Agenda\r\nDecisions")).toEqual({
      ok: true,
      sections: [{ heading: "Agenda", markdown: "" }, { heading: "Decisions", markdown: "" }],
    });
  });

  // Pins the plugin's placeholder text against the real default: if either moves, this fails.
  test("round-trips the built-in default headings", () => {
    expect(parseTemplateSections("Summary\nDecisions\nAction items")).toEqual({
      ok: true,
      sections: DEFAULT_CONFIG.templateSections,
    });
  });

  test("accepts exactly MAX_SECTIONS headings", () => {
    const input = Array.from({ length: MAX_SECTIONS }, (_value, index) => `Heading ${index}`).join("\n");
    const result = parseTemplateSections(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sections).toHaveLength(MAX_SECTIONS);
  });

  test("rejects input with no headings at all", () => {
    for (const input of ["", "   ", "\n\n", " \r\n\t \n"]) {
      expect(parseTemplateSections(input)).toEqual({
        ok: false,
        error: "Enter at least one section heading, one per line.",
      });
    }
  });

  test("rejects too many headings and names the first one past the limit", () => {
    const input = Array.from({ length: MAX_SECTIONS + 2 }, (_value, index) => `Heading ${index}`).join("\n");
    const result = parseTemplateSections(input);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.error).toContain(String(MAX_SECTIONS + 2));
      expect(result.error).toContain(String(MAX_SECTIONS));
      expect(result.error).toContain(`Heading ${MAX_SECTIONS}`);
    }
  });

  test("rejects an over-long heading, naming a recognisable prefix rather than the whole thing", () => {
    const heading = `Quarterly ${"x".repeat(MAX_HEADING_CHARACTERS)}`;
    const result = parseTemplateSections(`Agenda\n${heading}`);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.error).toContain("Quarterly");
      expect(result.error).toContain(String(heading.length));
      expect(result.error).toContain(String(MAX_HEADING_CHARACTERS));
      // The message goes straight into a modal line; a 200-character heading must not push
      // the actionable part of it off the screen.
      expect(result.error).toContain("…");
      expect(result.error.length).toBeLessThan(200);
    }
  });

  test("rejects a marker token in a heading and names the heading", () => {
    for (const token of [AI_BLOCK_START, AI_BLOCK_END]) {
      const result = parseTemplateSections(`Agenda\nNotes ${token}`);
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) {
        expect(result.error).toContain("Notes");
        expect(result.error).toContain("marker");
      }
    }
  });

  test("rejects duplicate headings and names the repeat", () => {
    const result = parseTemplateSections("Agenda\nDecisions\nAgenda");
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.error).toContain("Agenda");
      expect(result.error).toContain("more than once");
    }
  });

  test("keeps headings that differ only in case, because they parse back out as two sections", () => {
    expect(parseTemplateSections("Agenda\nagenda")).toMatchObject({ ok: true });
  });

  test("strips a pasted heading marker, which renderSections would otherwise double", () => {
    // "## Summary" is the likeliest paste — straight out of an existing note. Without the
    // strip it renders as "## ## Summary".
    expect(parseTemplateSections("## Summary\n#  Agenda\n###\tRisks\n##\n#project")).toEqual({
      ok: true,
      sections: [
        { heading: "Summary", markdown: "" },
        { heading: "Agenda", markdown: "" },
        { heading: "Risks", markdown: "" },
        // A bare "##" line strips to nothing and drops out; "#project" has no space after the
        // hash, so it is an Obsidian tag being used as a heading and survives intact.
        { heading: "#project", markdown: "" },
      ],
    });
  });

  // The reason the limits are borrowed from the agent contract instead of invented here:
  // a scaffold the writer would refuse is a note that can never be enhanced.
  test("parsed sections are accepted by the real scaffold writer", async () => {
    const directory = await mkdtemp(join(tmpdir(), ".template-scaffold-test-"));
    scratchDirectories.push(directory);
    const path = join(directory, "note.md");
    await writeFile(path, "# Existing\n\nUser text.\n", "utf8");
    const parsed = parseTemplateSections("Agenda\nOpen questions");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(await ensureNoteScaffold(path, parsed.sections)).toEqual({ status: "written" });
    const written = await readFile(path, "utf8");
    expect(written).toContain(`${AI_BLOCK_START}\n## Agenda\n\n## Open questions\n${AI_BLOCK_END}`);
  });

  test("reaches the package entry point, since the plugin resolves it by package name", async () => {
    const entry = await import("../src/index.js");
    expect(entry.parseTemplateSections("Agenda")).toEqual({
      ok: true,
      sections: [{ heading: "Agenda", markdown: "" }],
    });
  });
});
