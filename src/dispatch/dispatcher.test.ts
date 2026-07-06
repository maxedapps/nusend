import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  seedContact,
  seedJob,
  seedList,
  seedMailing,
  seedMembership,
  selectAll,
} from "../../test/helpers.ts";

function dispatcherStub() {
  return env.DISPATCHER.get(env.DISPATCHER.idFromName("dispatcher"));
}

async function drainAlarms(stub: ReturnType<typeof dispatcherStub>): Promise<number> {
  let alarms = 0;
  while (await runDurableObjectAlarm(stub)) alarms += 1;
  return alarms;
}

describe("Dispatcher", () => {
  it("does not arm an alarm when no registered-kind work exists", async () => {
    const stub = dispatcherStub();

    await stub.poke();

    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });

  it("never claims or processes send_delivery jobs while no sender is registered", async () => {
    await seedJob({ id: "send_1", kind: "send_delivery" });
    const stub = dispatcherStub();

    await stub.poke();

    // send_delivery is not a registered kind, so the poke arms nothing.
    expect(await runDurableObjectAlarm(stub)).toBe(false);
    expect(await selectAll("SELECT id, state, attempts, locked_by AS lockedBy FROM jobs;")).toEqual(
      [{ attempts: 0, id: "send_1", lockedBy: null, state: "queued" }],
    );
  });

  it("processes expand_mailing jobs via alarms until the queue is drained", async () => {
    await seedList("list_1");
    for (const index of [1, 2, 3]) {
      await seedContact(`c${index}`, `c${index}@example.com`);
      await seedMembership("list_1", `c${index}`);
    }
    await seedMailing({ id: "mailing_1", listId: "list_1", purpose: "marketing" });
    await seedJob({
      id: "expand_mailing:mailing_1",
      kind: "expand_mailing",
      payloadJson: JSON.stringify({ mailingId: "mailing_1" }),
      refId: "mailing_1",
      runAt: "2026-07-03T11:00:00.000Z",
    });
    const stub = dispatcherStub();

    await stub.poke();
    const alarms = await drainAlarms(stub);

    expect(alarms).toBeGreaterThan(0);
    expect(
      await selectAll(
        "SELECT email, status FROM deliveries WHERE mailing_id = 'mailing_1' ORDER BY email;",
      ),
    ).toEqual([
      { email: "c1@example.com", status: "queued" },
      { email: "c2@example.com", status: "queued" },
      { email: "c3@example.com", status: "queued" },
    ]);

    // Expansion queues send jobs but never processes them.
    expect(
      await selectAll(
        "SELECT state, COUNT(*) AS count FROM jobs WHERE kind = 'send_delivery' GROUP BY state;",
      ),
    ).toEqual([{ count: 3, state: "queued" }]);
    expect(
      await selectAll(
        "SELECT state FROM jobs WHERE kind = 'expand_mailing' AND state != 'succeeded';",
      ),
    ).toEqual([]);

    // Without a sender, completed expansion must not imply sending started.
    expect(await selectAll("SELECT state FROM mailings WHERE id = 'mailing_1';")).toEqual([
      { state: "scheduled" },
    ]);
  });
});
