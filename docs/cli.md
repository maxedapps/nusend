# Nusend CLI

Build from this repo:

```sh
pnpm --filter @nusend/cli build
./apps/cli/dist/main.js --help
```

Implemented commands:

```sh
nusend login <base-url> [--name <client-name>] [--permission resource:action ...]
nusend logout [--revoke]
nusend whoami [--json]
nusend api-keys list [--limit <n>] [--offset <n>] [--json]
nusend api-keys create --name <name> --permission resource:action ... [--expires-at <iso> | --no-expiry]
nusend api-keys revoke <id>
nusend api-keys rotate <id>
nusend contacts list [--email <email>] [--limit <n>] [--offset <n>] [--json]
nusend contacts get <id> [--json]
nusend contacts create <email> [--json]
nusend contacts update <id> <email> [--json]
nusend contacts delete <id> [--json]
nusend mailings list [--limit <n>] [--offset <n>] [--json]
nusend mailings get <id> [--json]
nusend config repair-permissions
```

Options also accept `--opt=value` syntax; tokens split on the first `=`, so values may contain `=` themselves. Boolean flags such as `--json` reject an attached value, and empty values (`--name=`) are usage errors. `--version`/`-v` is recognized only as the first token after global options; `--help`/`-h` anywhere prints the global help.

New API keys expire after 365 days by default. Use `--expires-at` for an explicit date or `--no-expiry` to opt out. Raw keys are shown once on create/rotate and then stored only as hashes by the service. `api-keys list` returns one page (server default 50); human output prints a "More keys available" hint with the next offset when further pages exist.

`login` requires a domain-root base URL such as `https://nusend.example.com`; path-carrying URLs (for example `https://host/nusend`) are rejected because sub-path deployments are unsupported. If an older configuration stored a prefixed base URL, commands fail with the same clear message — re-run `nusend login <root-url>` to repair the profile. Denied, expired, and unrecognized device codes are reported as authentication failures.

`logout` is idempotent. With a stored credential, `logout --revoke` revokes remotely and always removes the local credential; a failed remote revoke is emitted as a warning. When `NUSEND_API_KEY` is set, logout deletes nothing: the environment key stays active until you unset it, and any stored credential for the profile is kept (reported in human output and as `storedCredentialKept` in `--json` mode).

## Output and exit codes

`--json` prints exactly one success document to stdout. Every error is exactly one compact object on stderr:

```json
{"error":{"code":"invalid_request","message":"..."}}
```

Two commands additionally emit informational JSON lines on stderr in `--json` mode, keeping the stdout contract intact:

- `login --json` prints one verification line before polling, so scripts can present the activation URL and code: `{"verification":{"uri":"...","uriComplete":"...","userCode":"...","expiresAt":"..."}}` (`uriComplete` may be null).
- `logout --revoke --json` reports a failed remote revoke as `{"warning":{"code":"revoke_failed","message":"..."}}`, and an environment credential that cannot be revoked as `{"warning":{"code":"revoke_unsupported","message":"..."}}`.

Human errors are plain `Error: ...` text, with an authentication hint where useful.

| Exit | Meaning |
|---:|---|
| 0 | Success |
| 1 | Unexpected/internal CLI failure |
| 2 | Invalid CLI usage |
| 3 | Authentication or device-authorization failure |
| 4 | API/HTTP failure |

## Configuration

Config defaults to an XDG-style directory. Credentials are stored separately in `credentials.json` with mode `0600` and a mode `0700` directory on Unix. Run `nusend config repair-permissions` if these modes were broadened. The command is a no-op on Windows.

Environment overrides:

- `NUSEND_API_KEY`
- `NUSEND_BASE_URL`
- `NUSEND_PROFILE`

Explicit CLI flags win over environment/profile defaults.
