import {
  normalizePermissions,
  parsePermission,
  type PermissionSet,
} from "@nusend/api-contract/permissions";

import type { JsonFileSource } from "./json-input.js";
import { UsageError } from "./context.js";

type CommonOptions = {
  readonly baseUrl?: string;
  readonly json: boolean;
};

type PaginationOptions = {
  readonly limit?: string;
  readonly offset?: string;
};

const suppressionScopes = ["all", "marketing", "list"] as const;
const suppressionReasons = ["bounce", "complaint", "manual", "unsubscribe"] as const;
const listContactStatuses = ["all", "subscribed", "unsubscribed"] as const;
const deliveryStatuses = [
  "queued",
  "sending",
  "sent",
  "failed",
  "suppressed",
  "ambiguous",
] as const;
const deliveryIssues = ["failed_or_ambiguous"] as const;
const sesEventTypes = [
  "Send",
  "Rendering Failure",
  "Reject",
  "Delivery",
  "DeliveryDelay",
  "Bounce",
  "Complaint",
  "Subscription",
  "Open",
  "Click",
  "Unknown",
] as const;

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
  | (CommonOptions & { readonly id: string; readonly kind: "mailings-get" })
  | (CommonOptions & {
      readonly file: JsonFileSource;
      readonly idempotencyKey?: string;
      readonly kind: "mailings-create";
    })
  | (CommonOptions & PaginationOptions & { readonly kind: "lists-list" })
  | (CommonOptions & { readonly id: string; readonly kind: "lists-get" })
  | (CommonOptions & { readonly kind: "lists-create"; readonly name: string })
  | (CommonOptions & { readonly id: string; readonly kind: "lists-update"; readonly name: string })
  | (CommonOptions & { readonly id: string; readonly kind: "lists-delete" })
  | (CommonOptions &
      PaginationOptions & {
        readonly email?: string;
        readonly kind: "lists-contacts-list";
        readonly listId: string;
        readonly status?: (typeof listContactStatuses)[number];
      })
  | (CommonOptions & {
      readonly file: JsonFileSource;
      readonly kind: "lists-contacts-import";
      readonly listId: string;
    })
  | (CommonOptions & {
      readonly contactId: string;
      readonly kind: "lists-contacts-remove";
      readonly listId: string;
    })
  | (CommonOptions &
      PaginationOptions & {
        readonly email?: string;
        readonly kind: "suppressions-list";
        readonly listId?: string;
        readonly reason?: (typeof suppressionReasons)[number];
        readonly scope?: (typeof suppressionScopes)[number];
      })
  | (CommonOptions & {
      readonly email: string;
      readonly kind: "suppressions-create";
      readonly listId?: string;
      readonly scope: (typeof suppressionScopes)[number];
    })
  | (CommonOptions & { readonly id: string; readonly kind: "suppressions-delete" })
  | (CommonOptions & { readonly kind: "operations-summary" })
  | (CommonOptions & {
      readonly email?: string;
      readonly issue?: (typeof deliveryIssues)[number];
      readonly kind: "deliveries-list";
      readonly limit?: string;
      readonly mailingId?: string;
      readonly sesMessageId?: string;
      readonly status?: (typeof deliveryStatuses)[number];
    })
  | (CommonOptions & { readonly id: string; readonly kind: "deliveries-get" })
  | (CommonOptions & { readonly kind: "ses-summary" })
  | (CommonOptions & { readonly includeAws: boolean; readonly kind: "ses-readiness" })
  | (CommonOptions & { readonly includeAws: boolean; readonly kind: "ses-setup-guide" })
  | (CommonOptions &
      PaginationOptions & {
        readonly deliveryId?: string;
        readonly email?: string;
        readonly eventType?: (typeof sesEventTypes)[number];
        readonly kind: "ses-events-list";
        readonly mailingId?: string;
        readonly sesMessageId?: string;
      })
  | (CommonOptions & { readonly id: string; readonly kind: "ses-events-get" })
  | (CommonOptions & { readonly kind: "ses-simulator-runs-list" })
  | (CommonOptions & { readonly id: string; readonly kind: "ses-simulator-runs-get" });

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
    case "lists":
      return parseLists(args, common);
    case "suppressions":
      return parseSuppressions(args, common);
    case "operations":
      return parseOperations(args, common);
    case "deliveries":
      return parseDeliveries(args, common);
    case "ses":
      return parseSes(args, common);
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
      const options = parseNamedOptions(rest, {
        allow: ["--limit", "--offset"],
        scope: "api-keys list",
      });
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
    case "list": {
      const options = parseNamedOptions(rest, {
        allow: ["--email", "--limit", "--offset"],
        scope: "contacts list",
      });
      return { ...common, ...options, kind: "contacts-list" };
    }
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
    case "list": {
      const options = parseNamedOptions(rest, {
        allow: ["--limit", "--offset"],
        scope: "mailings list",
      });
      return { ...common, ...options, kind: "mailings-list" };
    }
    case "get":
      return { ...common, id: requireSingle("mailings get", rest, "<id>"), kind: "mailings-get" };
    case "create":
      return { ...common, ...parseMailingsCreate(rest), kind: "mailings-create" };
    default:
      throw new UsageError(
        subcommand ? `Unknown mailings command: ${subcommand}` : "Unknown mailings command.",
        2,
      );
  }
}

