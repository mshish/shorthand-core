import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { access, chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AI_BLOCK_END, AI_BLOCK_START, detectLineEnding, locateAiBlock, type MarkerErrorCode, type Section } from "../src/note/markers.js";
import { ensureNoteScaffold, readCurrentBlock, writeSections } from "../src/note/writer.js";

const scratchDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(scratchDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("core scaffold writer", () => {
  test("adds the scaffold atomically while preserving the original prefix", async () => {
    const original = "# Existing\n\nUser text.\n";
    const path = await scratchNote(original);
    expect(await ensureNoteScaffold(path, [{ heading: "Summary", markdown: "" }]))
      .toEqual({ status: "written" });
    const updated = await readFile(path, "utf8");
    expect(updated.slice(0, original.length)).toBe(original);
    expect(updated).toContain(AI_BLOCK_START);
    expect(await ensureNoteScaffold(path, [{ heading: "Ignored", markdown: "" }]))
      .toEqual({ status: "unchanged" });
  });
});

async function scratchNote(content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), ".block-writer-test-"));
  scratchDirectories.push(directory);
  const path = join(directory, "note.md");
  await writeFile(path, content, "utf8");
  return path;
}

const updatedSections: readonly Section[] = [
  { heading: "Summary", markdown: "Fresh summary" },
  { heading: "Next steps", markdown: "- ship it" },
];

describe("BlockWriter fail-closed behavior", () => {
  const anomalies: readonly [string, MarkerErrorCode][] = [
    ["plain", "markers-missing"],
    [AI_BLOCK_END, "start-marker-missing"],
    [AI_BLOCK_START, "end-marker-missing"],
    [`${AI_BLOCK_START}${AI_BLOCK_END}${AI_BLOCK_START}`, "duplicate-start-marker"],
    [`${AI_BLOCK_START}${AI_BLOCK_END}${AI_BLOCK_END}`, "duplicate-end-marker"],
    [`${AI_BLOCK_START}${AI_BLOCK_START}${AI_BLOCK_END}${AI_BLOCK_END}`, "nested-markers"],
    [`${AI_BLOCK_END}${AI_BLOCK_START}`, "end-before-start"],
  ];

  test("every marker anomaly returns its typed error and causes no write", async () => {
    for (const [content, code] of anomalies) {
      const path = await scratchNote(content);
      const result = await writeSections(path, updatedSections, "observed");
      expect(result).toMatchObject({ status: "error", error: { kind: "marker-error", code } });
      expect(await readFile(path, "utf8")).toBe(content);
    }
  });

  test("rejects marker-bearing section content before any file operation", async () => {
    let reads = 0;
    const result = await writeSections("not-used.md", [{ heading: "Bad", markdown: AI_BLOCK_END }], "hash", {
      fileSystem: { readFile: (async () => { reads += 1; return ""; }) as unknown as typeof readFile },
    });
    expect(result).toMatchObject({ status: "error", error: { code: "marker-in-markdown" } });
    expect(reads).toBe(0);
  });

  test("reports a missing note without creating it", async () => {
    const directory = await mkdtemp(join(tmpdir(), ".block-writer-missing-test-"));
    scratchDirectories.push(directory);
    const path = join(directory, "missing.md");
    expect(await writeSections(path, updatedSections, "hash")).toMatchObject({ status: "error", error: { code: "note-missing" } });
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });

  test("reports a read-only note before writing", async () => {
    const path = await scratchNote(`${AI_BLOCK_START}\n${AI_BLOCK_END}`);
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    expect(await writeSections(path, updatedSections, "hash", {
      fileSystem: { access: async () => { throw denied; } },
    })).toMatchObject({ status: "error", error: { code: "note-read-only" } });
  });

  test("checks directory writability as a best-effort guard before creating a temp file", async () => {
    const path = await scratchNote(`${AI_BLOCK_START}\n${AI_BLOCK_END}`);
    const denied = Object.assign(new Error("directory denied"), { code: "EACCES" });
    expect(await writeSections(path, updatedSections, "hash", {
      fileSystem: {
        access: (async (candidate: string) => {
          if (candidate === dirname(path)) throw denied;
          if (candidate === path) return;
          throw denied;
        }) as unknown as typeof access,
      },
    })).toMatchObject({ status: "error", error: { code: "note-read-only" } });
  });

  test("returns a structured error for runtime-invalid section fields", async () => {
    const result = await writeSections("not-used.md", [{ heading: "Summary", markdown: 42 } as unknown as Section], "hash");
    expect(result).toMatchObject({ status: "error", error: { code: "invalid-section", sectionIndex: 0 } });
  });
});

