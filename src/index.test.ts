import {
  createExecutionContext,
  createScheduledController,
  runDurableObjectAlarm,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  seedContact,
  seedJob,
  seedList,
  seedMailing,
  seedMembership,
  selectAll,
  selectSingle,
} from "../test/helpers.ts";
import worker from "./index.ts";

async function runScheduled(): Promise<void> {
  const controller = createScheduledController({
    cron: "*/5 * * * *",
    scheduledTime: new Date(),
  });
  const context = createExecutionContext();
  await worker.scheduled(controller, env, context);
  await waitOnExecutionContext(context);
}

describe("scheduled watchdog", () => {
  it("releases expired leases without processing jobs", async () => {
    await seedJob({
      attempts: 1,
      id: "expired",
      kind: "send_delivery",
      lockedBy: "dead_worker",
      lockedUntil: "2020-01-01T00:00:00.000Z",
      state: "leased",
    });

    await runScheduled();

    expect(
      await selectSingle("SELECT state, locked_by AS lockedBy FROM jobs WHERE id = 'expired';"),
    ).toEqual({
      lockedBy: null,
      state: "queued",
    });
    // The dispatcher is poked unconditionally, but with no registered-kind
    // work queued the poke arms no alarm.
    const stub = env.DISPATCHER.get(env.DISPATCHER.idFromName("dispatcher"));
    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });

  it("pokes the dispatcher when registered-kind work is queued", async () => {
    await seedList("list_1");
    await seedContact("c1", "c1@example.com");
    await seedMembership("list_1", "c1");
    await seedMailing({ id: "mailing_1", listId: "list_1", purpose: "marketing" });
    await seedJob({
      id: "expand_mailing:mailing_1",
      kind: "expand_mailing",
      payloadJson: JSON.stringify({ mailingId: "mailing_1" }),
      refId: "mailing_1",
    });

    await runScheduled();

    const stub = env.DISPATCHER.get(env.DISPATCHER.idFromName("dispatcher"));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await selectAll("SELECT email FROM deliveries WHERE mailing_id = 'mailing_1';")).toEqual(
      [{ email: "c1@example.com" }],
    );
  });
});
