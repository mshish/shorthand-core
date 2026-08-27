import { createHash } from "node:crypto";

/** The Markdown adapter's opaque revision for the AI-owned block. */
export function hashBlock(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}
