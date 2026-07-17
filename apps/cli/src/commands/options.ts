import {
  normalizePermissions,
  parsePermission,
  type PermissionSet,
} from "@nusend/api-contract/permissions";

import { UsageError } from "./context.js";

type CommonOptions = {
  readonly baseUrl?: string;
  readonly json: boolean;
};

export type CliCommand =
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | (CommonOptions & {
      readonly baseUrlInput?: string;
      readonly clientName?: string;
      readonly kind: "login";
      readonly permissions?: PermissionSet;
    })
  | (CommonOptions & { readonly kind: "logout"; readonly revoke: boolean })
  | (CommonOptions & { readonly kind: "whoami" })
  | (CommonOptions & { readonly kind: "config-repair-permissions" })
  | (CommonOptions & {
      readonly kind: "api-keys-list";
      readonly limit?: string;
      readonly offset?: string;
    })
  | (CommonOptions & {
      readonly expiresAt?: string | null;
      readonly kind: "api-keys-create";
      readonly name: string;
      readonly permissions: PermissionSet;
    })
  | (CommonOptions & { readonly id: string; readonly kind: "api-keys-revoke" })
  | (CommonOptions & { readonly id: string; readonly kind: "api-keys-rotate" })
  | (CommonOptions & {
      readonly email?: string;
      readonly kind: "contacts-list";
      readonly limit?: string;
      readonly offset?: string;
    })
  | (CommonOptions & { readonly id: string; readonly kind: "contacts-get" })
  | (CommonOptions & { readonly email: string; readonly kind: "contacts-create" })
  | (CommonOptions & {
      readonly email: string;
      readonly id: string;
      readonly kind: "contacts-update";
    })
  | (CommonOptions & { readonly id: string; readonly kind: "contacts-delete" })
  | (CommonOptions & {
      readonly kind: "mailings-list";
      readonly limit?: string;
      readonly offset?: string;
    })
  | (CommonOptions & { readonly id: string; readonly kind: "mailings-get" });

export function parseCliCommand(argv: readonly string[]): CliCommand {
  const expanded = expandEqualsSyntax(argv);
  const { baseUrl, json, rest } = extractGlobalOptions(expanded);
  const helpCount = rest.filter((token) => token === "--help" || token === "-h").length;
  const versionCount = rest.filter((token) => token === "--version" || token === "-v").length;
  if (helpCount > 1) throw new UsageError("Duplicate option: --help", 2);
  if (versionCount > 1) throw new UsageError("Duplicate option: --version", 2);
  if (helpCount > 0 && versionCount > 0) {
    throw new UsageError("--help and --version cannot be combined.", 2);
  }
  if (rest.length === 0 || helpCount === 1) return { kind: "help" };
  if (rest[0] === "--version" || rest[0] === "-v") return { kind: "version" };

  const common = { baseUrl, json };
  const [command, ...args] = rest;
  switch (command) {
    case "login":
      return { ...common, ...parseLogin(args), kind: "login" };
    case "logout":
      return { ...common, kind: "logout", revoke: parseRevoke(args) };
    case "whoami":
      requirePositionals("whoami", args, 0);
      return { ...common, kind: "whoami" };
    case "config":
      return parseConfig(args, common);
    case "api-keys":
      return parseApiKeys(args, common);
    case "contacts":
      return parseContacts(args, common);
    case "mailings":
      return parseMailings(args, common);
    default:
      throw new UsageError(`Unknown command: ${command}`, 2);
  }
}

function parseLogin(args: readonly string[]): {
  readonly baseUrlInput?: string;
  readonly clientName?: string;
  readonly permissions?: PermissionSet;
} {
  const positionals: string[] = [];
  const permissionValues: string[] = [];
  let clientName: string | undefined;
  let seenName = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--name") {
      if (seenName) throw new UsageError("Duplicate option: --name", 2);
      seenName = true;
      clientName = optionValue(args, ++index, token);
    } else if (token === "--permission") {
      permissionValues.push(optionValue(args, ++index, token));
    } else if (token.startsWith("--")) {
      throw new UsageError(`Unknown option: ${token}`, 2);
    } else {
      positionals.push(token);
    }
  }
  requirePositionals("login", positionals, 0, 1, "[base-url]");
  return {
    baseUrlInput: positionals[0],
    clientName,
    permissions: permissionValues.length > 0 ? permissionsFromValues(permissionValues) : undefined,
  };
}

