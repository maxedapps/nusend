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

Options accept `--opt=value`; values may contain `=`. Boolean flags reject attached values, and empty values are usage errors. `--version`/`-v` is recognized only as the first token after global options; `--help`/`-h` anywhere prints global help.

New API keys expire after 365 days by default. Use `--expires-at` for an explicit date or `--no-expiry` to opt out. Raw keys are shown once on create/rotate. `api-keys list` returns one page; human output prints the next-offset hint when present. Mailing JSON includes required `counts.ambiguous`; human mailing output prints `ambiguous=N` when nonzero.

`login` requires a domain-root base URL such as `https://nusend.example.com`; sub-path deployments are unsupported. Polling is iterative, honors each server interval with a 1000 ms minimum, sleeps no later than local authorization expiry, and starts no token request at or after expiry. An approval returned by a request started before expiry is accepted. There is no polling-speed environment override.

`logout` is idempotent. With a stored credential, `logout --revoke` attempts remote revocation and always removes the local credential; a failed remote revoke is a warning. When `NUSEND_API_KEY` is set, logout deletes nothing locally or remotely.

## Output and exit codes

`--json` prints exactly one success document to stdout. Every error is exactly one compact object on stderr:

```json
{ "error": { "code": "invalid_request", "message": "..." } }
```

`login --json` prints one verification line on stderr before polling. `logout --revoke --json` prints remote-revocation warnings on stderr. Human errors use plain `Error: ...` text.

| Exit | Meaning                                        |
| ---: | ---------------------------------------------- |
|    0 | Success                                        |
|    1 | Unexpected/internal CLI failure                |
|    2 | Invalid CLI usage                              |
|    3 | Authentication or device-authorization failure |
|    4 | API/HTTP failure                               |

## Configuration and local-state locking

Config defaults to an XDG-style directory. Config and credentials share one cross-process lock for every mutation. Under that lock, Nusend reloads current JSON and publishes complete same-directory temporary files by rename; login writes credentials before config and prevents another cooperative CLI process from interleaving. Individual files are crash-safe, but a crash between the two login renames is not cross-file atomic.

Lock acquisition waits at most five seconds. A proven dead same-host owner may be reaped after the publication grace period; live, foreign-host, malformed, too-young, or permission-indeterminate owners are never stolen. An orphaned/malformed reaper mutex or uncertain release fails closed with operator-inspection guidance—do not delete unfamiliar lock/tombstone files while any CLI process may be running.

This protocol supports local filesystems only. Network-mounted config directories are unsupported. Windows local filesystems are intended to work but are not validated by the current project checks; unsupported hard-link/rename behavior fails rather than falling back to unsafe locking.

On Unix, the directory uses mode `0700` and config/credential files use `0600`. Run `nusend config repair-permissions` if these modes were broadened; it is a no-op on Windows.

Environment overrides:

- `NUSEND_API_KEY`
- `NUSEND_BASE_URL`
- `NUSEND_PROFILE`

Explicit CLI flags win over environment/profile defaults.
