# Obligate

**Central single sign-on, two-factor authentication and access management for the Obli suite.**

Obligate is the identity hub of the Obli tools. Users sign in and set up two-factor authentication once; administrators decide in one place who can open which app, with which role, in which tenant. Each connected app keeps its own local accounts and delegates sign-in to Obligate.

Website: [gate.obli.tools](https://gate.obli.tools)

## Key features

- **Single sign-on for the suite**: an authorization-code flow with single-use, short-lived codes and redirect URIs checked against each app's registered address. Supported by Obliance, Obliview, Oblimap, Obliguard, Oblihub, Obliwan, ObliDesk, Obliplan and Oblifield.
- **Two-factor authentication everywhere**: TOTP with QR setup, an option to enforce 2FA for everyone, admin reset, replay protection and brute-force throttling.
- **Permission groups**: per-app, per-tenant roles and fine-grained capabilities published by each app. Without a mapping, a user gets no access. Groups can have delegated managers.
- **Access changes propagate**: deactivation, reactivation, deletion and role changes are pushed to the connected apps, with a retry queue.
- **Connected-apps registry**: per-app API keys (shown once, regenerable), optional per-app secrets for calls from Obligate, and an app switcher.
- **Shared preferences**: theme, language, notification settings, profile photo and anonymous mode follow the user across apps.
- **Dashboard**: a "My Apps" view with live statistics from each app.
- **App-to-app delegation**: short-lived signed tokens (Ed25519, published through JWKS) so apps can call each other on behalf of a user.
- **Session security**: sessions re-checked against the account on every request and dropped when credentials change.

## Quick install

```sh
curl -fsSL https://raw.githubusercontent.com/obli-tools/Obligate/main/install.sh | sh
```

The installer runs on Linux, or on macOS with Docker Desktop. It:

- checks Docker and Docker Compose; on Linux it offers to install them with Docker's official script, only after you confirm;
- downloads `docker-compose.yml` and `.env.example` into `./obligate`;
- creates `.env` with unique random secrets (`DB_PASSWORD`, `SESSION_SECRET`, `ENCRYPTION_KEY`, initial admin password);
- pulls the images, starts the stack and prints the panel URL and the initial admin password (shown only once).

Running it again upgrades an existing install; `.env` is never modified.

Options (pass them after `sh -s --`):

| Option | Description |
|--------|-------------|
| `-y`, `--yes` | Non-interactive: accept the defaults and install Docker if it is missing |
| `--dir PATH` | Install directory (default `./obligate`) |
| `--port PORT` | Host port of the web interface (default `3020`, first install only) |
| `--url URL` | Public URL of Obligate, e.g. `https://obligate.example.com` (first install only) |

```sh
curl -fsSL https://raw.githubusercontent.com/obli-tools/Obligate/main/install.sh | sh -s -- -y --dir /opt/obligate --url https://obligate.example.com
```

`--help` lists every option.

## Manual install (Docker Compose)

```sh
mkdir obligate && cd obligate
curl -fsSLO https://raw.githubusercontent.com/obli-tools/Obligate/main/docker-compose.yml
curl -fsSLO https://raw.githubusercontent.com/obli-tools/Obligate/main/.env.example
cp .env.example .env
# Edit .env: set DB_PASSWORD, SESSION_SECRET (a long random string), ENCRYPTION_KEY
# (64 hex characters, e.g. openssl rand -hex 32), DEFAULT_ADMIN_PASSWORD
# and CLIENT_ORIGIN (the public URL of Obligate).
docker compose up -d
```

The web interface answers on port `3020` (`LISTEN_PORT`). The stack runs PostgreSQL 16, the server (`meejay/obligate-server`) and the web client (`meejay/obligate-client`). To use an existing PostgreSQL server instead, see `docker-compose.external-db.yml`.

`ENCRYPTION_KEY` seals the delegation signing key and the per-app secrets: back it up with the database.

## Update

```sh
docker compose pull && docker compose up -d
```

Or run the installer again from the same directory.

## Connecting an app

1. In Obligate, add the app under connected apps (type, name and the app's public URL) and copy the generated API key.
2. In the app's settings, enter the Obligate URL and the API key, then enable SSO.
3. In Obligate, map permission groups to the app's roles for each tenant.

## Requirements

- A Linux host (or macOS with Docker Desktop) with Docker Engine and Docker Compose v2.
- The Obli apps reach Obligate at `CLIENT_ORIGIN`. Behind a TLS reverse proxy (recommended), set it to the public `https://` address, then run `docker compose up -d` again.
- Each app's registered URL must match the address users actually open.

## Part of the Obli suite

| Tool | Purpose |
|------|---------|
| [Obliance](https://ance.obli.tools) | Remote monitoring and management (RMM) |
| [Oblireach](https://reach.obli.tools) | Remote screen access and remote support |
| [Obliview](https://view.obli.tools) | Uptime and infrastructure monitoring |
| [Oblimap](https://map.obli.tools) | IPAM and network discovery |
| [Obliguard](https://guard.obli.tools) | Agent-based intrusion prevention |
| **[Obligate](https://gate.obli.tools)** | Single sign-on and access management for the suite |
| [Oblihub](https://hub.obli.tools) | Docker control panel |
| [Obliwan](https://github.com/obli-tools/Obliwan) | WAN router fleet management |
| [ObliDesk](https://github.com/obli-tools/ObliDesk) | Ticketing and service desk |
| [Obliplan](https://github.com/obli-tools/Obliplan) | Workforce scheduling and working-time tracking |
| [Oblifield](https://field.obli.tools) | Field intervention management |

Suite home: [obli.tools](https://obli.tools)

## License

Obligate is source-available under the [Elastic License 2.0](LICENSE) (ELv2). You may use, modify and self-host it, including for commercial use inside your organization; you may not provide it to others as a hosted or managed service. See [LICENSE](LICENSE) for the full terms and the obli.tools clarifications.
