# Self-hosting TierGate with Docker

This guide shows how to run TierGate on a VPS (Oracle Cloud, Hetzner, DigitalOcean, any Linux server) or on your own computer. Everything runs in Docker: one container for TierGate and one for PostgreSQL.

- [1. What you need](#1-what-you-need)
- [2. Install Docker](#2-install-docker)
- [3. Install TierGate](#3-install-tiergate)
- [4. Create the admin account](#4-create-the-admin-account)
- [5. Connect a provider and an agent](#5-connect-a-provider-and-an-agent)
- [6. Put it on a domain with HTTPS (VPS)](#6-put-it-on-a-domain-with-https-vps)
- [7. Upgrade](#upgrade)
- [8. Move from Manifest to TierGate](#8-move-from-manifest-to-tiergate)
- [9. Back up and restore](#9-back-up-and-restore)
- [10. Build the image yourself](#10-build-the-image-yourself)
- [11. Troubleshooting](#11-troubleshooting)

## 1. What you need

| | Minimum |
| --- | --- |
| CPU | 1 vCPU (amd64 or arm64, so Oracle Ampere works) |
| Memory | 1 GB free for TierGate, plus about 256 MB for PostgreSQL |
| Disk | 5 GB free. Request logs grow over time |
| Software | Docker Engine 20.10+ with the Compose plugin, `curl`, `openssl` |
| Network | Outbound HTTPS to your LLM providers. For a VPS with a domain: ports 80 and 443 open |

On your own computer, Docker Desktop (macOS or Windows) or Docker Engine (Linux) is enough.

## 2. Install Docker

**macOS or Windows:** install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and start it.

**Linux (Ubuntu or Debian VPS):**

```bash
curl -fsSL https://get.docker.com | sudo sh
```

```bash
sudo usermod -aG docker $USER
```

Log out and back in, then check that it works:

```bash
docker run --rm hello-world
```

```bash
docker compose version
```

## 3. Install TierGate

### Option A: the installer (recommended)

The installer downloads `docker-compose.yml`, writes a `.env` file with random secrets, and starts the stack. Read it first if you like:

```bash
curl -sSLO https://raw.githubusercontent.com/faisalahammad/tiergate/main/docker/install.sh
```

```bash
bash install.sh --dry-run
```

Then run it:

```bash
bash install.sh
```

Useful flags:

| Flag | What it does |
| --- | --- |
| `--dir /opt/tiergate` | Install somewhere other than `~/manifest` |
| `--port 8080` | Serve the dashboard on another port (default `2099`) |
| `--yes` | Skip the confirmation prompt |
| `--upgrade` | Replace only the compose file on an existing install, keep `.env` |

The default folder is `~/manifest`, so the installer can find and upgrade older TierGate installs. The name of the folder does not matter.

### Option B: by hand with Docker Compose

1. Make a folder and download the compose file:

   ```bash
   mkdir -p ~/tiergate && cd ~/tiergate
   ```

   ```bash
   curl -sSLf https://raw.githubusercontent.com/faisalahammad/tiergate/main/docker/docker-compose.yml -o docker-compose.yml
   ```

2. Create `.env` with two random secrets:

   ```bash
   printf 'BETTER_AUTH_SECRET=%s\nMANIFEST_ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env
   ```

   `BETTER_AUTH_SECRET` signs login sessions. `MANIFEST_ENCRYPTION_KEY` encrypts the provider API keys you store. Keep a copy of `.env` somewhere safe: if you lose it, the stored provider keys can not be decrypted.

3. Start it:

   ```bash
   docker compose up -d
   ```

4. Wait until both containers are `healthy` (the first boot takes up to 90 seconds because it runs database migrations):

   ```bash
   docker compose ps
   ```

> The environment variables still use the `MANIFEST_` prefix. TierGate keeps them on purpose, so existing installs keep working.

## 4. Create the admin account

Open the dashboard:

- On your own computer: [http://localhost:2099](http://localhost:2099)
- On a VPS without a domain yet, use an SSH tunnel from your computer, then open [http://localhost:2099](http://localhost:2099):

  ```bash
  ssh -L 2099:127.0.0.1:2099 user@your-server-ip
  ```

The first visit opens the setup page. The account you create there is the admin. The password needs at least 8 characters.

The dashboard only listens on `127.0.0.1` by default, so nobody on the internet can reach it until you set up step 6.

## 5. Connect a provider and an agent

1. Go to **Providers** and connect at least one provider: an API key (OpenAI, Anthropic, OpenRouter...), a subscription, or a local server such as Ollama.
2. Go to **Harnesses** and create one for your agent (OpenClaw, Claude Code, OpenCode, n8n, your own app...). Copy its key. It starts with `mnfst_`.
3. Point your agent at TierGate as an OpenAI-compatible provider:

   | Setting | Value |
   | --- | --- |
   | Base URL | `http://localhost:2099/v1` (or `https://your-domain/v1` after step 6) |
   | API key | the `mnfst_...` key |
   | Model | `auto` |

4. Test it from a terminal:

   ```bash
   curl http://localhost:2099/v1/chat/completions -H "Authorization: Bearer mnfst_YOUR_KEY" -H "Content-Type: application/json" -d '{"model":"auto","messages":[{"role":"user","content":"Say hi"}]}'
   ```

5. Open the harness, go to **Routing**, and turn on **Route by complexity**. Pick models for the Simple, Standard, Complex and Reasoning tiers. The **Task-specific** tab lets you give coding, web browsing and other task types their own models.

**Local models (Ollama, LM Studio):** run the server on the host, make it listen on `0.0.0.0`, and use `http://host.docker.internal:<port>/v1` as its URL in TierGate. For Ollama the default is already `http://host.docker.internal:11434`.

## 6. Put it on a domain with HTTPS (VPS)

Skip this on your own computer.

1. **DNS:** create an `A` record, for example `ai.example.com`, pointing to the server IP.

2. **Open ports 80 and 443.**

   On Oracle Cloud you must do this in two places:
   - In the console: *Networking > Virtual Cloud Networks > your VCN > Security Lists > Add Ingress Rules*, source `0.0.0.0/0`, TCP ports `80` and `443`.
   - On the server, because Oracle images block them in iptables:

     ```bash
     sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
     ```

     ```bash
     sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
     ```

     ```bash
     sudo netfilter-persistent save
     ```

   On Ubuntu with `ufw`:

   ```bash
   sudo ufw allow 80,443/tcp
   ```

3. **Install Caddy** (it gets and renews the HTTPS certificate for you):

   ```bash
   sudo apt install -y caddy
   ```

   If `apt` can not find the package, follow the [official Caddy install steps](https://caddyserver.com/docs/install#debian-ubuntu-raspbian).

4. **Tell Caddy to forward the domain to TierGate.** Replace the content of `/etc/caddy/Caddyfile` with:

   ```
   ai.example.com {
       reverse_proxy 127.0.0.1:2099
   }
   ```

   ```bash
   sudo systemctl reload caddy
   ```

5. **Tell TierGate its public URL.** Add this line to the `.env` file of your install:

   ```env
   BETTER_AUTH_URL=https://ai.example.com
   ```

   Then restart:

   ```bash
   docker compose up -d
   ```

6. Open `https://ai.example.com` and sign in. Your agents now use `https://ai.example.com/v1` as the base URL.

Keep the dashboard port bound to `127.0.0.1` (the default). Caddy is the only thing that should face the internet.

<a id="upgrade"></a>

## 7. Upgrade

Database migrations run by themselves when the new version starts.

1. Back up first (see [step 9](#9-back-up-and-restore)).
2. From the install folder:

   ```bash
   docker compose pull
   ```

   ```bash
   docker compose up -d
   ```

To get the latest compose file too, run the installer with `--upgrade`. It backs up the old compose file and keeps `.env`:

```bash
bash <(curl -sSL https://raw.githubusercontent.com/faisalahammad/tiergate/main/docker/install.sh) --upgrade
```

To pin a version instead of `latest`, add it to `.env`, then pull and start again:

```env
MANIFEST_VERSION=6.29.4
```

## 8. Move from Manifest to TierGate

TierGate uses the same database, the same `.env` variables and the same Compose project name (`mnfst`) as Manifest. Your users, harnesses, keys, provider connections and request history carry over.

1. Go to the folder of your Manifest install (usually `~/manifest`).
2. Back up the database and `.env`:

   ```bash
   docker compose exec -T postgres pg_dump -U manifest manifest | gzip > manifest-backup-$(date +%F).sql.gz
   ```

   ```bash
   cp .env .env.backup
   ```

3. Replace the compose file with the TierGate one. Your `.env` stays as it is:

   ```bash
   bash <(curl -sSL https://raw.githubusercontent.com/faisalahammad/tiergate/main/docker/install.sh) --upgrade --dir "$PWD"
   ```

4. Check the image line now says `ghcr.io/faisalahammad/tiergate`:

   ```bash
   grep image: docker-compose.yml
   ```

5. Watch the first boot:

   ```bash
   docker compose logs -f manifest
   ```

Keep the same `.env`. A new `BETTER_AUTH_SECRET` or `MANIFEST_ENCRYPTION_KEY` makes the stored provider keys unreadable. Do not install TierGate in a second folder next to Manifest on the same server: both use the Compose project name `mnfst` and would fight over the same containers.

## 9. Back up and restore

All data lives in the PostgreSQL volume. Request recordings live in the `recordings` volume.

**Back up** (run from the install folder):

```bash
docker compose exec -T postgres pg_dump -U manifest manifest | gzip > tiergate-$(date +%F).sql.gz
```

Also keep a copy of `.env`. Without it, the backup can not decrypt the stored provider keys.

To run it every night at 3:00, add this line with `crontab -e` (change the folder):

```
0 3 * * * cd /home/ubuntu/manifest && docker compose exec -T postgres pg_dump -U manifest manifest | gzip > backups/tiergate-$(date +\%F).sql.gz
```

Create the `backups` folder first with `mkdir -p backups`.

**Restore** into a fresh install that uses the same `.env`:

1. Stop TierGate, keep PostgreSQL running:

   ```bash
   docker compose stop manifest
   ```

2. Empty the database and load the backup:

   ```bash
   docker compose exec -T postgres psql -U manifest -d postgres -c "DROP DATABASE manifest;" -c "CREATE DATABASE manifest OWNER manifest;"
   ```

   ```bash
   gunzip -c tiergate-2026-11-26.sql.gz | docker compose exec -T postgres psql -U manifest manifest
   ```

3. Start TierGate again:

   ```bash
   docker compose start manifest
   ```

The `DROP DATABASE` step deletes everything in the current database. Only run it when you mean to replace it with the backup.

## 10. Build the image yourself

Use this to run your own changes, or before the first image is published.

```bash
git clone https://github.com/faisalahammad/tiergate.git && cd tiergate
```

```bash
docker build -f docker/Dockerfile -t ghcr.io/faisalahammad/tiergate:local .
```

Then, in the `.env` of your install, set:

```env
MANIFEST_VERSION=local
```

```bash
docker compose up -d
```

Compose uses the local image because the tag matches.

## 11. Troubleshooting

| Problem | What to check |
| --- | --- |
| `BETTER_AUTH_SECRET must be set in .env` | `.env` is missing or empty. See [Option B, step 2](#option-b-by-hand-with-docker-compose). |
| Container stays `unhealthy` | `docker compose logs manifest`. The first boot can take 90 seconds. |
| Page does not load on the VPS | The dashboard listens on `127.0.0.1`. Use the SSH tunnel or set up Caddy (step 6). |
| Login works on the IP but not on the domain | `BETTER_AUTH_URL` in `.env` must be the exact public URL, with `https://`. |
| Caddy has no certificate | DNS must point to the server, and ports 80 and 443 must be open (on Oracle, in the Security List and iptables). |
| Ollama is not found | Ollama must listen on `0.0.0.0`, not only `127.0.0.1`. Try `OLLAMA_HOST=0.0.0.0 ollama serve`. |
| `denied` when pulling the image | The image is not public yet, or no release exists. Build it yourself (step 10). |
| Provider keys stopped working after a reinstall | `.env` changed. Restore the old `.env` and restart. |

<a id="telemetry"></a>

## 12. Telemetry and Autofix

Both are off. TierGate sends nothing to anyone unless you turn it on.

**Telemetry** sends daily usage counts (no prompts, keys or emails) to a collector you run. Set both lines in `.env`:

```env
MANIFEST_TELEMETRY_DISABLED=0
TELEMETRY_ENDPOINT=https://collector.example.com/v1/report
```

A CLI built from this repository works the same way with `MANIFEST_CLI_TELEMETRY_ENDPOINT`. The `mnfst-gateway-cli` package on npm is published by Manifest, the upstream project, and sends usage telemetry to Manifest unless you set `MANIFEST_TELEMETRY_DISABLED=1`. Pass `--url` to point it at your server.

**Autofix** repairs a failing request and retries it once. The repair runs on Manifest's healing service (`autofix.manifest.build`), so failing request bodies leave your server. Provider credentials are never sent. To turn it on:

```env
AUTOFIX_GLOBAL_ENABLED=true
```

Then enable it per harness under **Settings**.

<a id="mcp-server"></a>

## 13. MCP server

TierGate serves a remote MCP server at `/api/v1/mcp`, for example `https://ai.example.com/api/v1/mcp`. Add that URL to your MCP client and sign in when it asks. It needs an HTTPS `BETTER_AUTH_URL` (plain HTTP works only on `localhost`). Set `MCP_ENABLED=false` to turn it off.
