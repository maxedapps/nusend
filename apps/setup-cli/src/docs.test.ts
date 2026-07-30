import { access, readFile, readdir } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { HELP_TEXT, parseSetupArgv } from "./commands/parse.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DOCUMENTS = ["README.md", "PROJECT.md", "docs/aws-setup.md", "docs/deployment.md"];

const DELETED_AWS_PATHS = [
  `deploy/aws/${token("provision", "-aws.sh")}`,
  `deploy/aws/${token("finalize", "-aws.sh")}`,
  "deploy/aws/lib.sh",
  `deploy/aws/${token("setup.conf", ".example")}`,
  `deploy/aws/${token("validate-nusend", ".sh")}`,
  `deploy/aws/${token("run-simulator", ".sh")}`,
  `deploy/aws/policies/${token("runtime-policy", ".example.json")}`,
  `deploy/aws/policies/${token("sns-topic-policy", ".example.json")}`,
  `deploy/aws/policies/${token("sns-dlq-policy", ".example.json")}`,
];

const DELETED_SETUP_PATHS = [
  "deploy/setup/main.mjs",
  "deploy/setup/aws.mjs",
  "deploy/setup/deploy.mjs",
  "deploy/setup/destroy.mjs",
  "deploy/setup/process.mjs",
  "deploy/setup/state.mjs",
  "deploy/setup/validate.mjs",
];

const STALE_TOKENS = [
  token("provision", "-aws"),
  token("finalize", "-aws"),
  token("validate-nusend", ".sh"),
  token("run-simulator", ".sh"),
  token("setup.conf", ".example"),
  token(".env.aws", "-setup"),
  token("aws-cli", "-runbook"),
  token("ses.account.suppression", "_recommendation"),
  token("runtime-policy", ".example"),
  token("sns-topic-policy", ".example"),
  token("sns-dlq-policy", ".example"),
  "deploy/setup/main.mjs",
  "node deploy/setup",
];

const FORBIDDEN_GUIDANCE = [
  "aws login",
  "~/.aws/sso/cache",
  "AWSReservedSSO_",
  "manually preconfigured AWS profile",
  "static IAM provisioner",
  "export AWS_ACCESS_KEY_ID",
];