function parseMailingsCreate(args: readonly string[]): {
  readonly file: JsonFileSource;
  readonly idempotencyKey?: string;
} {
  let file: JsonFileSource | undefined;
  let idempotencyKey: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--file") {
      if (file !== undefined) throw new UsageError("Duplicate option: --file", 2);
      file = fileSourceFromValue(optionValue(args, ++index, token));
    } else if (token === "--idempotency-key") {
      if (idempotencyKey !== undefined)
        throw new UsageError("Duplicate option: --idempotency-key", 2);
      idempotencyKey = optionValue(args, ++index, token);
    } else if (token.startsWith("--")) {
      throw new UsageError(`Unknown option: ${token}`, 2);
    } else {
      throw new UsageError(`Unexpected argument for mailings create: ${token}.`, 2);
    }
  }
  if (!file) throw new UsageError("mailings create requires --file <path|->.", 2);
  return { file, idempotencyKey };
}

function parseLists(args: readonly string[], common: CommonOptions): CliCommand {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "list": {
      const options = parseNamedOptions(rest, {
        allow: ["--limit", "--offset"],
        scope: "lists list",
      });
      return { ...common, ...options, kind: "lists-list" };
    }
    case "get":
      return { ...common, id: requireSingle("lists get", rest, "<id>"), kind: "lists-get" };
    case "create":
      return {
        ...common,
        kind: "lists-create",
        name: requireSingle("lists create", rest, "<name>"),
      };
    case "update": {
      requirePositionals("lists update", rest, 2, 2, "<id> <name>");
      return { ...common, id: rest[0]!, kind: "lists-update", name: rest[1]! };
    }
    case "delete":
      return {
        ...common,
        id: requireSingle("lists delete", rest, "<id>"),
        kind: "lists-delete",
      };
    case "contacts":
      return parseListContacts(rest, common);
    default:
      throw new UsageError(
        subcommand ? `Unknown lists command: ${subcommand}` : "Unknown lists command.",
        2,
      );
  }
}

function parseListContacts(args: readonly string[], common: CommonOptions): CliCommand {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "list": {
      const { options, positionals } = takeNamedOptions(rest, {
        allow: ["--email", "--limit", "--offset", "--status"],
        enums: { "--status": listContactStatuses },
        scope: "lists contacts list",
      });
      requirePositionals("lists contacts list", positionals, 1, 1, "<list-id>");
      return {
        ...common,
        email: options.email,
        kind: "lists-contacts-list",
        limit: options.limit,
        listId: positionals[0]!,
        offset: options.offset,
        status: options.status as (typeof listContactStatuses)[number] | undefined,
      };
    }
    case "import": {
      const { options, positionals } = takeNamedOptions(rest, {
        allow: ["--file"],
        scope: "lists contacts import",
      });
      requirePositionals("lists contacts import", positionals, 1, 1, "<list-id>");
      if (options.file === undefined) {
        throw new UsageError("lists contacts import requires --file <path|->.", 2);
      }
      return {
        ...common,
        file: fileSourceFromValue(options.file),
        kind: "lists-contacts-import",
        listId: positionals[0]!,
      };
    }
    case "remove": {
      requirePositionals("lists contacts remove", rest, 2, 2, "<list-id> <contact-id>");
      return {
        ...common,
        contactId: rest[1]!,
        kind: "lists-contacts-remove",
        listId: rest[0]!,
      };
    }
    default:
      throw new UsageError(
        subcommand
          ? `Unknown lists contacts command: ${subcommand}`
          : "Unknown lists contacts command.",
        2,
      );
  }
}

