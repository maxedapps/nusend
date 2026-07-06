import { chunkValues } from "../lib/d1-batch.ts";
import type { MailingPurpose } from "./validation.ts";

// Keep IN (...) lookups safely below the 100-bound-param D1 limit, leaving
// room for the extra scope parameters.
const emailLookupChunkSize = 90;

export async function findSuppressedEmails(
  db: D1Database,
  input: { emails: string[]; listId: null | string; purpose: MailingPurpose },
): Promise<Set<string>> {
  const suppressed = new Set<string>();
  if (input.emails.length === 0) return suppressed;

  const isMarketing = input.purpose === "marketing";
  const scopePredicate = isMarketing
    ? "(scope IN ('all', 'marketing') OR (scope = 'list' AND list_id = ?))"
    : "scope = 'all'";

  for (const emails of chunkValues(input.emails, emailLookupChunkSize)) {
    const placeholders = emails.map(() => "?").join(", ");
    const params: (string | null)[] = [...emails];
    if (isMarketing) params.push(input.listId);

    const result = await db
      .prepare(
        `SELECT lower(email) AS email
         FROM suppressions
         WHERE email IN (${placeholders})
           AND ${scopePredicate};`,
      )
      .bind(...params)
      .all<{ email: string }>();

    for (const row of result.results) suppressed.add(row.email);
  }

  return suppressed;
}
