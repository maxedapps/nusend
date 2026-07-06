import { describe, expect, it } from "vitest";

import {
  db,
  seedContact,
  seedList,
  seedMailing,
  seedMembership,
  seedSuppression,
  selectAll,
} from "../../test/helpers.ts";
import type { QueueJob } from "../queue/jobs.ts";
import { createExpandMailingProcessor, type ExpandMailingPayload } from "./expand-mailing.ts";

const fixedNow = "2026-07-03T12:00:00.000Z";

function expandJob(payload: ExpandMailingPayload, priority = 0): QueueJob {
  return {
    attempts: 1,
    createdAt: fixedNow,
    id: `expand_mailing:${payload.mailingId}:${payload.afterContactId ?? "start"}`,
    kind: "expand_mailing",
    lastError: null,
    lockedBy: "test_worker",
    lockedUntil: null,
    maxAttempts: 10,
    payloadJson: JSON.stringify(payload),
    priority,
    refId: payload.mailingId,
    runAt: fixedNow,
    state: "leased",
    updatedAt: fixedNow,
  };
}

async function queuedExpandJobs(): Promise<{ id: string; payloadJson: string | null }[]> {
  return await selectAll(
    `SELECT id, payload_json AS payloadJson FROM jobs
     WHERE kind = 'expand_mailing' AND state = 'queued' ORDER BY id;`,
  );
}

async function seedListMailing(): Promise<void> {
  await seedList("list_1");
  for (const index of [1, 2, 3, 4, 5]) {
    await seedContact(`c${index}`, `c${index}@example.com`);
    await seedMembership("list_1", `c${index}`, index === 3 ? "2026-07-01T00:00:00.000Z" : null);
  }
  await seedMailing({
    id: "mailing_1",
    listId: "list_1",
    purpose: "marketing",
    scheduledAt: "2026-08-01T09:00:00.000Z",
  });
}

