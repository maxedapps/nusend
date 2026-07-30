import { UsageError } from "../errors.ts";

export const STAGE_ORDER = Object.freeze([
  "aws_core",
  "human_gates",
  "deploy",
  "aws_finalize",
  "validate_pre_simulator",
  "validate_simulator",
  "validate_final",
] as const);

export type StageId = (typeof STAGE_ORDER)[number];

export const HELP_TEXT = `Usage: pnpm nusend:setup [command]

Guided, resumable Nusend CloudFormation setup (workstation-side Effect wizard).

Commands:
  (none)                 Guided start: init when no installation, else next action
  init
  doctor
  status [--refresh]
  continue
  aws auth
  aws permissions
  aws plan
  aws apply
  deploy plan
  deploy apply
  validate pre-simulator
  validate simulator
  validate final
  destroy plan
  destroy apply

Global options:
  -h, --help    Show this help and exit

Environment:
  NUSEND_SETUP_HOME            Override setup home (default: ~/.config/nusend/setup)
  NUSEND_SETUP_INSTALLATION    Select installation id (else mode-0600 "current" pointer)

Notes:
  Help and unknown commands mutate nothing.
  Secrets live only in deployment.env under the installation directory.
  continue runs at most one eligible stage and checkpoints verified evidence only.
  AWS authentication is modern IAM Identity Center (sso_session) only.
  Static keys, legacy SSO, aws login, and raw SSO-cache parsing are rejected.
`;

export type ParsedCommand =
  | { readonly kind: "help" }
  | { readonly kind: "guided" }
  | { readonly kind: "init" }
  | { readonly kind: "doctor" }
  | { readonly kind: "status"; readonly refresh: boolean }
  | { readonly kind: "continue" }
  | {
      readonly kind: "aws";
      readonly action: "auth" | "permissions" | "plan" | "apply";
    }
  | { readonly kind: "deploy"; readonly action: "plan" | "apply" }
  | {
      readonly kind: "validate";
      readonly action: "pre-simulator" | "simulator" | "final";
    }
  | { readonly kind: "destroy"; readonly action: "plan" | "apply" };

/** pnpm forwards a literal `--` separator before script args; drop leading ones. */
export function normalizeArgv(argv: readonly string[]): readonly string[] {
  let index = 0;
  while (index < argv.length && argv[index] === "--") index += 1;
  return argv.slice(index);
}

export function parseSetupArgv(argv: readonly string[]): ParsedCommand {
  const args = [...normalizeArgv(argv)];
  if (args.length === 0) {
    return { kind: "guided" };
  }
  if (args[0] === "-h" || args[0] === "--help" || args[0] === "help") {
    if (args.length > 1 && args[0] !== "help") {
      throw new UsageError({
        message: `Unexpected arguments after ${args[0]}.\n\n${HELP_TEXT}`,
      });
    }
    return { kind: "help" };
  }

  const head = args[0];
  switch (head) {
    case "init":
      return parseUnary(args, "init");
    case "doctor":
      return parseUnary(args, "doctor");
    case "status": {
      let refresh = false;
      for (const flag of args.slice(1)) {
        if (flag === "--refresh") {
          refresh = true;
          continue;
        }
        if (flag === "-h" || flag === "--help") return { kind: "help" };
        throw new UsageError({
          message: `Unknown status option "${flag}".\n\n${HELP_TEXT}`,
        });
      }
      return { kind: "status", refresh };
    }
    case "continue":
      return parseUnary(args, "continue");
    case "aws":
      return parseTwoPart(args, "aws", ["auth", "permissions", "plan", "apply"] as const);
    case "deploy":
      return parseTwoPart(args, "deploy", ["plan", "apply"] as const);
    case "validate":
      return parseTwoPart(args, "validate", ["pre-simulator", "simulator", "final"] as const);
    case "destroy":
      return parseTwoPart(args, "destroy", ["plan", "apply"] as const);
    default:
      throw new UsageError({
        message: `Unknown command "${head}".\n\n${HELP_TEXT}`,
      });
  }
}

function parseUnary(args: string[], name: "init" | "doctor" | "continue"): ParsedCommand {
  if (args.length === 1) return { kind: name };
  if (args[1] === "-h" || args[1] === "--help") return { kind: "help" };
  throw new UsageError({
    message: `Unexpected arguments for ${name}.\n\n${HELP_TEXT}`,
  });
}

function parseTwoPart<K extends "aws" | "deploy" | "validate" | "destroy", T extends string>(
  args: string[],
  parent: K,
  actions: readonly T[],
): ParsedCommand {
  const action = args[1];
  if (action == null || action === "-h" || action === "--help") {
    if (action == null) {
      throw new UsageError({
        message: `Missing action for ${parent}. Expected one of: ${actions.join(", ")}.\n\n${HELP_TEXT}`,
      });
    }
    return { kind: "help" };
  }
  if (!actions.includes(action as T)) {
    throw new UsageError({
      message: `Unknown ${parent} action "${action}". Expected one of: ${actions.join(", ")}.\n\n${HELP_TEXT}`,
    });
  }
  if (args.length > 2) {
    throw new UsageError({
      message: `Unexpected arguments for ${parent} ${action}.\n\n${HELP_TEXT}`,
    });
  }
  return { kind: parent, action: action as T } as ParsedCommand;
}
