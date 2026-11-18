# Docker deployment

LearnHarness ships a multi-stage `Dockerfile` and a `docker-compose.yml` for a
self-hosted web deployment. The image runs the Next.js **standalone** server
(`node server.js`) as the unprivileged `node` user.

> **Access control is your job.** LearnHarness has no user accounts in its
> supported profiles. Its own
> [development guide](development.md#subscription-connections-in-webdev) says a
> public deployment needs an independent access gate. Put it behind a reverse
> proxy with authentication (Basic Auth, Authelia, Cloudflare Access, …), a
> VPN, or a private network — never expose port 3000 directly to the Internet.

## Multi-user web: preview only

The [architecture](architecture.md#deployment-modes) documents an optional
`LH_DEPLOYMENT_MODE=multiuser-web` profile that will eventually authenticate
each user with Clerk and give every account its own Linux UID/GID. **It is not
usable yet.** Phase 1 of that work ships only the configuration surface and a
fail-closed startup gate; the account controller, per-account workers, and the
root helper are still missing.

What the current build does in that mode:

- It validates `LH_ACCOUNT_ROOT`, `LH_REGISTRY_DIR`, `LH_INSTANCE_STATE_DIR`,
  `LH_STAGING_DIR`, `LH_SNAPSHOT_DIR`, `LH_PRIVATE_WORK_DIR`, both IPC socket
  paths, the UID/GID window, the Clerk keys and explicit trusted-origin list,
  and every mandatory resource limit.
- It takes the unprivileged web identity from `LH_WEB_UID`/`LH_WEB_GID` (default
  `1000:1000`, matching the image's `USER node`), refuses to start when those do
  not match the identity the process actually runs as, and accounts for its
  supplementary groups when checking permissions. Those groups must not overlap
  the account GID window. Every non-account root must be root-owned with mode
  exactly `0700`; the account root must be root-owned and grant the web identity
  no access bits at all.
- It requires this container's root filesystem to be read-only, every writable
  root to be its own mount point with a distinct filesystem source (bind-mounting
  one host directory at multiple roots is refused), and no `docker.sock` or
  `docker.socket` to be mounted.
- If anything is missing it prints the reasons and exits before serving. The
  Next.js barrel refuses to open the shared stores in this mode, and the account
  relay refuses instead of serving shared records.

The Phase 1 gate still has boundaries that Phase 3's A12/A13 deployment and
real-Docker tests must close: strict bounds for host/service identities and the
legacy data path, prevention of a runtime process spoofing the build-only
`NEXT_PHASE` exception, and handling of POSIX ACLs and setuid/setgid bits. The
current injected-facts gate does not claim to close these gaps.

Do not point real users at this mode, and keep using the supported
single-profile deployment below until the later phases land. The expected
environment layout is documented in
[`.env.example`](../.env.example).

## Quick start

```bash
cp .env.example .env   # optional: uncomment provider keys
docker compose up -d --build
```

Open <http://localhost:3000>. When using a domain or reverse proxy, also set
`LH_ALLOWED_HOSTS=learn.example.com` in `.env` (replace it with your exact
domain, without `https://`) and run `docker compose up -d`.

Add provider keys either in `.env` before starting, or in **Settings →
Providers** after the app boots. Keys entered in Settings are written to
`auth.json` inside the data volume, so they survive rebuilds.

```bash
docker compose logs -f        # follow logs
docker compose ps             # health/status
docker compose down           # stop (the volume is kept)
```

## Building the image

Compose builds automatically on `up --build`. To build explicitly (or on a
machine that only builds, then ships the image elsewhere):

```bash
# Plain build (server-only, no Chromium)
docker build -t learnharness:latest .

# With the demo-builder's browser verification
docker build --build-arg WITH_CHROMIUM=1 -t learnharness:latest .

# Smaller build cache / no provenance attestation
docker build --provenance=false -t learnharness:latest .
```

The build is self-gating: it fails instead of producing a broken image if the
provider runtime, the payload curation or the boot smoke test regresses. Expect
roughly 5–10 minutes on a 2-core machine and ~2 GB of scratch disk during the
Next.js build.

Tag for a registry and push:

```bash
docker tag learnharness:latest registry.example.com/learnharness:0.6.1
docker push registry.example.com/learnharness:0.6.1
```

Then on the server, run the published image instead of building:

```bash
docker run -d --name learnharness \
  --restart unless-stopped \
  -p 3000:3000 \
  -v learnharness-data:/data \
  -e OPENROUTER_API_KEY=sk-or-... \
  registry.example.com/learnharness:0.6.1
```

To do that from Compose, replace the `build:` block in `docker-compose.yml` with
`image: registry.example.com/learnharness:0.6.1`.

## What persists

All mutable state lives under `LH_DATA_DIR=/data`, backed by the
`learnharness-data` named volume:

```
/data/chats/     session transcripts
/data/graph/     knowledge-graph ledgers
/data/jobs/      background jobs
/data/practice/  problem sets
/data/plugins/   installed plugins and their private data
/data/settings.json
/data/auth.json  provider keys (mode 0600)
```

Back up the volume with:

```bash
docker compose exec -T app tar czf - -C /data . > learnharness-data.tgz
```

Restore into a stopped container (the volume's real name can be confirmed with
`docker volume ls`):

```bash
docker compose down
docker run --rm -i -v learnharness_learnharness-data:/data \
  alpine sh -c 'tar xzf - -C /data' < learnharness-data.tgz
docker compose up -d
```

To keep the plain files visible on the host instead, replace the volume with a
bind mount:

```yaml
volumes:
  - ./data:/data
```

The entrypoint starts as root for a moment, makes `/data` writable by the
`node` user (uid 1000), then drops privileges before starting the server. This
works for both fresh named volumes and bind-mounted host directories.

## Auto-start on boot

The compose service uses `restart: unless-stopped`, so Docker starts the
container again after a crash or host reboot. This relies on the Docker daemon
being enabled at boot (`systemctl is-enabled docker`). A container removed with
`docker compose down` is not recreated automatically.

For a belt-and-braces boot path (and recovery after `compose down`), install a
small systemd unit. Adjust `WorkingDirectory` to where you cloned the repo:

```ini
[Unit]
Description=LearnHarness web app (Docker Compose)
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/learnharness
ExecStart=/usr/bin/docker compose up -d --no-build
ExecStop=/usr/bin/docker compose stop
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now learnharness.service
```

`--no-build` keeps boot from triggering a multi-minute Next.js build. Build the
image explicitly (`docker compose build`) when you update the code.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Container listen port (compose pins this). |
| `HOSTNAME` | `0.0.0.0` | Container listen address. |
| `LH_DATA_DIR` | `/data` | All chats, graph ledgers, settings, jobs. |
| `LH_AUTH_FILE` | `/data/auth.json` | BYOK key store (read/write by the server). |
| `LH_ALLOWED_HOSTS` | — | Exact domain names accepted by the browser API; comma-separated, no protocol/port/path. Required behind a reverse proxy. |
| `LH_CLERK_AUTHORIZED_PARTIES` | — | Multiuser-web only: comma-separated canonical trusted origins (`https://host[:port]`); HTTP is allowed only for localhost. Required for Clerk session verification. |
| `OPENROUTER_API_KEY` | — | Default LLM engine. |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `DEEPSEEK_API_KEY`, … | — | Other providers (see `src/core/auth-keys.ts`). |
| `TAVILY_API_KEY` / `BRAVE_API_KEY` / `FIRECRAWL_API_KEY` | — | Optional web search. |
| `DEEPGRAM_API_KEY` | — | Optional dictation. |
| `CHROME_PATH` | `/usr/bin/chromium` | Browser used for demo verification. |
| `LH_PORT` | `3000` | Host port (compose only). |
| `WITH_CHROMIUM` | `0` | Build arg: `1` adds Chromium for demo verification. |

Do not pass a key as an empty string (`KEY=`): the app treats a set-but-empty
variable as a present key. Comment it out instead.

Environment variables take precedence over values saved in `auth.json`. Saving
a key in Settings while the same variable is set in `.env` reports
`shadowedByEnv` — remove the env var (or restart without it) to use the saved
one.

## Image details

- **Base:** `node:26-bookworm-slim` (same Node major as CI).
- **Build:** `npm ci` (runtime deps + the few build tools) → `npm run
  plugins:setup` (locked deps for the core plugin projects) → `npm run build`
  (compiles plugins, then the Next.js standalone output) →
  `scripts/smoke-provider-runtime.mjs` → `scripts/build-server.mjs`. The traced
  payload is then pruned of build-only inputs (sources, tests, docs, the
  authoring project), and `scripts/smoke-server.mjs` boots exactly that pruned
  payload: it probes `/`, `/api/graph`, `/api/models`, `/api/settings`,
  `/api/plugins`, and runs the core-plugin and external-plugin smoke fixtures.
  A broken payload fails the image build instead of the deployment.
- **Runtime:** only `.next/standalone` is copied, plus CA certificates,
  minimal fonts and `gosu`. npm/npx are removed; `node server.js` is the only
  long-running process. `data/`, `auth.json`, `*.credentials.json`, `.env*` and
  `.git` are excluded from the build context and the traced payload.
- **Process:** the entrypoint fixes `/data` ownership as root, then `exec`s
  the server as the unprivileged `node` user. No long-running process is root.
- **Chromium (optional):** the default image is server-only. Build with
  `docker compose build --build-arg WITH_CHROMIUM=1` (or set
  `WITH_CHROMIUM=1` in `.env`) to enable the demo-builder's browser
  verification. Without it, demos fail with a clear "No render engine
  available" message; the rest of the app works normally.
- **Updates:** `git pull && docker compose up -d --build`. The data volume is
  untouched.

## Troubleshooting

**Build runs out of memory.** `next build` is the memory-hungry step. Build on
a machine with at least ~4 GB free (or add swap). The repo already disables the
TypeScript checker during builds.

**The page says “This page couldn’t load” and API requests return 403.** Check
the response body. `This host name is not allowed` means the domain is missing
from `LH_ALLOWED_HOSTS`. Set `LH_ALLOWED_HOSTS=learn.example.com` in `.env`
(use your real domain, without `https://`), then run `docker compose up -d`.
The API accepts localhost and IP addresses automatically, but deliberately
blocks unlisted domain names to prevent DNS rebinding.

**Container is unhealthy.** `docker compose logs app` shows the server output.
The first boot needs up to ~45 s on a slow host; the healthcheck's
`start_period` covers that.

**Permission denied writing `/data`.** The entrypoint chowns `/data` to uid
1000 at startup. If you run the image with `--user` (which skips the root
entrypoint step), make the directory writable by that user yourself.

**Demos/visual verification fail.** The default image has no browser. Rebuild
with `WITH_CHROMIUM=1`, or point `CHROME_PATH` at a Chromium/Chrome binary
mounted into the container.

**Core plugins are missing.** `npm run build` compiles them before the Next
build. If you run the build steps by hand, run `npm run plugins:setup` first
(locked dependencies) and let `npm run build` do the plugin compilation — a
bare `next build` ships no `core-plugins/` directory and `/api/plugins` fails
its own smoke test.

## Running without Compose

```bash
docker build -t learnharness .
docker run -d --name learnharness \
  -p 3000:3000 \
  -v learnharness-data:/data \
  -e OPENROUTER_API_KEY=sk-or-... \
  learnharness
```