function parseSuppressions(args: readonly string[], common: CommonOptions): CliCommand {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "list": {
      const options = parseNamedOptions(rest, {
        allow: ["--email", "--limit", "--list-id", "--offset", "--reason", "--scope"],
        enums: {
          "--reason": suppressionReasons,
          "--scope": suppressionScopes,
        },
        scope: "suppressions list",
      });
      validateSuppressionListId(options.scope, options["list-id"], "list");
      return {
        ...common,
        email: options.email,
        kind: "suppressions-list",
        limit: options.limit,
        listId: options["list-id"],
        offset: options.offset,
        reason: options.reason as (typeof suppressionReasons)[number] | undefined,
        scope: options.scope as (typeof suppressionScopes)[number] | undefined,
      };
    }
    case "create": {
      const { options, positionals } = takeNamedOptions(rest, {
        allow: ["--list-id", "--scope"],
        enums: { "--scope": suppressionScopes },
        scope: "suppressions create",
      });
      requirePositionals("suppressions create", positionals, 1, 1, "<email>");
      if (options.scope === undefined) {
        throw new UsageError("suppressions create requires --scope <all|marketing|list>.", 2);
      }
      validateSuppressionListId(options.scope, options["list-id"], "create");
      return {
        ...common,
        email: positionals[0]!,
        kind: "suppressions-create",
        listId: options["list-id"],
        scope: options.scope as (typeof suppressionScopes)[number],
      };
    }
    case "delete":
      return {
        ...common,
        id: requireSingle("suppressions delete", rest, "<id>"),
        kind: "suppressions-delete",
      };
    default:
      throw new UsageError(
        subcommand
          ? `Unknown suppressions command: ${subcommand}`
          : "Unknown suppressions command.",
        2,
      );
  }
}

function parseOperations(args: readonly string[], common: CommonOptions): CliCommand {
  const [subcommand, ...rest] = args;
  if (subcommand !== "summary") {
    throw new UsageError(
      subcommand ? `Unknown operations command: ${subcommand}` : "Unknown operations command.",
      2,
    );
  }
  requirePositionals("operations summary", rest, 0);
  return { ...common, kind: "operations-summary" };
}

function parseDeliveries(args: readonly string[], common: CommonOptions): CliCommand {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "list": {
      const options = parseNamedOptions(rest, {
        allow: ["--email", "--issue", "--limit", "--mailing-id", "--ses-message-id", "--status"],
        enums: {
          "--issue": deliveryIssues,
          "--status": deliveryStatuses,
        },
        scope: "deliveries list",
      });
      return {
        ...common,
        email: options.email,
        issue: options.issue as (typeof deliveryIssues)[number] | undefined,
        kind: "deliveries-list",
        limit: options.limit,
        mailingId: options["mailing-id"],
        sesMessageId: options["ses-message-id"],
        status: options.status as (typeof deliveryStatuses)[number] | undefined,
      };
    }
    case "get":
      return {
        ...common,
        id: requireSingle("deliveries get", rest, "<id>"),
        kind: "deliveries-get",
      };
    default:
      throw new UsageError(
        subcommand ? `Unknown deliveries command: ${subcommand}` : "Unknown deliveries command.",
        2,
      );
  }
}

function parseSes(args: readonly string[], common: CommonOptions): CliCommand {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "summary":
      requirePositionals("ses summary", rest, 0);
      return { ...common, kind: "ses-summary" };
    case "readiness":
      return {
        ...common,
        includeAws: parseNoAwsFlag(rest, "ses readiness"),
        kind: "ses-readiness",
      };
    case "setup-guide":
      return {
        ...common,
        includeAws: parseNoAwsFlag(rest, "ses setup-guide"),
        kind: "ses-setup-guide",
      };
    case "events":
      return parseSesEvents(rest, common);
    case "simulator-runs":
      return parseSesSimulatorRuns(rest, common);
    default:
      throw new UsageError(
        subcommand ? `Unknown ses command: ${subcommand}` : "Unknown ses command.",
        2,
      );
  }
}