function parseRevoke(args: readonly string[]): boolean {
  let revoke = false;
  for (const token of args) {
    if (token === "--revoke") {
      if (revoke) throw new UsageError("Duplicate option: --revoke", 2);
      revoke = true;
    } else if (token.startsWith("--")) {
      throw new UsageError(`Unknown option: ${token}`, 2);
    } else {
      throw new UsageError(`Unexpected argument for logout: ${token}.`, 2);
    }
  }
  return revoke;
}

function parseConfig(args: readonly string[], common: CommonOptions): CliCommand {
  if (args[0] !== "repair-permissions") {
    throw new UsageError(
      args[0] ? `Unknown config command: ${args[0]}` : "Unknown config command.",
      2,
    );
  }
  requirePositionals("config repair-permissions", args.slice(1), 0);
  return { ...common, kind: "config-repair-permissions" };
}

function parseApiKeys(args: readonly string[], common: CommonOptions): CliCommand {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "list": {
      const options = parsePagination(rest, false);
      return { ...common, ...options, kind: "api-keys-list" };
    }
    case "create":
      return { ...common, ...parseApiKeyCreate(rest), kind: "api-keys-create" };
    case "revoke":
      return {
        ...common,
        id: requireSingle("api-keys revoke", rest, "<id>"),
        kind: "api-keys-revoke",
      };
    case "rotate":
      return {
        ...common,
        id: requireSingle("api-keys rotate", rest, "<id>"),
        kind: "api-keys-rotate",
      };
    default:
      throw new UsageError(
        subcommand ? `Unknown api-keys command: ${subcommand}` : "Unknown api-keys command.",
        2,
      );
  }
}

function parseApiKeyCreate(args: readonly string[]): {
  readonly expiresAt?: string | null;
  readonly name: string;
  readonly permissions: PermissionSet;
} {
  const permissionValues: string[] = [];
  let name: string | undefined;
  let expiresAt: string | null | undefined;
  let seenExpiry = false;
  let seenName = false;
  let noExpiry = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    switch (token) {
      case "--name":
        if (seenName) throw new UsageError("Duplicate option: --name", 2);
        seenName = true;
        name = optionValue(args, ++index, token);
        break;
      case "--permission":
        permissionValues.push(optionValue(args, ++index, token));
        break;
      case "--expires-at":
        if (seenExpiry) throw new UsageError("Duplicate option: --expires-at", 2);
        seenExpiry = true;
        expiresAt = optionValue(args, ++index, token);
        break;
      case "--no-expiry":
        if (noExpiry) throw new UsageError("Duplicate option: --no-expiry", 2);
        noExpiry = true;
        break;
      default:
        if (token.startsWith("--")) throw new UsageError(`Unknown option: ${token}`, 2);
        throw new UsageError(`Unexpected argument for api-keys create: ${token}.`, 2);
    }
  }
  if (!name) throw new UsageError("api-keys create requires --name.", 2);
  if (seenExpiry && noExpiry) {
    throw new UsageError("Use either --expires-at or --no-expiry, not both.", 2);
  }
  return {
    expiresAt: noExpiry ? null : expiresAt,
    name,
    permissions: permissionsFromValues(permissionValues),
  };
}

function parseContacts(args: readonly string[], common: CommonOptions): CliCommand {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "list":
      return { ...common, ...parsePagination(rest, true), kind: "contacts-list" };
    case "get":
      return { ...common, id: requireSingle("contacts get", rest, "<id>"), kind: "contacts-get" };
    case "create":
      return {
        ...common,
        email: requireSingle("contacts create", rest, "<email>"),
        kind: "contacts-create",
      };
    case "update": {
      requirePositionals("contacts update", rest, 2, 2, "<id> <email>");
      return { ...common, email: rest[1]!, id: rest[0]!, kind: "contacts-update" };
    }
    case "delete":
      return {
        ...common,
        id: requireSingle("contacts delete", rest, "<id>"),
        kind: "contacts-delete",
      };
    default:
      throw new UsageError(
        subcommand ? `Unknown contacts command: ${subcommand}` : "Unknown contacts command.",
        2,
      );
  }
}

