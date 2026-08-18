import { MAX_HEADING_CHARACTERS, MAX_SECTIONS } from "../agent/contract.js";
import { AI_BLOCK_END, AI_BLOCK_START, type Section } from "./markers.js";

export type TemplateSectionsResult =
  | Readonly<{ ok: true; sections: readonly Section[] }>
  | Readonly<{ ok: false; error: string }>;

/**
 * Turns a plain heading list into the sections a new note starts with.
 *
 * It lives in core, not in each host application, so every surface agrees on what a valid
 * heading list is; and it borrows the agent contract's own limits rather than inventing
 * parallel ones, because a scaffold the writer or the schema would later refuse is a note
 * that can never be enhanced. Errors are written for a person staring at a text field, not
 * lifted from zod: each one names the heading that has to change.
 */
export function parseTemplateSections(input: string): TemplateSectionsResult {
  const headings = input
    .split(/\r\n|\r|\n/)
    // A heading pasted out of an existing note arrives as "## Summary". Left alone it would
    // render as "## ## Summary", because renderSections adds the level-two prefix itself.
    // Whitespace after the hashes is required, so an Obsidian tag — "#project", no space —
    // is never mistaken for a heading marker; the `|$` arm drops a line of bare hashes.
    .map((line) => line.trim().replace(/^#{1,6}(?:[ \t]+|$)/, "").trim())
    .filter((line) => line.length > 0);
  if (headings.length === 0) {
    return { ok: false, error: "Enter at least one section heading, one per line." };
  }
  if (headings.length > MAX_SECTIONS) {
    return {
      ok: false,
      error: `Too many section headings: ${headings.length}. The limit is ${MAX_SECTIONS}, and the first one past it is "${abbreviate(headings[MAX_SECTIONS]!)}".`,
    };
  }
  const seen = new Set<string>();
  for (const heading of headings) {
    if (heading.length > MAX_HEADING_CHARACTERS) {
      return {
        ok: false,
        error: `Section heading "${abbreviate(heading)}" is ${heading.length} characters; the limit is ${MAX_HEADING_CHARACTERS}.`,
      };
    }
    if (heading.includes(AI_BLOCK_START) || heading.includes(AI_BLOCK_END)) {
      return {
        ok: false,
        error: `Section heading "${abbreviate(heading)}" contains a Shorthand ownership marker token.`,
      };
    }
    // Exact match, not case-folded: "## Agenda" and "## agenda" are distinct lines that parse
    // back out distinctly, so they are two real sections. Two *identical* ones are a typo in a
    // list the user typed by hand — nothing downstream breaks on them, which is exactly why
    // they would go unnoticed until the note came back with two sections of the same name.
    if (seen.has(heading)) {
      return {
        ok: false,
        error: `Section heading "${abbreviate(heading)}" appears more than once. Headings identify sections, so each must be unique.`,
      };
    }
    seen.add(heading);
  }
  return { ok: true, sections: headings.map((heading) => ({ heading, markdown: "" })) };
}

/**
 * Error text goes straight into one line of a modal. Quoting a 200-character heading in full
 * would push the part the reader has to act on off the screen.
 */
function abbreviate(heading: string): string {
  return heading.length <= 60 ? heading : `${heading.slice(0, 60)}…`;
}
