# Set Up Lean pnpm Monorepo Skeleton

## Implementation Progress

Started: 2026-07-03 13:12 CEST

Progress tracker retained in this plan file per `implement-plan` workflow.

### Decomposition

- [x] Step A: Verify repo/tooling state and create root/app skeleton config files.
- [x] Step B: Install root dev toolchain with pnpm and generate lockfile.
- [x] Step C: Run formatter/linter/typecheck/test validation and adjust config only as needed.
- [x] Step D: Independent review after implementation and final validation.

### Parallelism Decision

- Implementation is sequential: most changes are small, related config files with shared validation dependencies.
- No safe parallel implementation subagent work was used because separate agents would overlap on root config/package files.
- Independent review will be requested after implementation.

### Work Log

- 2026-07-03 13:12 CEST: Read full plan. Verified repo root, pnpm `11.9.0`, and current git status (`.plans/` untracked from planning artifacts).
- 2026-07-03 13:18 CEST: Created root workspace/tooling files, `apps/service` and `apps/cli` package/tsconfig files, README, and MIT LICENSE. Did not create `src/`, `packages/`, `.env.example`, runtime dependencies, bins, or placeholder application files.
- 2026-07-03 13:18 CEST: Installed root dev toolchain with pnpm: `typescript`, `@types/bun`, `oxlint`, `oxfmt`, `vitest`; generated `pnpm-lock.yaml`.
- 2026-07-03 13:19 CEST: Ran `pnpm format` after initial `pnpm format:check` reported `package.json` formatting changes; Oxfmt successfully formatted matched JSON/TS config files.
- 2026-07-03 13:28 CEST: Incorporated low-severity review feedback by removing inert app `rootDir`/`outDir`, adding Oxfmt schema metadata, and narrowing explicit Oxlint plugins from `typescript`/`unicorn`/`oxc` to `typescript`/`oxc`.
- 2026-07-03 13:35 CEST: Removed ignored temporary review/probing artifacts under `.tmp/`.

### Validation Log

- 2026-07-03 13:20 CEST: `pnpm format:check` passed.
- 2026-07-03 13:20 CEST: `pnpm lint` passed.
- 2026-07-03 13:20 CEST: `pnpm typecheck` passed for `apps/cli` and `apps/service`.
- 2026-07-03 13:20 CEST: `pnpm test` passed with no test files via `passWithNoTests`.
- 2026-07-03 13:20 CEST: `pnpm check` passed.
- 2026-07-03 13:29 CEST: Re-ran `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm check`; all passed after review fixes.
- 2026-07-03 13:34 CEST: Final `pnpm check` passed. Manual tree check confirmed no `packages/` directory and no `apps/*/src` directories.

### Review Log

- 2026-07-03 13:24 CEST: Independent Claude review (`cd719059-44f7-45ef-9a5a-026068658766`) found no critical/high issues and confirmed core constraints were satisfied. Low findings: package manifest formatting churn with Oxfmt, explicit Unicorn plugin may be broader than conservative intent, inert app `rootDir`/`outDir`, no-op Oxfmt config without schema, future test typecheck caveat, and planning HTML artifact note.
- 2026-07-03 13:28 CEST: Fixed accepted low findings: removed inert app `rootDir`/`outDir`, added Oxfmt schema, narrowed explicit Oxlint plugins. Accepted package-manifest formatting churn as normal formatter workflow (run `pnpm format` after dependency changes). Future test typecheck remains intentionally deferred until tests are added. Planning HTML artifact retained as part of existing plan output.
- 2026-07-03 13:32 CEST: Follow-up Claude review in same session confirmed material concerns resolved and no remaining blockers/important issues.

## Summary

Set up Nusend's repository foundation only: pnpm workspace metadata, two app package manifests, strict TypeScript config, Oxlint/Oxfmt config, Vitest config, README/LICENSE, and the lockfile. Do **not** add application source code, route files, database files, worker files, migrations, placeholder `src/` trees, shared packages, or unused runtime dependencies.

