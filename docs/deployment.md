# Deployment

Production runs entirely under Docker Compose 5.3+. Prerequisites on the host:

- Docker Engine
- Docker Compose **5.3.0 or newer** (`docker compose version`)
- A public DNS name for the instance
- Google OAuth, AWS SES, and R2/restic credentials

Nusend does not install Docker, manage provider firewalls, or require Infisical. Optional secret launchers may inject the same environment variables Compose already reads.

## 1. Configure

```sh
git clone https://github.com/maxedapps/nusend.git
cd nusend
git checkout vX.Y.Z   # use a published release tag
cp .env.example .env
```

Edit `.env`:

- `NUSEND_DOMAIN` — public hostname
- `NUSEND_INGRESS_MODE` — `direct` or `cloudflare`
- `NUSEND_OWNER_EMAIL` / `NUSEND_OWNER_NAME` — exact owner reconciled on every API start
- Google, Better Auth, API-key, unsubscribe, and application AWS/SES values
- `NUSEND_RESTIC_REPOSITORY`, `NUSEND_R2_ACCESS_KEY_ID`, `NUSEND_R2_SECRET_ACCESS_KEY`, `NUSEND_RESTIC_PASSWORD`

Compose derives `BETTER_AUTH_URL`, trusted origins, and the public base URL from `NUSEND_DOMAIN`. Keep application AWS credentials distinct from the R2 backup credentials.

Optional Infisical (or any other launcher) can supply the same variable names:

```sh
infisical run -- docker compose up -d --wait
```

## 2. Ingress mode

| Mode | When to use | Operator responsibilities |
| --- | --- | --- |
| `direct` | DNS points straight at the VPS | Public `A`/`AAAA`, TCP 80/443 reachable for automatic HTTPS |
| `cloudflare` | Hostname is Cloudflare-proxied | Proxied DNS, SSL/TLS **Full (strict)**, and origin 80/443 limited to current Cloudflare IP ranges in your provider firewall |

Caddy config is selected as `/etc/nusend-caddy/${NUSEND_INGRESS_MODE}/Caddyfile` from the repository tree. Invalid modes fail at container start. Direct mode trusts no forwarding headers; Cloudflare mode trusts only current Cloudflare ranges with strict parsing.

## 3. Start

```sh
docker compose up -d --wait
```

Compose:

1. creates named volumes for SQLite, backup work, and Caddy state
2. fixes database volume ownership
3. runs migrations and reconciles the configured owner
4. starts healthy API, then worker, Caddy, and backup
5. completes an initial off-site backup before reporting the stack healthy
6. publishes only ports 80/443

Check status and logs:

```sh
docker compose ps
curl -fsS "https://${NUSEND_DOMAIN}/health"
docker compose exec -T api bun -e "const r=await fetch('http://127.0.0.1:3000/health/db'); if(!r.ok) process.exit(1)"
docker compose logs --since 30m api worker caddy backup
```

Public `/health/db` must remain 404. Sign in as the configured owner and complete SES readiness from [`ses-setup.md`](./ses-setup.md).

## 4. Backups

Backup is a mandatory Compose service. It initializes the restic repository when absent (restic exit 10 only), runs an initial backup, then repeats about every 24 hours. A failed backup exits so Docker restart backoff retries it.

```sh
# Status / recent logs
docker compose ps backup
docker compose logs --since 24h backup

# On-demand backup
docker compose run --rm --no-deps backup run

# List snapshots
docker compose run --rm --no-deps --entrypoint sh backup -c \
  'export RESTIC_CACHE_DIR=/work/.restic-cache; restic snapshots --host nusend --tag nusend-db'
```

### Restore

Restore requires an explicit 64-character snapshot id. Never use `latest`.

```sh
docker compose stop api worker backup
docker compose run --rm --no-deps backup restore <64-hex-snapshot-id>
docker compose up -d --wait
```

The previous database file is preserved beside the live DB as `nusend.sqlite.pre-restore` when one existed.

## 5. Update

```sh
git fetch --tags
git checkout vX.Y.Z
docker compose pull
docker compose up -d --wait
```

Release tags and Compose image tags are kept aligned by maintainers. GHCR retains only the three newest immutable app/backup release versions; there is no mutable `latest` tag. Do not rely on an older release image remaining pullable.

## 6. Common failures

| Symptom | Likely cause |
| --- | --- |
| `docker compose` rejects `pre_start` | Compose older than 5.3.0 |
| Compose interpolation error naming a variable | Missing required `.env` / shell value |
| API never becomes healthy | Migration/owner conflict, bad app secrets, or volume permissions |
| Owner bootstrap conflict | Database already has a different owner email |
| Backup stays unhealthy | Bad R2/restic values, network, or repository password |
| Caddy exits immediately | `NUSEND_INGRESS_MODE` not `direct` or `cloudflare`, or DNS/TLS issue |
| Public app unreachable behind Cloudflare | Origin not Full (strict), or firewall not limited to Cloudflare ranges |

## Notes

- Named volumes hold all mutable state; the only host bind is the repository Caddy config tree.
- Logs use Docker’s `local` driver with bounded rotation (`docker compose logs`).
- Worker tuning defaults live in application config; production Compose does not expose host-path or image-digest operator variables.