describe("setup documentation", () => {
  it("resolves every local Markdown path and anchor", async () => {
    await Promise.all(
      DOCUMENTS.map(async (document) => {
        const sourcePath = resolve(ROOT, document);
        const markdown = await readFile(sourcePath, "utf8");
        await Promise.all(
          markdownLinkTargets(markdown).map(async (target) => {
            if (isExternalTarget(target)) return;
            const [rawPath, rawAnchor = ""] = target.split("#", 2);
            const targetPath =
              rawPath === "" ? sourcePath : resolve(dirname(sourcePath), decodeURI(rawPath));

            await expect(
              access(targetPath),
              `${document}: missing link target ${target}`,
            ).resolves.toBeUndefined();
            if (rawAnchor !== "") {
              expect(extname(targetPath), `${document}: anchor target must be Markdown`).toBe(
                ".md",
              );
              const targetMarkdown = await readFile(targetPath, "utf8");
              expect(
                markdownAnchors(targetMarkdown),
                `${document}: unresolved anchor ${target}`,
              ).toContain(decodeURIComponent(rawAnchor));
            }
          }),
        );
      }),
    );
  });

  it("keeps documented setup commands aligned with parser and static help", async () => {
    const helpCommands = helpCommandRows(HELP_TEXT);
    expect(helpCommands).toEqual([
      "(none)",
      "init",
      "doctor",
      "status [--refresh]",
      "continue",
      "aws auth",
      "aws permissions",
      "aws plan",
      "aws apply",
      "deploy plan",
      "deploy apply",
      "validate pre-simulator",
      "validate simulator",
      "validate final",
      "destroy plan",
      "destroy apply",
    ]);

    for (const command of expandHelpCommands(helpCommands)) {
      const args = command === "" ? [] : command.split(/\s+/u);
      expect(() => parseSetupArgv(args), `help command: ${command || "(none)"}`).not.toThrow();
    }

    const documentation = await Promise.all(
      DOCUMENTS.map(async (document) => ({
        document,
        markdown: await readFile(resolve(ROOT, document), "utf8"),
      })),
    );
    for (const { document, markdown } of documentation) {
      for (const command of documentedSetupCommands(markdown)) {
        const suffix = command.slice("pnpm nusend:setup".length).trim();
        const args = suffix === "" ? [] : suffix.split(/\s+/u);
        expect(() => parseSetupArgv(args), `${document}: ${command}`).not.toThrow();
        expect(commandIsRepresentedInHelp(args, helpCommands), `${document}: ${command}`).toBe(
          true,
        );
      }
    }
  });

  it("documents Git on both the trusted workstation and Node-free VPS", async () => {
    const readme = await readFile(resolve(ROOT, "README.md"), "utf8");
    const deployment = await readFile(resolve(ROOT, "docs/deployment.md"), "utf8");
    expect(readme).toMatch(/workstation with[^\n]*Git/iu);
    expect(readme).toMatch(/VPS needs Git/iu);
    expect(deployment).toMatch(/workstation with[^\n]*Git/iu);
    expect(deployment).toMatch(/VPS needs only:[\s\S]*Git for the exact-tag checkout/iu);
  });

  it("documents SSO-only setup, policy handoff, and honest permission limits", async () => {
    const awsSetup = await readFile(resolve(ROOT, "docs/aws-setup.md"), "utf8");
    const deployment = await readFile(resolve(ROOT, "docs/deployment.md"), "utf8");
    const readme = await readFile(resolve(ROOT, "README.md"), "utf8");
    const combined = [awsSetup, deployment, readme].join("\n");

    expect(combined).toMatch(/IAM Identity Center/iu);
    expect(combined).toMatch(/sso_session|modern refreshable SSO/iu);
    expect(combined).toMatch(/aws auth/iu);
    expect(combined).toMatch(/aws permissions/iu);
    expect(combined).toMatch(/nusend-provisioner-policy\.json/iu);
    expect(combined).toMatch(/browser|device.?code/iu);
    expect(combined).toMatch(/Identity Center region/iu);
    expect(combined).toMatch(/workload region/iu);
    expect(combined).toMatch(/not fully verifiable|no universally available complete preflight/iu);
    expect(combined).toMatch(/reassign/iu);
    expect(combined).toMatch(/Do not edit [`']?AWSReservedSSO/iu);
    expect(combined).toMatch(
      /(?:reject|rejected|never accepts).{0,80}aws login|aws login.{0,80}(?:reject|rejected)/iu,
    );
    expect(combined).toMatch(/never parses.{0,40}\.aws\/sso\/cache/iu);
    expect(combined).not.toMatch(/node deploy\/setup/iu);
    expect(combined).not.toMatch(/run `aws login`|use aws login to/iu);
  });

  it("removes stale setup assets and references while retaining only the stack and provisioner policy", async () => {
    const activeDocumentation = await Promise.all(
      [...DOCUMENTS, ".env.example"].map((path) => readFile(resolve(ROOT, path), "utf8")),
    );
    const joined = activeDocumentation.join("\n");
    for (const staleToken of STALE_TOKENS) {
      expect(joined, `stale token: ${staleToken}`).not.toContain(staleToken);
    }
    for (const forbidden of FORBIDDEN_GUIDANCE) {
      // Explicit prohibitions may mention these tokens; other lines must not.
      if (
        forbidden === "AWSReservedSSO_" ||
        forbidden === "aws login" ||
        forbidden === "~/.aws/sso/cache"
      ) {
        const withoutProhibitions = joined
          .split("\n")
          .filter(
            (line) =>
              !/do not|never|reject|prohibit|not support|unsupported/iu.test(line) &&
              !/AWSReservedSSO_\*/u.test(line),
          )
          .join("\n");
        if (forbidden === "AWSReservedSSO_") {
          expect(
            withoutProhibitions,
            `guidance must not instruct editing ${forbidden}`,
          ).not.toMatch(/edit[^\n]*AWSReservedSSO_|AWSReservedSSO_[^\n]*PutRolePolicy/iu);
        } else {
          expect(withoutProhibitions, `guidance must not recommend ${forbidden}`).not.toContain(
            forbidden,
          );
        }
        continue;
      }
      expect(joined, `forbidden guidance: ${forbidden}`).not.toContain(forbidden);
    }

    await Promise.all(
      [...DELETED_AWS_PATHS, ...DELETED_SETUP_PATHS].map((path) =>
        expect(
          access(resolve(ROOT, path)),
          `deleted path still exists: ${path}`,
        ).rejects.toMatchObject({ code: "ENOENT" }),
      ),
    );

    expect(await listFiles(resolve(ROOT, "deploy/aws"))).toEqual([
      "cloudformation.test.ts",
      "nusend-stack.json",
      "policies/provisioning-policy.example.json",
    ]);

    await expect(access(resolve(ROOT, "deploy/setup"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(resolve(ROOT, "apps/setup-cli/src/main.ts"))).resolves.toBeUndefined();
  });
});

function markdownLinkTargets(markdown: string): string[] {
  return [...markdown.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu)].map(
    (match) => match[1] ?? "",
  );
}

function isExternalTarget(target: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(target);
}

function markdownAnchors(markdown: string): string[] {
  const counts = new Map<string, number>();
  const anchors: string[] = [];
  for (const match of markdown.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gmu)) {
    const heading = (match[1] ?? "")
      .replace(/<[^>]+>/gu, "")
      .replace(/!?\[([^\]]+)\]\([^)]+\)/gu, "$1")
      .replace(/[`*_~]/gu, "");
    const base = heading
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s+/gu, "-");
    const duplicate = counts.get(base) ?? 0;
    counts.set(base, duplicate + 1);
    anchors.push(duplicate === 0 ? base : `${base}-${duplicate}`);
  }
  return anchors;
}

function helpCommandRows(help: string): string[] {
  const commandSection = help.split("Commands:\n")[1]?.split("\n\nGlobal options:")[0] ?? "";
  return commandSection
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s{2,}/u)[0] ?? line);
}

function expandHelpCommands(commands: string[]): string[] {
  return commands.flatMap((command) => {
    if (command === "(none)") return [""];
    if (command === "status [--refresh]") return ["status", "status --refresh"];
    return [command];
  });
}

function documentedSetupCommands(markdown: string): string[] {
  return [...markdown.matchAll(/pnpm nusend:setup(?:[ \t]+[^\n`|]*)?/gu)].map((match) =>
    (match[0] ?? "").trim().replace(/[.,;:]+$/u, ""),
  );
}

function commandIsRepresentedInHelp(args: string[], helpCommands: string[]): boolean {
  if (args.length === 0) {
    return HELP_TEXT.startsWith("Usage: pnpm nusend:setup") && helpCommands.includes("(none)");
  }
  const command = args.join(" ");
  return helpCommands.some(
    (helpCommand) =>
      helpCommand === command ||
      (helpCommand === "status [--refresh]" && ["status", "status --refresh"].includes(command)),
  );
}

function token(...parts: string[]): string {
  return parts.join("");
}

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(resolve(root, prefix), { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      return entry.isDirectory() ? listFiles(root, path) : [path];
    }),
  );
  return files.flat().sort();
}
