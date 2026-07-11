import { Schema } from "effect";

export const permissionCatalog = {
  api_keys: ["read", "write"],
  contacts: ["read", "write"],
  lists: ["read", "write"],
  mailings: ["read", "write"],
  operations: ["read"],
  suppressions: ["read", "write"],
} as const;

export type PermissionResource = keyof typeof permissionCatalog;
export type PermissionAction<R extends PermissionResource = PermissionResource> =
  (typeof permissionCatalog)[R][number];
export type PermissionSet = Partial<Record<PermissionResource, readonly string[]>>;

const PermissionSetRecordSchema = Schema.Record(Schema.String, Schema.Array(Schema.String));

export const PermissionSetSchema = PermissionSetRecordSchema.check(
  Schema.makeFilter<typeof PermissionSetRecordSchema.Type>((value) => {
    const result = validatePermissionSet(value);
    return result.ok || result.message;
  }),
);

export type ParsedPermission = {
  readonly action: PermissionAction;
  readonly resource: PermissionResource;
};

export function parsePermission(value: string): ParsedPermission | null {
  const [resource, action, extra] = value.split(":");
  if (!resource || !action || extra !== undefined) return null;
  if (!isPermissionResource(resource)) return null;
  if (!isKnownActionForResource(resource, action)) return null;
  return { action, resource };
}

export function validatePermissionSet(
  value: unknown,
): { readonly ok: true } | { readonly message: string; readonly ok: false } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { message: "Permissions must be an object.", ok: false };
  }

  for (const [resource, actions] of Object.entries(value)) {
    if (!isPermissionResource(resource) || !Array.isArray(actions)) {
      return { message: `Invalid permissions for ${resource}.`, ok: false };
    }
    for (const action of actions) {
      if (typeof action !== "string" || !isKnownActionForResource(resource, action)) {
        return { message: `Invalid permission ${resource}:${String(action)}.`, ok: false };
      }
    }
  }

  return { ok: true };
}

export function normalizePermissions(input: PermissionSet): PermissionSet {
  const normalized: Partial<Record<PermissionResource, string[]>> = {};

  for (const resource of Object.keys(permissionCatalog) as PermissionResource[]) {
    const actions = input[resource] ?? [];
    const knownActions = actions.filter((action) => isKnownActionForResource(resource, action));
    const uniqueActions = [...new Set(knownActions)].sort();
    if (uniqueActions.length > 0) normalized[resource] = uniqueActions;
  }

  return normalized;
}

export function hasPermissions(
  granted: Record<string, readonly string[]> | null | undefined,
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

export function isPermissionSubset(candidate: PermissionSet, granted: PermissionSet): boolean {
  return hasPermissions(granted as Record<string, readonly string[]>, candidate);
}

function isPermissionResource(value: string): value is PermissionResource {
  return Object.hasOwn(permissionCatalog, value);
}

function isKnownActionForResource<R extends PermissionResource>(
  resource: R,
  action: string,
): action is PermissionAction<R> {
  return (permissionCatalog[resource] as readonly string[]).includes(action);
}