function parseMailings(args: readonly string[], common: CommonOptions): CliCommand {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "list":
      return { ...common, ...parsePagination(rest, false), kind: "mailings-list" };
    case "get":
      return { ...common, id: requireSingle("mailings get", rest, "<id>"), kind: "mailings-get" };
    default:
      throw new UsageError(
        subcommand ? `Unknown mailings command: ${subcommand}` : "Unknown mailings command.",
        2,
      );
  }
}

function parsePagination(
  args: readonly string[],
  allowEmail: boolean,
): { readonly email?: string; readonly limit?: string; readonly offset?: string } {
  let email: string | undefined;
  let limit: string | undefined;
  let offset: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--limit") {
      if (limit !== undefined) throw new UsageError("Duplicate option: --limit", 2);
      limit = optionValue(args, ++index, token);
    } else if (token === "--offset") {
      if (offset !== undefined) throw new UsageError("Duplicate option: --offset", 2);
      offset = optionValue(args, ++index, token);
    } else if (token === "--email" && allowEmail) {
      if (email !== undefined) throw new UsageError("Duplicate option: --email", 2);
      email = optionValue(args, ++index, token);
    } else if (token.startsWith("--")) {
      throw new UsageError(`Unknown option: ${token}`, 2);
    } else {
      throw new UsageError(`Unexpected argument: ${token}.`, 2);
    }
  }
  return { email, limit, offset };
}

function requireSingle(scope: string, args: readonly string[], usage: string): string {
  requirePositionals(scope, args, 1, 1, usage);
  return args[0]!;
}

function requirePositionals(
  scope: string,
  args: readonly string[],
  min: number,
  max = min,
  usage?: string,
): void {
  const option = args.find((token) => token.startsWith("--"));
  if (option) throw new UsageError(`Unknown option: ${option}`, 2);
  if (args.length < min) throw new UsageError(`${scope} requires ${usage ?? "an argument"}.`, 2);
  if (args.length > max) {
    const expectation = usage ? `; expected ${usage}` : "";
    throw new UsageError(`Unexpected argument for ${scope}: ${args[max]}${expectation}.`, 2);
  }
}

function permissionsFromValues(values: readonly string[]): PermissionSet {
  const permissions: Record<string, string[]> = {};
  for (const value of values) {
    const parsed = parsePermission(value);
    if (!parsed) throw new UsageError(`Invalid permission: ${value}`, 2);
    permissions[parsed.resource] = [...(permissions[parsed.resource] ?? []), parsed.action];
  }
  return normalizePermissions(permissions);
}

function extractGlobalOptions(args: readonly string[]): {
  readonly baseUrl?: string;
  readonly json: boolean;
  readonly rest: string[];
} {
  const rest: string[] = [];
  let baseUrl: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--json") {
      if (json) throw new UsageError("Duplicate option: --json", 2);
      json = true;
    } else if (token === "--base-url") {
      if (baseUrl !== undefined) throw new UsageError("Duplicate option: --base-url", 2);
      baseUrl = optionValue(args, ++index, token);
    } else {
      rest.push(token);
    }
  }
  return { baseUrl, json, rest };
}

function optionValue(args: readonly string[], index: number, name: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new UsageError(`${name} requires a value.`, 2);
  return value;
}

const booleanOptions = new Set(["--help", "--json", "--no-expiry", "--revoke", "--version"]);

function expandEqualsSyntax(args: readonly string[]): string[] {
  const expanded: string[] = [];
  for (const arg of args) {
    const separator = arg.startsWith("--") ? arg.indexOf("=") : -1;
    if (separator < 0) {
      expanded.push(arg);
      continue;
    }
    const name = arg.slice(0, separator);
    if (booleanOptions.has(name)) throw new UsageError(`${name} does not take a value.`, 2);
    const value = arg.slice(separator + 1);
    if (value === "") throw new UsageError(`${name} requires a value.`, 2);
    expanded.push(name, value);
  }
  return expanded;
}
