import { repairLocalStatePermissions } from "../config/local-state.js";
import { printJson } from "../output/format.js";
import type { CommandContext } from "./context.js";

export async function runConfigCommand(
  context: CommandContext,
  platformName = process.platform,
): Promise<void> {
  const repaired = await repairLocalStatePermissions(context.env, platformName);
  if (!repaired) {
    if (context.json) printJson({ applicable: false, platform: "win32" });
    else console.log("Permission repair is not applicable on Windows.");
    return;
  }
  if (context.json) printJson({ repaired: true });
  else console.log("Repaired Nusend config permissions.");
}
