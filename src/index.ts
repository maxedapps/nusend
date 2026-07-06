import { createApp } from "./app.ts";
import type { AppBindings } from "./bindings.ts";
import { releaseExpiredLeases } from "./queue/jobs.ts";

export { Dispatcher } from "./dispatch/dispatcher.ts";

const app = createApp();

export default {
  fetch: app.fetch,

  // Cron watchdog/janitor: recover expired leases and poke the dispatcher.
  // The poke itself checks for registered-kind work and no-ops when idle, so
  // the watchdog never processes jobs and needs no pre-check query.
  async scheduled(_controller, env, _ctx) {
    await releaseExpiredLeases(env.DB);

    const dispatcher = env.DISPATCHER.get(env.DISPATCHER.idFromName("dispatcher"));
    await dispatcher.poke();
  },
} satisfies ExportedHandler<AppBindings>;