This step should leave the repo ready for future implementation while staying aligned with `PROJECT.md`'s lean monorepo direction.

## Confirmed Requirements

- Use `pnpm` for package and monorepo management.
- Use `oxfmt` for formatting.
- Use `oxlint` for linting.
- Use `vitest` for testing.
- Use TypeScript configuration, but add no concrete TypeScript application code.
- No other workflow/build/lint/format/test tools:
  - no Turbo/Nx
  - no ESLint
  - no Prettier
  - no tsup/tsdown/unbuild
  - no extra test runners
- Create only the base skeleton and config.
- Avoid empty placeholder file sprawl.
- Initial workspace apps only:
  - `apps/service`
  - `apps/cli`
- No `packages/` folder initially.
- Runtime target remains Bun, but package/workspace management stays pnpm.

## Relevant Current State

Current repository contains:

- `PROJECT.md`
- `.gitignore`
- `.git/`

Existing `.gitignore` already covers the important generated/local paths:

- `node_modules/`
- `.pnpm-store/`
- `dist/`, `build/`, `.out/`, `coverage/`
- SQLite/runtime/log/temp files
- `.env` while allowing `.env.example`
- `bun.lockb`
- editor/OS/cache files

Do not duplicate ignore rules unnecessarily unless a tool requires its own ignore configuration.

## Research Findings

### pnpm Workspaces

Sources:

- <https://pnpm.io/pnpm-workspace_yaml>
- <https://pnpm.io/catalogs>

Findings:

- `pnpm-workspace.yaml` defines the workspace root and package globs.
- The root package is always included in the workspace.
- If `packages` is omitted, only the root package is included.
- pnpm catalogs centralize dependency versions for reuse via `catalog:`.
- Catalogs are most useful when the same dependency version is shared across multiple workspace packages.

Plan impact:

- Add `pnpm-workspace.yaml` with only `apps/*`.
- Do **not** use pnpm catalogs yet for root-only dev dependencies. Direct root dev dependency versions are leaner. Introduce catalogs later when app packages actually share dependency versions such as `hono`, `zod`, or TypeScript-related package entries.

### Oxlint

Source:

- <https://oxc.rs/docs/guide/usage/linter/config.html>

Findings:

- Oxlint auto-discovers `.oxlintrc.json` or `oxlint.config.ts`.
- JSON config avoids needing TypeScript execution for the lint config itself.
- Categories, plugins, rules, overrides, and ignore patterns are configurable.
- Type-aware/type-check options exist but can be deferred for this skeleton.

Plan impact:

- Use `.oxlintrc.json`, not `oxlint.config.ts`, for a simpler bootstrap.
- Keep the config conservative.
- Validate exact plugin names/schema path against the installed Oxlint version during implementation.

### Oxfmt

Sources:

- <https://oxc.rs/docs/guide/usage/formatter/cli.html>
- <https://oxc.rs/docs/guide/usage/formatter/config-file-reference>

Findings:

- CLI uses `oxfmt`.
- Supports `--write`, `--check`, `--list-different`, and `--config`.
- If no ignore path is supplied, `.gitignore` is used.
- `.oxfmtrc.json` is documented as a supported config file.

Plan impact:

- Add Oxfmt as the formatter, but first verify the package installs and the config file works with the installed version.
- If config support or file coverage differs from docs, keep CLI defaults and adjust scripts; do **not** add Prettier.

### Vitest

Source:

- <https://vitest.dev/guide/projects.html>

Findings:

- Vitest `workspace` config is deprecated since 3.2 in favor of `test.projects`.
- `projects` is useful for multi-project setups, but unnecessary before test files or per-app test needs exist.
- `passWithNoTests` can keep an initial skeleton green with no tests.

Plan impact:

- Use a simple root `vitest.config.ts`.
- Do **not** configure `projects: ["apps/*"]` yet; it adds failure surface and no value before tests exist.
- Add `projects` later when tests or per-app config require it.