function parseSesEvents(args: readonly string[], common: CommonOptions): CliCommand {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "list": {
      const options = parseNamedOptions(rest, {
        allow: [
          "--delivery-id",
          "--email",
          "--event-type",
          "--limit",
          "--mailing-id",
          "--offset",
          "--ses-message-id",
        ],
        enums: { "--event-type": sesEventTypes },
        scope: "ses events list",
      });
      return {
        ...common,
        deliveryId: options["delivery-id"],
        email: options.email,
        eventType: options["event-type"] as (typeof sesEventTypes)[number] | undefined,
        kind: "ses-events-list",
        limit: options.limit,
        mailingId: options["mailing-id"],
        offset: options.offset,
        sesMessageId: options["ses-message-id"],
      };
    }
    case "get":
      return {
        ...common,
        id: requireSingle("ses events get", rest, "<id>"),
        kind: "ses-events-get",
      };
    default:
      throw new UsageError(
        subcommand ? `Unknown ses events command: ${subcommand}` : "Unknown ses events command.",
        2,
      );
  }
}

function parseSesSimulatorRuns(args: readonly string[], common: CommonOptions): CliCommand {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "list":
      requirePositionals("ses simulator-runs list", rest, 0);
      return { ...common, kind: "ses-simulator-runs-list" };
    case "get":
      return {
        ...common,
        id: requireSingle("ses simulator-runs get", rest, "<id>"),
        kind: "ses-simulator-runs-get",
      };
    default:
      throw new UsageError(
        subcommand
          ? `Unknown ses simulator-runs command: ${subcommand}`
          : "Unknown ses simulator-runs command.",
        2,
      );
  }
}

function parseNoAwsFlag(args: readonly string[], scope: string): boolean {
  let noAws = false;
  for (const token of args) {
    if (token === "--no-aws") {
      if (noAws) throw new UsageError("Duplicate option: --no-aws", 2);
      noAws = true;
    } else if (token.startsWith("--")) {
      throw new UsageError(`Unknown option: ${token}`, 2);
    } else {
      throw new UsageError(`Unexpected argument for ${scope}: ${token}.`, 2);
    }
  }
  return !noAws;
}

function validateSuppressionListId(
  scope: string | undefined,
  listId: string | undefined,
  mode: "create" | "list",
): void {
  if (mode === "create") {
    if (scope === "list" && listId === undefined) {
      throw new UsageError("suppressions create with --scope list requires --list-id.", 2);
    }
    if (scope !== "list" && listId !== undefined) {
      throw new UsageError("--list-id is only allowed when --scope is list.", 2);
    }
    return;
  }
  if (listId !== undefined && scope !== undefined && scope !== "list") {
    throw new UsageError("--list-id can only be combined with --scope list.", 2);
  }
}

function parseNamedOptions(
  args: readonly string[],
  config: {
    readonly allow: readonly string[];
    readonly enums?: Readonly<Record<string, readonly string[]>>;
    readonly scope: string;
  },
): Record<string, string> {
  const { options, positionals } = takeNamedOptions(args, config);
  if (positionals.length > 0) {
    throw new UsageError(`Unexpected argument for ${config.scope}: ${positionals[0]}.`, 2);
  }
  return options;
}

function takeNamedOptions(
  args: readonly string[],
  config: {
    readonly allow: readonly string[];
    readonly enums?: Readonly<Record<string, readonly string[]>>;
    readonly scope: string;
  },
): { readonly options: Record<string, string>; readonly positionals: string[] } {
  const allowed = new Set(config.allow);
  const options: Record<string, string> = {};
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    if (!allowed.has(token)) throw new UsageError(`Unknown option: ${token}`, 2);
    const key = token.slice(2);
    if (options[key] !== undefined) throw new UsageError(`Duplicate option: ${token}`, 2);
    const value = optionValue(args, ++index, token);
    const allowedValues = config.enums?.[token];
    if (allowedValues && !allowedValues.includes(value)) {
      throw new UsageError(
        `Invalid ${token} value: ${value}. Expected one of: ${allowedValues.join(", ")}.`,
        2,
      );
    }
    options[key] = value;
  }
  return { options, positionals };
}

function fileSourceFromValue(value: string): JsonFileSource {
  return value === "-" ? { kind: "stdin" } : { kind: "path", path: value };
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

const booleanOptions = new Set([
  "--help",
  "--json",
  "--no-aws",
  "--no-expiry",
  "--revoke",
  "--version",
]);

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