describe("BlockWriter ownership and concurrency", () => {
  test("serializes in-process writers with an exclusive note lock", async () => {
    const path = await scratchNote(`${AI_BLOCK_START}\nold\n${AI_BLOCK_END}`);
    const observed = await readCurrentBlock(path);
    if (!observed.ok) throw new Error(observed.error.message);
    let releaseFirst!: () => void;
    const held = new Promise<void>((resolveHeld) => { releaseFirst = resolveHeld; });
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolveEntered) => { signalEntered = resolveEntered; });
    const first = writeSections(path, updatedSections, observed.value.hash, {
      beforeTemporaryWrite: async () => { signalEntered(); await held; },
    });
    await entered;
    const second = await writeSections(path, updatedSections, observed.value.hash, { maxOutsideEditRetries: 2 });
    expect(second).toEqual({ status: "retry", reason: "writer-busy" });
    releaseFirst();
    expect((await first).status).toBe("written");
  });
  test("writing the same sections twice is byte-identical", async () => {
    const path = await scratchNote(`before\n${AI_BLOCK_START}\n${AI_BLOCK_END}\nafter`);
    const firstSnapshot = await readCurrentBlock(path);
    expect(firstSnapshot.ok).toBe(true);
    if (!firstSnapshot.ok) return;
    expect((await writeSections(path, updatedSections, firstSnapshot.value.hash)).status).toBe("written");
    const once = await readFile(path, "utf8");
    const secondSnapshot = await readCurrentBlock(path);
    expect(secondSnapshot.ok).toBe(true);
    if (!secondSnapshot.ok) return;
    expect((await writeSections(path, updatedSections, secondSnapshot.value.hash)).status).toBe("unchanged");
    expect(await readFile(path, "utf8")).toBe(once);
  });

  test("preserves every byte outside markers across varied property-style cases", async () => {
    const cases = [
      { above: "tabs\t and trailing   \n雪 café\n", below: "\nend\t  \n" },
      { above: "---\r\nexisting: frontmatter\r\n---\r\n# Title\r\n", below: "\r\n\tfooter 🚀" },
      { above: "no-newline-above", below: "missing-trailing-newline" },
      { above: "mixed is preserved\r\nnext\n", below: "\r\nlast   " },
    ];
    for (const { above, below } of cases) {
      const original = `${above}${AI_BLOCK_START}\r\nold\t body  \r\n${AI_BLOCK_END}${below}`;
      const path = await scratchNote(original);
      const locatedBefore = locateAiBlock(original);
      expect(locatedBefore.ok).toBe(true);
      if (!locatedBefore.ok) continue;
      const snapshot = await readCurrentBlock(path);
      if (!snapshot.ok) throw new Error(snapshot.error.message);
      expect((await writeSections(path, updatedSections, snapshot.value.hash)).status).toBe("written");
      const after = await readFile(path, "utf8");
      const locatedAfter = locateAiBlock(after);
      expect(locatedAfter.ok).toBe(true);
      if (!locatedAfter.ok) continue;
      expect(after.slice(0, locatedAfter.value.bodyStartOffset)).toBe(original.slice(0, locatedBefore.value.bodyStartOffset));
      expect(after.slice(locatedAfter.value.bodyEndOffset)).toBe(original.slice(locatedBefore.value.bodyEndOffset));
      const lineEnding = detectLineEnding(original);
      expect(after.includes(`${lineEnding}## Summary${lineEnding}Fresh summary${lineEnding}`)).toBe(true);
    }
  });

  test("returns stale and leaves the file untouched when the observed block hash differs", async () => {
    const original = `${AI_BLOCK_START}\nuser edit\n${AI_BLOCK_END}`;
    const path = await scratchNote(original);
    const result = await writeSections(path, updatedSections, "outdated-hash");
    expect(result).toMatchObject({ status: "stale", expectedHash: "outdated-hash" });
    expect(await readFile(path, "utf8")).toBe(original);
  });

  test("catches an external in-block edit interleaved between read and temporary write", async () => {
    const original = `user prefix\n${AI_BLOCK_START}\nold\n${AI_BLOCK_END}\nuser suffix`;
    const path = await scratchNote(original);
    const observed = await readCurrentBlock(path);
    if (!observed.ok) throw new Error(observed.error.message);
    const externallyEdited = original.replace("\nold\n", "\nexternal edit\n");
    let injected = false;
    const result = await writeSections(path, updatedSections, observed.value.hash, {
      beforeTemporaryWrite: async () => {
        if (injected) return;
        injected = true;
        await writeFile(path, externallyEdited, "utf8");
      },
    });
    expect(result).toMatchObject({ status: "stale" });
    expect(await readFile(path, "utf8")).toBe(externallyEdited);
  });

  test("re-reads and preserves an interleaved edit outside the block", async () => {
    const original = `before\n${AI_BLOCK_START}\nold\n${AI_BLOCK_END}\nafter`;
    const path = await scratchNote(original);
    const observed = await readCurrentBlock(path);
    if (!observed.ok) throw new Error(observed.error.message);
    let injected = false;
    const result = await writeSections(path, updatedSections, observed.value.hash, {
      beforeTemporaryWrite: async () => {
        if (injected) return;
        injected = true;
        await writeFile(path, original.replace("before", "external before"), "utf8");
      },
    });
    expect(result.status).toBe("written");
    expect(await readFile(path, "utf8")).toStartWith("external before\n");
  });

  test("an atomic rename failure leaves the original note intact", async () => {
    const original = `before\n${AI_BLOCK_START}\nold\n${AI_BLOCK_END}\nafter`;
    const path = await scratchNote(original);
    const observed = await readCurrentBlock(path);
    if (!observed.ok) throw new Error(observed.error.message);
    const failure = Object.assign(new Error("simulated rename failure"), { code: "EIO" });
    const result = await writeSections(path, updatedSections, observed.value.hash, {
      fileSystem: { rename: async () => { throw failure; } },
    });
    expect(result).toMatchObject({ status: "error", error: { code: "write-failed" } });
    expect(await readFile(path, "utf8")).toBe(original);
  });

  test("retries rename contention with backoff and returns distinct note-locked status", async () => {
    const original = `${AI_BLOCK_START}\nold\n${AI_BLOCK_END}`;
    const path = await scratchNote(original);
    const observed = await readCurrentBlock(path);
    if (!observed.ok) throw new Error(observed.error.message);
    let attempts = 0;
    const locked = Object.assign(new Error("sharing violation"), { code: "EPERM" });
    const started = Date.now();
    const result = await writeSections(path, updatedSections, observed.value.hash, {
      fileSystem: { rename: async () => { attempts += 1; throw locked; } },
    });
    expect(result).toMatchObject({ status: "note-locked", attempts: 6 });
    expect(attempts).toBe(6);
    expect(Date.now() - started).toBeGreaterThanOrEqual(600);
    expect(await readFile(path, "utf8")).toBe(original);
  }, 5_000);

  test("returns retry after maxOutsideEditRetries while an outside writer keeps changing the note", async () => {
    const original = `before 0\n${AI_BLOCK_START}\nold\n${AI_BLOCK_END}`;
    const path = await scratchNote(original);
    const observed = await readCurrentBlock(path);
    if (!observed.ok) throw new Error(observed.error.message);
    let edits = 0;
    const started = Date.now();
    const result = await writeSections(path, updatedSections, observed.value.hash, {
      maxOutsideEditRetries: 3,
      beforeTemporaryWrite: async () => {
        edits += 1;
        const current = await readFile(path, "utf8");
        await writeFile(path, current.replace(/before \d+/, `before ${edits}`), "utf8");
      },
    });
    expect(result).toEqual({ status: "retry", reason: "outside-edits" });
    expect(edits).toBe(3);
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
    expect(await readFile(path, "utf8")).toStartWith("before 3\n");
  });

  test("returns note-locked when another process holds the target open on Windows", async () => {
    if (process.platform !== "win32") return;
    const original = `${AI_BLOCK_START}\nold\n${AI_BLOCK_END}`;
    const path = await scratchNote(original);
    const observed = await readCurrentBlock(path);
    if (!observed.ok) throw new Error(observed.error.message);
    const helper = spawn(process.execPath, [join(process.cwd(), "test", "fixtures", "hold-open.mjs"), path], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    await new Promise<void>((resolveReady, rejectReady) => {
      helper.once("error", rejectReady);
      helper.stdout.once("data", (chunk: Buffer) => chunk.toString("utf8").includes("ready") && resolveReady());
    });
    try {
      expect(await writeSections(path, updatedSections, observed.value.hash)).toMatchObject({ status: "note-locked" });
      expect(await readFile(path, "utf8")).toBe(original);
    } finally {
      helper.kill();
      await new Promise<void>((resolveClose) => helper.once("close", () => resolveClose()));
    }
  }, 5_000);

  test("preserves POSIX target permissions across atomic replacement", async () => {
    if (process.platform === "win32") return;
    const path = await scratchNote(`${AI_BLOCK_START}\nold\n${AI_BLOCK_END}`);
    await chmod(path, 0o600);
    const observed = await readCurrentBlock(path);
    if (!observed.ok) throw new Error(observed.error.message);
    expect((await writeSections(path, updatedSections, observed.value.hash)).status).toBe("written");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("a note deleted between read and write is not recreated", async () => {
    const original = `${AI_BLOCK_START}\nold\n${AI_BLOCK_END}`;
    const path = await scratchNote(original);
    const observed = await readCurrentBlock(path);
    if (!observed.ok) throw new Error(observed.error.message);
    const result = await writeSections(path, updatedSections, observed.value.hash, {
      beforeTemporaryWrite: async () => { await rm(path); },
    });
    expect(result).toMatchObject({ status: "error", error: { code: "note-missing" } });
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });
});
