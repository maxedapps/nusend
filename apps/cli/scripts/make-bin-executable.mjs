import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const binPath = join(scriptDirectory, "..", "dist", "main.js");

await chmod(binPath, 0o755);
