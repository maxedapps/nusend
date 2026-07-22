# Nusend CLI

Build and run the private CLI workspace from the repository checkout:

```sh
pnpm install --frozen-lockfile
pnpm --filter @nusend/cli build
./apps/cli/dist/main.js --help
```

`--help` is the command catalog. It covers authentication, API keys, contacts, mailings, lists and memberships, suppressions, operations and deliveries, SES inspection, and local permission repair.

Mailing creation and contact imports take JSON from a file or stdin:

```sh
./apps/cli/dist/main.js mailings create --file mailing.json
cat contacts.json | ./apps/cli/dist/main.js lists contacts import <list-id> --file -
```

Options accept `--opt=value`; values may contain `=`. Boolean flags reject attached values, and empty values are usage errors. `--version`/`-v` is recognized only as the first token after global options; `--help`/`-h` anywhere prints global help.

New API keys expire after 365 days by default. Use `--expires-at` for an explicit date or `--no-expiry` to opt out. Raw keys are shown once on create/rotate. Paginated human output prints the next-offset hint when present. Mailing JSON includes required `counts.ambiguous`; human mailing output prints `ambiguous=N` when nonzero.

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

## Configuration and local state

Config defaults to an XDG-style directory. One `state.json` stores one service URL and credential. Login publishes the complete file through a same-directory temporary file, file sync, atomic rename, and directory sync where supported. Concurrent CLI mutation is unsupported; the last atomic writer wins.

Only login may replace readable malformed JSON/schema after authorization. Filesystem and permission errors always fail closed and never trigger a write. Other commands require valid state unless both `NUSEND_API_KEY` and a base URL are supplied explicitly or through `NUSEND_BASE_URL`, which bypasses disk entirely.

On Unix, the directory uses mode `0700` and `state.json` uses `0600`. Run `nusend config repair-permissions` if these modes were broadened; it is a no-op on Windows.

Explicit `--base-url` wins over `NUSEND_BASE_URL`, which wins over the stored URL. `NUSEND_API_KEY` wins over the stored credential and logout leaves stored state untouched while it is set.
