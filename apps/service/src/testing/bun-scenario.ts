import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryDirectories: string[] = [];

export function cleanupBunScenarios(): void {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
}

export function runBunScenario(script: string, cwd: string) {
  const directory = mkdtempSync(join(tmpdir(), "nusend-bun-scenario-"));
  temporaryDirectories.push(directory);
  const scriptPath = join(directory, "scenario.ts");
  writeFileSync(scriptPath, script);

  return spawnSync("bun", [scriptPath], {
    cwd,
    encoding: "utf8",
  });
}
