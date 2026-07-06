import { describe, expect, it } from "vitest";

import { db, seedList, selectAll, selectSingle } from "../../test/helpers.ts";
import { createMailing, CreateMailingError } from "./create-mailing.ts";
import type { CreateMailingInput } from "./validation.ts";

const listInput: CreateMailingInput = {
  html: "<p>News</p>",
  listId: "list_1",
  name: null,
  purpose: "marketing",
  recipients: null,
  scheduledAt: "2026-08-01T09:00:00.000Z",
  subject: "News",
  text: null,
};

describe("createMailing (list path)", () => {
  it("creates the mailing and a single expand_mailing job instead of deliveries", async () => {
    await seedList("list_1");

    const result = await createMailing(db, listInput, {
      now: () => "2026-07-03T12:00:00.000Z",
    });

    expect(result.counts).toEqual({ deliveries: 0, queued: 0, suppressed: 0 });
    expect(result.mailing.state).toBe("scheduled");

    expect(
      await selectSingle(
        "SELECT state, list_id AS listId FROM mailings WHERE id = ?1;",
        result.mailing.id,
      ),
    ).toEqual({ listId: "list_1", state: "scheduled" });
    expect(await selectAll("SELECT id FROM deliveries;")).toEqual([]);
    // Expansion runs immediately even for future-scheduled mailings; only the
    // send jobs it creates carry the scheduled_at.
    expect(
      await selectAll(
        `SELECT id, kind, state, priority, run_at AS runAt, ref_id AS refId, payload_json AS payloadJson FROM jobs;`,
      ),
    ).toEqual([
      {
        id: `expand_mailing:${result.mailing.id}`,
        kind: "expand_mailing",
        payloadJson: JSON.stringify({ mailingId: result.mailing.id }),
        priority: 0,
        refId: result.mailing.id,
        runAt: "2026-07-03T12:00:00.000Z",
        state: "queued",
      },
    ]);
  });

  it("rejects unknown lists", async () => {
    await expect(createMailing(db, listInput)).rejects.toThrow(CreateMailingError);
    await expect(createMailing(db, listInput)).rejects.toThrow("List not found.");
  });
});
