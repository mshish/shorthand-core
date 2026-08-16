import { open } from "node:fs/promises";

const path = process.argv[2];
if (path === undefined) throw new Error("Expected a file path.");
const handle = await open(path, "r+");
process.stdout.write("ready\n");

const close = async () => {
  await handle.close();
  process.exit(0);
};
process.once("SIGTERM", () => { void close(); });
process.once("SIGINT", () => { void close(); });
setInterval(() => {}, 1_000);
