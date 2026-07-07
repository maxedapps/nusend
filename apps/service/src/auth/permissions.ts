export const authStatements = {
  mailings: ["create"],
} as const;

export type PermissionSet = Partial<Record<keyof typeof authStatements, string[]>>;

export function hasPermissions(
  granted: Record<string, string[]> | null | undefined,
  required: PermissionSet | undefined,
): boolean {
  if (!required) return true;

  for (const [resource, actions] of Object.entries(required)) {
    const grantedActions = granted?.[resource] ?? [];

    for (const action of actions ?? []) {
      if (!grantedActions.includes(action)) return false;
    }
  }

  return true;
}