describe("expand_mailing processor", () => {
  it("expands a list in cursor chunks and stops when the audience is exhausted", async () => {
    await seedListMailing();
    const process = createExpandMailingProcessor(db, {
      chunkSize: 2,
      now: () => fixedNow,
    });

    // Chunk 1: c1, c2 (c3 is unsubscribed and never read into a delivery).
    await process(expandJob({ mailingId: "mailing_1" }));

    expect(
      await selectAll(
        "SELECT email, status FROM deliveries WHERE mailing_id = 'mailing_1' ORDER BY email;",
      ),
    ).toEqual([
      { email: "c1@example.com", status: "queued" },
      { email: "c2@example.com", status: "queued" },
    ]);
    expect(await queuedExpandJobs()).toEqual([
      {
        id: "expand_mailing:mailing_1:c2",
        payloadJson: JSON.stringify({ afterContactId: "c2", mailingId: "mailing_1" }),
      },
    ]);

    // Chunk 2: c4, c5. The chunk is full, so a further cursor job is queued.
    await process(expandJob({ afterContactId: "c2", mailingId: "mailing_1" }));
    // Chunk 3: empty, expansion completes without queuing more work.
    await process(expandJob({ afterContactId: "c5", mailingId: "mailing_1" }));

    const deliveries = await selectAll(
      "SELECT email, status FROM deliveries WHERE mailing_id = 'mailing_1' ORDER BY email;",
    );
    expect(deliveries.map((row) => row.email)).toEqual([
      "c1@example.com",
      "c2@example.com",
      "c4@example.com",
      "c5@example.com",
    ]);

    // Send jobs use the mailing's scheduled_at and marketing priority 0.
    const sendJobs = await selectAll(
      `SELECT jobs.state, jobs.priority, jobs.run_at AS runAt FROM jobs WHERE kind = 'send_delivery';`,
    );
    expect(sendJobs).toHaveLength(4);
    for (const job of sendJobs) {
      expect(job).toEqual({ priority: 0, runAt: "2026-08-01T09:00:00.000Z", state: "queued" });
    }
    // This test drives chunks with synthetic jobs, so the queued cursor jobs
    // are never claimed/completed; the final (empty) chunk added no new one.
    expect(await queuedExpandJobs()).toEqual([
      {
        id: "expand_mailing:mailing_1:c2",
        payloadJson: JSON.stringify({ afterContactId: "c2", mailingId: "mailing_1" }),
      },
      {
        id: "expand_mailing:mailing_1:c5",
        payloadJson: JSON.stringify({ afterContactId: "c5", mailingId: "mailing_1" }),
      },
    ]);
  });

  it("is idempotent when the same chunk is retried", async () => {
    await seedListMailing();
    const process = createExpandMailingProcessor(db, { chunkSize: 2, now: () => fixedNow });

    await process(expandJob({ mailingId: "mailing_1" }));
    await process(expandJob({ mailingId: "mailing_1" }));

    const deliveries = await selectAll(
      "SELECT email FROM deliveries WHERE mailing_id = 'mailing_1';",
    );
    expect(deliveries).toHaveLength(2);

    const sendJobs = await selectAll("SELECT id FROM jobs WHERE kind = 'send_delivery';");
    expect(sendJobs).toHaveLength(2);

    expect(await queuedExpandJobs()).toHaveLength(1);
  });

  it("marks suppressed members as suppressed deliveries without send jobs", async () => {
    await seedListMailing();
    await seedSuppression({ email: "c1@example.com", scope: "marketing" });
    const process = createExpandMailingProcessor(db, { chunkSize: 10, now: () => fixedNow });

    await process(expandJob({ mailingId: "mailing_1" }));

    expect(
      await selectAll(
        "SELECT email, status FROM deliveries WHERE mailing_id = 'mailing_1' ORDER BY email;",
      ),
    ).toEqual([
      { email: "c1@example.com", status: "suppressed" },
      { email: "c2@example.com", status: "queued" },
      { email: "c4@example.com", status: "queued" },
      { email: "c5@example.com", status: "queued" },
    ]);
    expect(await selectAll("SELECT id FROM jobs WHERE kind = 'send_delivery';")).toHaveLength(3);
  });

  it("excludes members who subscribed after the mailing was created", async () => {
    await seedListMailing();
    await seedContact("c9_late", "c9_late@example.com");
    await seedMembership("list_1", "c9_late", null, "2027-01-01T00:00:00.000Z");
    const process = createExpandMailingProcessor(db, { chunkSize: 10, now: () => fixedNow });

    await process(expandJob({ mailingId: "mailing_1" }));

    const deliveries = await selectAll(
      "SELECT email FROM deliveries WHERE mailing_id = 'mailing_1' ORDER BY email;",
    );
    expect(deliveries.map((row) => row.email)).toEqual([
      "c1@example.com",
      "c2@example.com",
      "c4@example.com",
      "c5@example.com",
    ]);
  });

  it("handles chunks that exceed the multi-row insert and IN-lookup limits", async () => {
    await seedList("big_list");
    for (let index = 0; index < 95; index += 1) {
      const id = `m${String(index).padStart(3, "0")}`;
      await seedContact(id, `${id}@example.com`);
      await seedMembership("big_list", id);
    }
    await seedMailing({ id: "mailing_big", listId: "big_list", purpose: "marketing" });
    // 95 recipients in one chunk: delivery inserts split into several
    // statements (12 rows each) and send-job inserts into two IN chunks (90+5).
    const process = createExpandMailingProcessor(db, { chunkSize: 95, now: () => fixedNow });

    await process(expandJob({ mailingId: "mailing_big" }));

    expect(
      await selectAll(
        "SELECT COUNT(*) AS count FROM deliveries WHERE mailing_id = 'mailing_big' AND status = 'queued';",
      ),
    ).toEqual([{ count: 95 }]);
    expect(
      await selectAll(
        "SELECT COUNT(*) AS count FROM jobs WHERE kind = 'send_delivery' AND state = 'queued';",
      ),
    ).toEqual([{ count: 95 }]);
    expect(await queuedExpandJobs()).toEqual([
      {
        id: "expand_mailing:mailing_big:m094",
        payloadJson: JSON.stringify({ afterContactId: "m094", mailingId: "mailing_big" }),
      },
    ]);
  });

  it("fails when the mailing is missing or has no list", async () => {
    const process = createExpandMailingProcessor(db, { now: () => fixedNow });

    await expect(process(expandJob({ mailingId: "missing" }))).rejects.toThrow(
      "Mailing 'missing' not found.",
    );

    await seedMailing({ id: "mailing_direct", listId: null });
    await expect(process(expandJob({ mailingId: "mailing_direct" }))).rejects.toThrow(
      "has no list to expand",
    );
  });
});
