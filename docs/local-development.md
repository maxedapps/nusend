# Local Development

Install and validate:

```sh
pnpm install
pnpm check
pnpm build
```

Service:

```sh
pnpm --filter @nusend/service db:migrate
pnpm --filter @nusend/service auth:bootstrap --email max@example.com --name "Max"
pnpm --filter @nusend/service dev
```

CLI:

```sh
pnpm --filter @nusend/cli build
./apps/cli/dist/main.js --help
```

Required auth env for a real local service includes Better Auth Google variables and `NUSEND_API_KEY_HASH_SECRET`.
