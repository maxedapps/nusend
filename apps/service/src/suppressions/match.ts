// Single product suppression scope predicate used by create-time filtering
// (mailings/create-mailing) and send-time policy (sending/policy).
//
// Call-site email match differs intentionally:
//   create: batched IN + lower(email)
//   send:   email = $email COLLATE NOCASE
// Only the scope SQL fragment is shared here.

type SuppressionPurpose = "marketing" | "transactional";

/**
 * SQL boolean fragment for product suppression matching.
 * Marketing: all | marketing | list (with $listId param when list-scoped).
 * Transactional: global (scope = 'all') only.
 */
export function suppressionScopeSql(purpose: SuppressionPurpose): string {
  return purpose === "marketing"
    ? "(scope IN ('all', 'marketing') OR (scope = 'list' AND list_id = $listId))"
    : "scope = 'all'";
}

/** Whether the scope fragment expects a `$listId` bind param. */
export function suppressionScopeNeedsListId(purpose: SuppressionPurpose): boolean {
  return purpose === "marketing";
}
