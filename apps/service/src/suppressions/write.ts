import { Effect } from "effect";

import { ConflictError, DatabaseError, ListNotFoundError, NotFoundError } from "../errors.ts";
import { currentIso } from "../lib/iso-time.ts";
import { Database, type DatabaseService } from "../services/database.ts";
import { IdGenerator, type IdGeneratorService } from "../services/ids.ts";
import { getListRow } from "../lists/read-model.ts";
import { getSuppressionById, requireSuppressionById, type Suppression } from "./read-model.ts";
import type { CreateSuppressionInput } from "./schema.ts";

export type CreateSuppressionResult = {
  readonly created: boolean;
  readonly suppression: Suppression;
};

export type AutomatedSuppressionInput =
  | {
      readonly createdAt: string;
      readonly email: string;
      readonly id: string;
      readonly reason: "bounce" | "complaint";
      readonly scope: "all";
    }
  | {
      readonly createdAt: string;
      readonly email: string;
      readonly id: string;
      readonly reason: "unsubscribe";
      readonly scope: "marketing";
    };

export function upsertAutomatedSuppression(
  input: AutomatedSuppressionInput,
): Effect.Effect<void, DatabaseError, DatabaseService> {
  return Effect.flatMap(Database, (db) =>
    db.run(
      "suppressions:upsert-automated",
      `INSERT INTO suppressions (id, email, scope, list_id, reason, created_at)
       VALUES ($id, $email, $scope, NULL, $reason, $createdAt)
       ON CONFLICT(email, scope) WHERE list_id IS NULL
       DO UPDATE SET reason = CASE
         WHEN excluded.reason = 'complaint' AND suppressions.reason IN ('manual', 'bounce')
           THEN 'complaint'
         WHEN excluded.reason = 'bounce' AND suppressions.reason = 'manual'
           THEN 'bounce'
         WHEN excluded.reason = 'unsubscribe' AND suppressions.reason = 'manual'
           THEN 'unsubscribe'
         ELSE suppressions.reason
       END
       WHERE
         (excluded.reason = 'complaint' AND suppressions.reason IN ('manual', 'bounce'))
         OR (excluded.reason = 'bounce' AND suppressions.reason = 'manual')
         OR (excluded.reason = 'unsubscribe' AND suppressions.reason = 'manual');`,
      input,
    ),
  );
}

export function createManualSuppression(
  input: CreateSuppressionInput,
): Effect.Effect<
  CreateSuppressionResult,
  DatabaseError | ListNotFoundError,
  DatabaseService | IdGeneratorService
> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const ids = yield* IdGenerator;
    const now = yield* currentIso;

    if (input.scope === "list") {
      const list = yield* getListRow(input.listId ?? "");
      if (!list) return yield* Effect.fail(new ListNotFoundError({ listId: input.listId ?? "" }));
    }

    const id = yield* ids.next;
    const inserted =
      input.scope === "list"
        ? yield* db.get<{ id: string }>(
            "suppressions:create:list",
            `INSERT INTO suppressions (id, email, scope, list_id, reason, created_at)
             VALUES ($id, $email, 'list', $listId, 'manual', $now)
             ON CONFLICT(email, list_id) WHERE scope = 'list' DO NOTHING
             RETURNING id;`,
            { email: input.email, id, listId: input.listId, now },
          )
        : yield* db.get<{ id: string }>(
            "suppressions:create:global",
            `INSERT INTO suppressions (id, email, scope, list_id, reason, created_at)
             VALUES ($id, $email, $scope, NULL, 'manual', $now)
             ON CONFLICT(email, scope) WHERE list_id IS NULL DO NOTHING
             RETURNING id;`,
            { email: input.email, id, now, scope: input.scope },
          );

    const suppression = yield* findSuppression(input);
    if (!suppression) {
      return yield* Effect.fail(
        new DatabaseError({
          cause: "suppression was not found after create",
          operation: "suppressions:create",
        }),
      );
    }

    return { created: inserted !== null, suppression };
  });
}

export function deleteManualSuppression(
  id: string,
): Effect.Effect<void, ConflictError | DatabaseError | NotFoundError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    yield* db.transaction(
      Effect.gen(function* () {
        const deleted = yield* db.get<{ id: string }>(
          "suppressions:delete-manual",
          `DELETE FROM suppressions
           WHERE id = $id AND reason = 'manual'
           RETURNING id;`,
          { id },
        );
        if (deleted) return;

        yield* requireSuppressionById(id);
        return yield* Effect.fail(
          new ConflictError({
            message: "Only manual suppressions can be deleted through this API.",
          }),
        );
      }),
    );
  });
}

function findSuppression(
  input: CreateSuppressionInput,
): Effect.Effect<Suppression | null, DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const row =
      input.scope === "list"
        ? yield* db.get<{ id: string }>(
            "suppressions:find:list",
            `SELECT id
             FROM suppressions
             WHERE email = $email COLLATE NOCASE AND scope = 'list' AND list_id = $listId
             LIMIT 1;`,
            { email: input.email, listId: input.listId },
          )
        : yield* db.get<{ id: string }>(
            "suppressions:find:global",
            `SELECT id
             FROM suppressions
             WHERE email = $email COLLATE NOCASE AND scope = $scope AND list_id IS NULL
             LIMIT 1;`,
            { email: input.email, scope: input.scope },
          );

    return row ? yield* getSuppressionById(row.id) : null;
  });
}
