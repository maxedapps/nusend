import { createAccessControl } from "better-auth/plugins/access";

export const authStatements = {
  mailings: ["create", "read", "update", "cancel", "send"],
  templates: ["create", "read", "update", "delete"],
  contacts: ["create", "read", "update", "delete", "import"],
  lists: ["create", "read", "update", "delete"],
  suppressions: ["create", "read", "delete"],
  deliveries: ["read"],
  queue: ["read", "retry", "cancel"],
  apiKey: ["create", "read", "update", "delete"],
} as const;

export type PermissionSet = Partial<Record<keyof typeof authStatements, string[]>>;

export const authAccessControl = createAccessControl(authStatements);

export const authRoles = {
  owner: authAccessControl.newRole(authStatements),
  admin: authAccessControl.newRole({
    mailings: ["create", "read", "update", "cancel", "send"],
    templates: ["create", "read", "update", "delete"],
    contacts: ["create", "read", "update", "delete", "import"],
    lists: ["create", "read", "update", "delete"],
    suppressions: ["create", "read", "delete"],
    deliveries: ["read"],
    queue: ["read", "retry", "cancel"],
    apiKey: ["create", "read", "update", "delete"],
  }),
  member: authAccessControl.newRole({
    mailings: ["create", "read", "update", "cancel", "send"],
    templates: ["create", "read", "update", "delete"],
    contacts: ["create", "read", "update", "delete", "import"],
    lists: ["create", "read", "update", "delete"],
    suppressions: ["create", "read", "delete"],
    deliveries: ["read"],
    queue: ["read"],
  }),
} as const;

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

export function permissionsForRole(role: string): Record<string, string[]> {
  if (!(role in authRoles)) return {};

  const roleKey = role as keyof typeof authRoles;

  return Object.fromEntries(
    Object.entries(authRoles[roleKey].statements).map(([resource, actions]) => [
      resource,
      [...actions],
    ]),
  );
}
