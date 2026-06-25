# SmartNote Cloud — production deploy

Single-server deploy via `docker compose` + Caddy auto-TLS. Suits a $5–$20/mo VPS (1–2 vCPU, 2–4 GB RAM). Brings up:

| Service      | What                                          | Exposed?                          |
| ------------ | --------------------------------------------- | --------------------------------- |
| `postgres`   | Postgres 16 + pgvector                        | no (internal only)                |
| `embed`      | Self-hosted sentence-transformer embeddings   | no                                |
| `api`        | FastAPI REST + MCP (`/mcp`)                   | via Caddy → `https://API_DOMAIN`  |
| `caddy`      | Reverse proxy + auto Let's Encrypt TLS        | `:80` + `:443`                    |

## 1 · Prepare the server

- A clean Linux box (Ubuntu 22.04+ / Debian 12+ both fine)
- Docker Engine + Compose plugin (`curl -fsSL https://get.docker.com | sh`)
- One DNS A record pointing at this server:
  - `api.example.com` → public IP
- Firewall: open `80/tcp` + `443/tcp` (+ `443/udp` if you want HTTP/3). Keep `22/tcp` for SSH; close everything else.

## 2 · Clone + configure

```bash
git clone https://github.com/<you>/smartnote.git
cd smartnote/cloud/infra
cp .env.prod.example .env.prod
chmod 600 .env.prod
```

Edit `.env.prod` — at minimum set:

| Var | How to get |
| --- | --- |
| `API_DOMAIN` | The DNS name you set up |
| `ACME_EMAIL` | Real email — Let's Encrypt sends cert expiry warnings |
| `POSTGRES_PASSWORD` | `openssl rand -base64 32` |
| `JWT_SECRET` | `openssl rand -hex 32` |

## 3 · Bring it up

```bash
./deploy.sh           # build + start
```

Caddy will obtain certs on first boot (takes ~30 seconds if DNS is correct). Then:

```bash
./deploy.sh ps        # check containers
./deploy.sh logs      # follow logs
curl https://$API_DOMAIN/v1/health   # smoke test
```

## 4 · Issue the first admin API key

After a fresh deploy there are no API keys yet. Two ways to make one:

**A. Use the bootstrap helper** (quick, one-shot)

Temporarily flip `ALLOW_DEV_BOOTSTRAP=true` in `.env.prod`, restart, mint a key, then flip it back:

```bash
sed -i 's/ALLOW_DEV_BOOTSTRAP=false/ALLOW_DEV_BOOTSTRAP=true/' .env.prod
./deploy.sh restart
./deploy.sh bootstrap          # prints the api_key — save it!
sed -i 's/ALLOW_DEV_BOOTSTRAP=true/ALLOW_DEV_BOOTSTRAP=false/' .env.prod
./deploy.sh restart
```

**B. From inside the container** (works without flipping the flag)

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod \
  exec api bash scripts/issue_key.sh
```

Either way, you now have `sn_live_<prefix>_<secret>` — paste this into any MCP client config or pass it to the SDKs.

## 5 · Update / rollback

Updates are an idempotent re-run:

```bash
git pull
./deploy.sh           # rebuilds changed images and rolling-restarts
```

Rollback by checking out the previous tag and re-running `./deploy.sh`. `pgdata` and Caddy certs persist across rebuilds.

## 6 · Backups

The only volume you actually need to back up is `pgdata`. Cron a nightly dump:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod \
  exec -T postgres pg_dump -U $POSTGRES_USER $POSTGRES_DB | gzip > /backup/sn-$(date +%F).sql.gz
```

Restore by piping a dump back into `psql` inside the same container.

## Endpoints clients use

| Surface     | URL                                    |
| ----------- | -------------------------------------- |
| Cloud REST  | `https://$API_DOMAIN/v1/…`             |
| MCP (HTTP)  | `https://$API_DOMAIN/mcp`              |
| Health      | `https://$API_DOMAIN/v1/health`        |

MCP clients (Claude Code, Cursor, Opencode) and the SDKs use the api_key as `Authorization: Bearer …`.

## Alternative: pull pre-built images (no source on the server)

The flow above builds images on the server from a checkout. If you'd
rather keep source off the box, publish images from your dev machine and
have the server only pull + run. `docker-compose.deploy.yml` includes the
same Caddy reverse proxy + auto-HTTPS as the build flow, so you still get
`https://API_DOMAIN` with no compilation on the server.

**1 · Publish (once per release, from a checkout):**

```bash
docker login                      # to Docker Hub (namespace ztzsyy)
./scripts/release-images.sh       # builds linux/amd64 + pushes api + embed
```

This pushes `ztzsyy/smartnote-api` and `ztzsyy/smartnote-embed` (tagged
with the git short-SHA and `latest`). Postgres uses the public
`pgvector/pgvector:pg16` image directly — nothing to republish.

> Builds target `linux/amd64` by default so the images run on a typical
> x86_64 server even when built on an Apple-silicon Mac. Override with
> `PLATFORM=` / `IMAGE_TAG=` / `IMAGE_PREFIX=` env vars.

**2 · Run (on the server — needs three files):**

Copy `docker-compose.deploy.yml` + `Caddyfile` + a filled-in `.env` to
the server. DNS for `API_DOMAIN` must already point at the box and
80/443 be open (Caddy issues the cert on first boot):

```bash
cp .env.deploy.example .env       # set POSTGRES_PASSWORD, JWT_SECRET, API_DOMAIN, ACME_EMAIL
chmod 600 .env
docker compose -f docker-compose.deploy.yml --env-file .env pull
docker compose -f docker-compose.deploy.yml --env-file .env up -d
curl https://$API_DOMAIN/v1/health            # via Caddy
curl http://localhost:${API_PORT:-8000}/v1/health   # loopback, bypassing Caddy
```

The api image runs DB migrations on startup, so there's no migrate step.
Mint the first key by flipping `ALLOW_DEV_BOOTSTRAP=true` (restart, call
`POST /v1/dev/bootstrap`, flip back). The api host port is bound to
loopback only — public traffic enters through Caddy on 443.

**Updating:** re-run `release-images.sh`, then on the server
`docker compose -f docker-compose.deploy.yml --env-file .env pull && … up -d`.

## Troubleshooting

- **`./deploy.sh` reports api unhealthy** — `./deploy.sh logs` and look for postgres migration errors. Almost always a `JWT_SECRET` change against an existing DB; revert or rotate intentionally.
- **TLS handshake fails** — Caddy needs DNS resolving + ports 80/443 reachable *before* it can issue certs. `docker compose logs caddy` shows the ACME challenge errors.
- **Login returns 401** — token validation goes through `POST /v1/auth/token`. Check `JWT_SECRET` matches between the container that minted the key and the one validating now (only matters if you rotated).
- **Postgres data lost** — `docker compose down -v` removes the volume. Use plain `down` / `./deploy.sh stop` for non-destructive shutdown.
