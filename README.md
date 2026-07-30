# Nusend

Nusend is a single-user, self-hosted email orchestration service for AWS SES. Its HTTP service and first-party CLI manage contacts, mailings, delivery operations, suppressions, SES feedback, and scoped API-key access.

Nusend is pre-launch. Deploy it for controlled self-hosting and testing, but complete the documented live gates before broad marketing volume.

## Guided first-time setup

Run setup from a trusted Unix/WSL workstation with Node 22+, pnpm 11, Git, AWS CLI v2.22+, SSH, and curl. The VPS needs Git, Docker Engine, Docker Compose 5.3+, SSH, and a public domain; it does **not** need Node or pnpm.

Setup is SSO-only: the Effect wizard at `pnpm nusend:setup` discovers or configures a modern IAM Identity Center (`sso_session`) profile, runs browser or device-code login through AWS CLI, and never accepts static provisioner keys or `aws login`.

```sh
git clone https://github.com/maxedapps/nusend.git
cd nusend
git checkout vX.Y.Z
pnpm install --frozen-lockfile
pnpm nusend:setup
pnpm nusend:setup doctor
pnpm nusend:setup continue
pnpm nusend:setup status
```

Bare `pnpm nusend:setup` initializes when no installation exists, otherwise presents the next verified action. Explicit recovery commands (`init`, `aws auth`, `aws permissions`, plan/apply, validate, destroy) remain available. Each `continue` performs one verified stage or reports one manual/provider gate. Setup keeps mode-`0700` installation state and mode-`0600` `state.json`/`deployment.env` under `${NUSEND_SETUP_HOME:-~/.config/nusend/setup}/<installation-id>/`, verifies normal SSH host trust, deploys an exact release over SSH, and never prints secret values. Independently escrow the generated restic password.

Follow the complete [deployment and operations guide](./docs/deployment.md), including Google OAuth/R2, reviewed CloudFormation change sets, SES/DKIM approval, alarm/DLQ validation, backup restore and reboot proof, DMARC/inbox checks, quotas, and gradual ramp. Direct Compose commands there are for runtime inspection, updates, and recovery—not the primary first installation path. AWS details, SSO permission handoff, and destroy retention are in [AWS setup and CloudFormation safety](./docs/aws-setup.md).

## Source-built CLI

Build the private CLI on a trusted workstation that can reach the public Nusend URL, not on the Node-free VPS:

```sh
pnpm --filter @nusend/cli build
./apps/cli/dist/main.js --help
./apps/cli/dist/main.js login https://mail.example.com
./apps/cli/dist/main.js whoami
```

Built-in `--help` is the CLI command catalog. No global installation or `nusend` executable on `PATH` is assumed.
