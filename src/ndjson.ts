import { StringDecoder } from "node:string_decoder";

/**
 * Buffers raw chunks through `node:string_decoder` and yields only complete, newline-terminated
 * lines as strings. A chunk boundary is neither a UTF-8 character boundary nor a line boundary:
 * decoding each chunk independently with `chunk.toString("utf8")` turns a multi-byte character
 * split across two chunks into two U+FFFD replacement characters that concatenation can never
 * repair — and unlike a malformed line, the mangled result still parses as valid JSON, so nothing
 * downstream ever sees an error; a `displayName` or similar field is just silently wrong.
 * `StringDecoder` holds the incomplete trailing bytes of a split character until the chunk that
 * completes it arrives, before line splitting ever runs.
 *
 * Protocol-agnostic on purpose: this only knows about bytes and newlines, not JSON-RPC or this
 * repo's own wire records, so two different NDJSON-over-stdio consumers
 * (`stream/client.ts`'s `NdjsonDecoder` and `agent/codex-app-server.ts`'s JSON-RPC reader) can
 * each layer their own parsing on top without duplicating — and risking re-diverging on — the
 * byte-and-line framing underneath.
 */
export class Utf8LineReader {
  readonly #decoder = new StringDecoder("utf8");
  #tail = "";

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: Buffer): void {
    this.#consume(this.#decoder.write(chunk));
  }

  /** Flushes any bytes `StringDecoder` was holding back and, if a final line was never
   * newline-terminated, emits it too — a child process that exits without a trailing `\n` on
   * its last line must not silently lose that line. */
  end(chunk?: Buffer): void {
    this.#consume((chunk === undefined ? "" : this.#decoder.write(chunk)) + this.#decoder.end());
    if (this.#tail.length > 0) this.#emit(this.#tail);
    this.#tail = "";
  }

  #consume(text: string): void {
    this.#tail += text;
    let newline = this.#tail.indexOf("\n");
    while (newline >= 0) {
      const line = this.#tail.slice(0, newline).replace(/\r$/, "");
      this.#tail = this.#tail.slice(newline + 1);
      this.#emit(line);
      newline = this.#tail.indexOf("\n");
    }
  }

  #emit(line: string): void {
    if (line.length > 0) this.onLine(line);
  }
}
