# Nusend

Nusend is a single-user, self-hosted email orchestration service for AWS SES. Its HTTP service and first-party CLI manage contacts, mailings, delivery operations, suppressions, SES feedback, and scoped API-key access.

Nusend is pre-launch. Deploy it for controlled self-hosting and testing, but complete the documented live gates before broad marketing volume.

## Deploy

You need a public domain, Docker Engine, Docker Compose 5.3+, Google OAuth, AWS SES/SNS/SQS/IAM, and private R2/restic credentials. The Compose host does not need Node or pnpm.

```sh
git clone https://github.com/maxedapps/nusend.git
cd nusend
git checkout vX.Y.Z
cp .env.example .env
# Replace every placeholder in .env, then:
docker compose up -d --wait
```

Follow the complete provider, deployment, verification, monitoring, backup/restore, update, and pre-volume procedure in [`docs/deployment.md`](./docs/deployment.md).

## Source-built CLI

The CLI remains a private pnpm workspace. Build it from a tagged checkout on any machine with Node, pnpm 11, and network access to the public Nusend URL:

```sh
pnpm install --frozen-lockfile
pnpm --filter @nusend/cli build
./apps/cli/dist/main.js --help
./apps/cli/dist/main.js login https://mail.example.com
./apps/cli/dist/main.js whoami
```

Built-in `--help` is the command catalog. No global installation or `nusend` executable on `PATH` is assumed.
