import { printJson } from "../output/format.js";
import { requireApi, type CommandContext } from "./context.js";

export async function runWhoamiCommand(context: CommandContext): Promise<void> {
  const me = await requireApi(context).whoami();
  if (context.json) {
    printJson(me);
    return;
  }

  if (me.principal.kind === "session") {
    console.log(`session user=${me.principal.userId} permissions: owner`);
    return;
  }

  const permissions = Object.entries(me.principal.permissions)
    .flatMap(([resource, actions]) => actions.map((action) => `${resource}:${action}`))
    .sort()
    .join(", ");
  console.log(
    `api_key user=${me.principal.userId} key=${me.principal.apiKeyId} permissions: ${permissions || "none"}`,
  );
}