## Chosen Strategy

Create a root-owned toolchain and two minimal app workspaces.

### Root-owned toolchain

Install root dev dependencies only:

- `typescript`
- `@types/bun`
- `oxlint`
- `oxfmt`
- `vitest`

No runtime dependencies yet, because no application code consumes them.

### Workspace packages

Create only:

- `apps/service/package.json`
- `apps/service/tsconfig.json`
- `apps/cli/package.json`
- `apps/cli/tsconfig.json`

Do not create `src/` directories yet. Empty directories are not tracked by Git, and placeholder files would violate the "not a bunch of empty files" constraint.

### TypeScript empty-project handling

Use app `tsconfig.json` files with:

- `extends: "../../tsconfig.base.json"`
- `files: []`

This allows `tsc --noEmit -p tsconfig.json` to pass before source files exist and avoids `TS18003`. When real code is added, update each app config to include `src/**/*.ts`.

### Tests

Use one root `vitest.config.ts` with `passWithNoTests: true` for the skeleton. Let Vitest discover tests later via default or explicit include patterns once tests are added. Avoid Vitest projects until there is a concrete need.

### README and LICENSE

Create both now:

- `README.md`: short, useful repository entry point with project name, pointer to `PROJECT.md`, and basic commands.
- `LICENSE`: MIT license, because `PROJECT.md` states the project is open-source MIT.

These are valid repository metadata, not application code or empty scaffolding.

### `.env.example`

Defer `.env.example` for this step.

Reason: `PROJECT.md` lists it in the desired structure, but this skeleton step is not implementing config loading or concrete env contracts yet. Adding speculative environment variables now would create misleading configuration surface. Add `.env.example` when the service config module is implemented or when exact variable names are decided.

## Alternatives Considered and Rejected

### Add Turbo or Nx

Rejected. Violates "No other tools" and is unnecessary for two apps.

### Add ESLint or Prettier

Rejected. The user explicitly chose Oxlint and Oxfmt.

### Add `packages/core`, `packages/types`, or `packages/client`

Rejected. `PROJECT.md` explicitly says no premature shared packages. Add shared packages only after real duplication or additional consumers exist.

### Create `src/main.ts`, `src/app.ts`, `src/worker.ts`, routes, DB folders, migrations, or placeholder files

Rejected. That would be concrete code or empty scaffolding. This step is config/skeleton only.

### Add Hono, AWS SDK, SQLite, R2, or CLI runtime dependencies now

Rejected. No source code consumes them yet. Adding them now would create dead dependencies and conflict with the lean setup goal.

### Use pnpm catalogs immediately

Rejected for this step. Catalogs are useful for shared dependency versions across workspace packages; the initial dependencies are root-only dev tools. Add catalogs later when multiple packages share runtime/dev dependency ranges.

### Configure Vitest projects immediately

Rejected. With no test files and no per-app test configs, root-only Vitest config is simpler and less likely to fail.

## Implementation Plan

### 1. Verify local tool versions and repo root

Run from the repo root:

```sh
pwd
pnpm --version
```

Use the installed pnpm version in root `package.json`'s `packageManager` field.

Expected repo root:

```txt
/Users/maximilianschwarzmuller/development/projects/nusend
```

### 2. Add root `package.json`

Create `package.json` with:

- `name`: `nusend`
- `private`: `true`
- `type`: `module`
- `packageManager`: `pnpm@<installed-version>`
- scripts:
  - `format`: run Oxfmt in write mode
  - `format:check`: run Oxfmt in check mode
  - `lint`: run Oxlint
  - `typecheck`: run `pnpm -r --if-present typecheck`
  - `test`: run `vitest run`
  - `test:watch`: run `vitest`
  - `check`: run format check, lint, typecheck, and tests
- root `devDependencies`:
  - `typescript`
  - `@types/bun`
  - `oxlint`
  - `oxfmt`
  - `vitest`

Important:

- Use direct version ranges in `devDependencies` for now.
- Do not add `dependencies` yet.
- Do not add app runtime dependencies yet.

### 3. Add `pnpm-workspace.yaml`

Create:

```yaml
packages:
  - "apps/*"
```

Do not add catalogs yet.

### 4. Add root `tsconfig.base.json`

Create a strict shared TypeScript base config suitable for Bun/ESM.

Recommended options:

- `target`: `ESNext`
- `module`: `ESNext`
- `moduleResolution`: `Bundler`
- `lib`: `ESNext`
- `types`: `["bun"]`
- `strict`: `true`
- `noEmit`: `true`
- `skipLibCheck`: `true`
- `resolveJsonModule`: `true`
- `verbatimModuleSyntax`: `true`
- `allowImportingTsExtensions`: `true`
- `forceConsistentCasingInFileNames`: `true`
- sensible unused-code checks such as `noUnusedLocals` / `noUnusedParameters` if desired for strictness

Do not put `include`, `exclude`, or `files` in the base config.

### 5. Add `apps/service/package.json`

Create `apps/service/package.json` with:

- `name`: `@nusend/service`
- `private`: `true`
- `type`: `module`
- scripts:
  - `typecheck`: `tsc --noEmit -p tsconfig.json`

Do not add dependencies yet.

### 6. Add `apps/service/tsconfig.json`

Create `apps/service/tsconfig.json` with:

- `extends`: `../../tsconfig.base.json`
- app-local compiler options such as:
  - `rootDir`: `src`
  - `outDir`: `dist`
- `files`: `[]`

The `files: []` setting is temporary until source code exists.

### 7. Add `apps/cli/package.json`

Create `apps/cli/package.json` with:

- `name`: `@nusend/cli`
- `private`: `true`
- `type`: `module`
- scripts:
  - `typecheck`: `tsc --noEmit -p tsconfig.json`

Do not add a `bin` field yet because there is no CLI entrypoint code.
Do not add dependencies yet.

### 8. Add `apps/cli/tsconfig.json`

Create `apps/cli/tsconfig.json` with the same minimal pattern as the service app:

- `extends`: `../../tsconfig.base.json`
- optional future-facing `rootDir` / `outDir`
- `files`: `[]`

### 9. Add `.oxlintrc.json`

Create a conservative JSON config.

Recommended approach:

- Use the installed schema path if present, typically `./node_modules/oxlint/configuration_schema.json`.
- Enable only stable, useful categories/plugins.
- Start with `correctness` as error and `suspicious`/`perf` as warning.
- Include TypeScript support if supported by the installed version.
- Avoid premature Vitest-specific plugin config until tests exist.
- Avoid aggressive pedantic/style rules in the skeleton.

Validation rule:

- If Oxlint rejects a plugin/config option, simplify the config instead of adding another linting tool.

### 10. Add `.oxfmtrc.json`

Create a minimal Oxfmt config only after confirming the installed package recognizes it.

Recommended approach:

- Keep preferences minimal.
- Rely on `.gitignore` for ignored files.
- If Oxfmt's installed version has a narrower config surface than docs imply, use CLI defaults and keep the file minimal or omit it if unsupported.

Validation rule:

- If Oxfmt fails on unsupported file types or config keys, adjust scripts/config to match Oxfmt; do not add Prettier.

### 11. Add `vitest.config.ts`

Create root Vitest config with:

- `test.environment`: `node`
- `test.passWithNoTests`: `true`
- `test.globals`: `false`
- mock cleanup options such as `clearMocks` / `restoreMocks`

Do not configure `test.projects` yet.

### 12. Add `README.md`

Create a short README with:

