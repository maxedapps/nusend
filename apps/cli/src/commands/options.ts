import { UsageError } from "./context.js";

type OptionDefinition = {
  readonly repeatable?: boolean;
  readonly takesValue: boolean;
};

type OptionRegistry = Readonly<Record<string, OptionDefinition>>;

type PositionalDefinition = {
  readonly max: number;
  readonly min: number;
  readonly usage?: string;
};

const commandOptionRegistry: Readonly<Record<string, OptionRegistry>> = {
  "api-keys create": {
    "--expires-at": { takesValue: true },
    "--name": { takesValue: true },
    "--no-expiry": { takesValue: false },
    "--permission": { repeatable: true, takesValue: true },
  },
  "api-keys list": {
    "--limit": { takesValue: true },
    "--offset": { takesValue: true },
  },
  "api-keys revoke": {},
  "api-keys rotate": {},
  "config repair-permissions": {},
  "contacts create": {},
  "contacts delete": {},
  "contacts get": {},
  "contacts list": {
    "--email": { takesValue: true },
    "--limit": { takesValue: true },
    "--offset": { takesValue: true },
  },
  "contacts update": {},
  login: {
    "--name": { takesValue: true },
    "--permission": { repeatable: true, takesValue: true },
  },
  logout: { "--revoke": { takesValue: false } },
  "mailings get": {},
  "mailings list": {
    "--limit": { takesValue: true },
    "--offset": { takesValue: true },
  },
  whoami: {},
};

const commandPositionalRegistry: Readonly<Record<string, PositionalDefinition>> = {
  "api-keys create": { max: 0, min: 0 },
  "api-keys list": { max: 0, min: 0 },
  "api-keys revoke": { max: 1, min: 1, usage: "<id>" },
  "api-keys rotate": { max: 1, min: 1, usage: "<id>" },
  "config repair-permissions": { max: 0, min: 0 },
  "contacts create": { max: 1, min: 1, usage: "<email>" },
  "contacts delete": { max: 1, min: 1, usage: "<id>" },
  "contacts get": { max: 1, min: 1, usage: "<id>" },
  "contacts list": { max: 0, min: 0 },
  "contacts update": { max: 2, min: 2, usage: "<id> <email>" },
  login: { max: 1, min: 0, usage: "[base-url]" },
  logout: { max: 0, min: 0 },
  "mailings get": { max: 1, min: 1, usage: "<id>" },
  "mailings list": { max: 0, min: 0 },
  whoami: { max: 0, min: 0 },
};

export const knownCommands = new Set([
  "api-keys",
  "config",
  "contacts",
  "login",
  "logout",
  "mailings",
  "whoami",
]);

const subcommands: Readonly<Record<string, ReadonlySet<string>>> = {
  "api-keys": new Set(["create", "list", "revoke", "rotate"]),
  config: new Set(["repair-permissions"]),
  contacts: new Set(["create", "delete", "get", "list", "update"]),
  mailings: new Set(["get", "list"]),
};

export function validateCommandGrammar(rest: readonly string[]): void {
  const command = rest[0];
  if (!command || !knownCommands.has(command)) {
    throw new UsageError(`Unknown command: ${command}`, 2);
  }

  const knownSubcommands = subcommands[command];
  const subcommand = knownSubcommands ? rest[1] : undefined;
  if (knownSubcommands && (!subcommand || !knownSubcommands.has(subcommand))) {
    throw new UsageError(
      subcommand ? `Unknown ${command} command: ${subcommand}` : `Unknown ${command} command.`,
      2,
    );
  }

  const scope = knownSubcommands ? `${command} ${subcommand}` : command;
  const registry = commandOptionRegistry[scope];
  if (!registry) throw new UsageError(`Unknown command scope: ${scope}`, 2);
  const positionals = commandPositionalRegistry[scope];
  if (!positionals) throw new UsageError(`Unknown command scope: ${scope}`, 2);
  const optionStart = knownSubcommands ? 2 : 1;
  validatePositionals(scope, validateOptions(rest.slice(optionStart), registry), positionals);
}

function validateOptions(args: readonly string[], registry: OptionRegistry): string[] {
  const counts = new Map<string, number>();
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const definition = registry[token];
    if (!definition) throw new UsageError(`Unknown option: ${token}`, 2);
    const count = (counts.get(token) ?? 0) + 1;
    counts.set(token, count);
    if (count > 1 && !definition.repeatable) {
      throw new UsageError(`Duplicate option: ${token}`, 2);
    }
    if (!definition.takesValue) continue;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`${token} requires a value.`, 2);
    }
    index += 1;
  }
  return positionals;
}

function validatePositionals(
  scope: string,
  values: readonly string[],
  definition: PositionalDefinition,
): void {
  if (values.length < definition.min) {
    throw new UsageError(`${scope} requires ${definition.usage ?? "an argument"}.`, 2);
  }
  if (values.length > definition.max) {
    const expectation = definition.usage ? `; expected ${definition.usage}` : "";
    throw new UsageError(
      `Unexpected argument for ${scope}: ${values[definition.max]}${expectation}.`,
      2,
    );
  }
}
