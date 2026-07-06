import { describe, expect, it } from "vitest";

import { db, seedList, seedSuppression } from "../../test/helpers.ts";
import { findSuppressedEmails } from "./suppressions.ts";

describe("findSuppressedEmails", () => {
  it("applies the scope matrix for transactional and marketing mail", async () => {
    await seedList("list_a");
    await seedList("list_b");
    await seedSuppression({ email: "all@example.com", scope: "all" });
    await seedSuppression({ email: "marketing@example.com", scope: "marketing" });
    await seedSuppression({ email: "lista@example.com", listId: "list_a", scope: "list" });
    await seedSuppression({ email: "listb@example.com", listId: "list_b", scope: "list" });
    const emails = [
      "all@example.com",
      "marketing@example.com",
      "lista@example.com",
      "listb@example.com",
      "free@example.com",
    ];

    // Transactional mail is only blocked by scope=all.
    expect(
      await findSuppressedEmails(db, { emails, listId: null, purpose: "transactional" }),
    ).toEqual(new Set(["all@example.com"]));

    // Marketing mail honors all/marketing plus the matching list scope only.
    expect(
      await findSuppressedEmails(db, { emails, listId: "list_a", purpose: "marketing" }),
    ).toEqual(new Set(["all@example.com", "marketing@example.com", "lista@example.com"]));
  });

  it("chunks lookups beyond the bound-parameter limit", async () => {
    await seedSuppression({ email: "blocked_150@example.com", scope: "all" });
    const emails = Array.from({ length: 200 }, (_, index) => `blocked_${index}@example.com`);

    expect(
      await findSuppressedEmails(db, { emails, listId: null, purpose: "transactional" }),
    ).toEqual(new Set(["blocked_150@example.com"]));
  });
});