- project name
- one-sentence description
- pointer to `PROJECT.md` for detailed architecture
- basic development commands:
  - `pnpm install`
  - `pnpm format:check`
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm check`

Keep it concise. Do not document APIs or commands that do not exist yet.

### 13. Add `LICENSE`

Add the standard MIT license text for the project owner/year.

Use the local git identity/project owner context already established for the repository.

### 14. Install dependencies with pnpm

Run:

```sh
pnpm install
```

or, if creating package files before version selection:

```sh
pnpm add -D -w typescript @types/bun oxlint oxfmt vitest
```

Then ensure the resulting `package.json` and `pnpm-lock.yaml` are consistent.

Do not use npm/yarn/bun for dependency installation.

### 15. Verify the skeleton

Run:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm check
```

Expected result: all pass despite no application source files and no tests.

If a tool fails because of a config mismatch, simplify the relevant config rather than adding another tool.

## Expected File Changes

Create:

```txt
package.json
pnpm-workspace.yaml
tsconfig.base.json
.oxlintrc.json
.oxfmtrc.json            # only if supported by installed oxfmt
vitest.config.ts
README.md
LICENSE
pnpm-lock.yaml
apps/service/package.json
apps/service/tsconfig.json
apps/cli/package.json
apps/cli/tsconfig.json
```

Do not create:

```txt
packages/
apps/service/src/
apps/cli/src/
apps/service/src/main.ts
apps/service/src/app.ts
apps/service/src/worker.ts
apps/cli/src/main.ts
routes/
db/
queue/
ses/
email/
migrations/
.env.example
```

## Verification Plan

### Required checks

- `pnpm install` succeeds.
- `pnpm format:check` succeeds.
- `pnpm lint` succeeds.
- `pnpm typecheck` succeeds.
- `pnpm test` succeeds with no tests.
- `pnpm check` succeeds.

### Manual review checks

- No concrete application code was added.
- No empty placeholder source files were added.
- No `packages/` folder exists.
- No runtime dependencies were added without consuming code.
- Root scripts use pnpm.
- Lockfile is `pnpm-lock.yaml`, not `package-lock.json`, `yarn.lock`, or `bun.lockb`.
- App package names are stable and scoped:
  - `@nusend/service`
  - `@nusend/cli`

## Risks and Mitigations

### Oxfmt package/config mismatch

Risk: Oxfmt is newer than Oxlint and its npm package/config support could differ from docs.

Mitigation:

- Verify installation and config support before finalizing `.oxfmtrc.json`.
- Prefer Oxfmt CLI defaults over adding another formatter.
- If needed, narrow script targets or simplify config.

### Empty TypeScript projects failing typecheck

Risk: TypeScript can fail with `TS18003` if an app config includes no files.

Mitigation:

- Use `files: []` in app configs until source files exist.

### Vitest failing because there are no tests

Risk: A no-test repository may fail test commands.

Mitigation:

- Use `passWithNoTests: true` in root Vitest config for the skeleton.

### Oxlint plugin/schema drift

Risk: Config examples may not match the installed Oxlint version exactly.

Mitigation:

- Validate with `pnpm lint`.
- If a plugin/rule/schema path fails, simplify the config.

### Premature metadata/API surface

Risk: Adding `.env.example`, bins, runtime deps, or source folders could imply implementation decisions not made yet.

Mitigation:

- Defer `.env.example`, `bin`, runtime deps, and source folders to later implementation phases.

## Open Assumptions

- `README.md` and `LICENSE` are acceptable in this step because `PROJECT.md` includes them in the intended root structure and declares MIT licensing.
- `.env.example` is intentionally deferred despite appearing in `PROJECT.md`, because exact env variable names should be introduced with the config implementation, not guessed in the skeleton.
- App `tsconfig.json` files may temporarily use `files: []`; future implementation should replace this with real `include` patterns when source code is added.

## Review Notes

This plan was reviewed with Claude. Incorporated feedback:

- Removed immediate Vitest `projects: ["apps/*"]` usage.
- Removed pnpm catalogs for root-only dev dependencies.
- Promoted README and LICENSE from optional to required.
- Made app `typecheck` scripts unconditional via `files: []`.
- Explicitly deferred `.env.example` as an intentional deviation from `PROJECT.md`.
- Added stronger Oxfmt validation guidance.
