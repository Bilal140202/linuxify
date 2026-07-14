# Self-Hosting Guide

> **Audience**: DevOps engineers, enterprise architects, and power users who want to run the Linuxify registry and/or sync server on their own infrastructure. Also useful for AI coding agents setting up air-gapped Linuxify deployments.
>
> **Scope**: This guide covers self-hosting the v2 Linuxify registry (the HTTP API that replaces the v1 git-based registry) and the v2 sync server (the optional cloud-sync backend). For the v1 git-based registry (which is trivially "self-hosted" by forking the git repo), see [registry-format.md](../09-registry/registry-format.md). For the v2 cloud-sync architecture, see [cloud-sync.md](../19-future/cloud-sync.md). For the v2 registry API spec, see [package-registry-future.md](../19-future/package-registry-future.md).

## 1. Why Self-Host?

The default Linuxify experience talks to public infrastructure: the v1 git registry at `github.com/linuxify/registry`, the v2 HTTP API at `registry.linuxify.sh`, and (if you opt in) the cloud-sync server at `sync.linuxify.sh`. For the vast majority of users, this is the right choice — public infrastructure is free, maintained, geographically distributed, and signed by the Linuxify maintainers. But there are legitimate reasons to self-host, and the v2 design supports them as first-class use cases rather than afterthoughts.

**Air-gapped environments** are the most common reason. Some organisations — defence contractors, financial institutions, healthcare, critical-infrastructure operators — prohibit devices from reaching public internet services. A developer in such an environment cannot run `linuxify add cline` if it requires reaching `registry.linuxify.sh` to fetch the package YAML. A self-hosted registry inside the corporate network, periodically synced from the public registry, gives these developers the same Linuxify experience as everyone else.

**Enterprise security policies** are the second reason. Some security teams prohibit reliance on external SaaS for any tool that touches source code, on the theory that the SaaS provider could be compromised and serve malicious updates. A self-hosted registry whose signing keys the enterprise controls, whose access logs the enterprise can audit, and whose network traffic never leaves the corporate boundary satisfies these policies. The cost is the operational burden of running the registry, which this guide walks through.

**Custom internal packages** are the third reason. A company that builds internal CLIs (a proprietary code generator, an internal linter, a custom AI agent wired to internal models) wants to distribute them via `linuxify add <internal-tool>` without publishing to the public registry. A self-hosted registry can host both public packages (synced from upstream) and private packages (published by internal teams), giving developers a single `linuxify add` for both.

**Cost control** is the fourth reason, mostly relevant for the sync server. The paid tiers of cloud sync ($3/month personal, $8/user/month team) are reasonable for individuals and small teams but add up at enterprise scale. Self-hosting the sync server eliminates the per-user fee at the cost of ops burden. The BSL license (see §13) permits this for free up to a usage threshold.

**Data sovereignty** is the fifth reason. Some jurisdictions (EU under GDPR, Russia under data-localisation laws, China under PIPL) require that personal data of their residents stays within the jurisdiction. A self-hosted sync server inside the jurisdiction satisfies this requirement; the public `sync.linuxify.sh` (hosted in the US and EU) does not, for users in jurisdictions outside those regions.

## 2. Self-Hosting the Registry (v2)

The v2 registry is an HTTP API server implemented in TypeScript on Node.js, distributed as a Docker image. The same image runs the public `registry.linuxify.sh` and any self-hosted instance, so feature parity is guaranteed — a self-hosted registry is not a "lite" version.

### 2.1 Quick start

The fastest way to get a registry running is Docker:

```bash
docker run -d \
  --name linuxify-registry \
  -p 8080:80 \
  -v ./data:/data \
  -v ./config:/config \
  -e REGISTRY_SIGNING_KEY=/config/registry-private.pem \
  -e REGISTRY_PUBLIC_KEY_URL=https://internal-ca.example/registry.pub \
  ghcr.io/linuxify/registry-server:latest
```

This starts the registry on port 8080, persists data to `./data/`, and reads the signing key from `./config/registry-private.pem`. The registry is now reachable at `http://localhost:8080/v1/` (the API version prefix). Health check at `/health`, metrics at `/metrics`.

### 2.2 Configuration

The registry reads configuration from (in priority order): command-line flags, environment variables, and `/config/config.toml`. Most deployments use a `config.toml` for everything except secrets (which come from env vars or a secrets manager). The schema is the same shape as the [client config schema](../02-architecture/system-architecture.md#5-state-and-storage), so the same validation runs.

```toml
# /config/config.toml
[server]
listen = "0.0.0.0:80"
workers = 4                  # one per CPU core is a reasonable default

[storage]
backend = "filesystem"       # or "s3"
path = "/data/packages"      # for filesystem backend
# For S3 backend:
# backend = "s3"
# bucket = "my-registry"
# region = "us-east-1"
# endpoint = "https://s3.us-east-1.amazonaws.com"  # optional, for S3-compatible

[database]
backend = "sqlite"           # or "postgres"
path = "/data/registry.db"   # for sqlite
# For postgres:
# backend = "postgres"
# url = "postgres://user:pass@db.internal:5432/linuxify"

[signing]
key_path = "/config/registry-private.pem"
key_id = "my-company-2025-q1"
algorithm = "ed25519"

[audit]
enabled = true
path = "/data/audit.log"
rotate_at = "100MB"
keep = 30
```

### 2.3 Storage backends

The **filesystem backend** is the default and is sufficient for small deployments (under ~1,000 packages, under ~10 GB total). Package YAMLs are stored as flat files in `/data/packages/<name>/<version>.yml`. Signatures are stored alongside as `<version>.yml.sig`. This is the same layout as the v1 git registry, so migrating from v1 to a self-hosted v2 is a `git clone` of the registry repo into `/data/packages/`.

The **S3 backend** is recommended for larger deployments or for deployments that need horizontal scaling (multiple registry containers sharing storage). Any S3-compatible backend works: AWS S3, Cloudflare R2, MinIO, Backblaze B2, Wasabi. The registry uses content-addressed storage (key = SHA-256 of the YAML) to enable deduplication within a single registry instance.

### 2.4 Database backends

**SQLite** is the default and is sufficient for small deployments. The database stores metadata (package index, version history, search index, stats, audit log). A single SQLite file at `/data/registry.db` handles up to ~100 concurrent clients comfortably.

**PostgreSQL** is recommended for deployments with more than ~50 concurrent clients or for horizontal scaling (multiple registry containers behind a load balancer). The schema is identical to SQLite; the registry auto-migrates on first start. Postgres 14+ is required.

### 2.5 Reverse proxy and TLS

The registry listens on plain HTTP (port 80 inside the container). For production, put it behind nginx or Caddy with TLS:

```nginx
server {
    listen 443 ssl http2;
    server_name registry.my-company.com;

    ssl_certificate     /etc/ssl/registry.my-company.com.crt;
    ssl_certificate_key /etc/ssl/registry.my-company.com.key;

    location / {
        proxy_pass http://localhost:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Caddy is even simpler (auto-TLS via Let's Encrypt):

```caddyfile
registry.my-company.com {
    reverse_proxy localhost:8080
}
```

### 2.6 Initial setup

After the registry is running, the initial setup is:

1. **Create an admin user.** The first user is created via CLI: `docker exec linuxify-registry linuxify-registry admin create --email admin@my-company.com`. This prints a one-time setup URL; opening it in a browser lets the admin set a password and enable 2FA.
2. **Generate (or import) signing keys.** The registry needs an Ed25519 keypair to sign package YAMLs. Generate one with `docker exec linuxify-registry linuxify-registry keys generate --id my-company-2025-q1`. The private key is written to `/config/registry-private.pem`; the public key is printed (publish it wherever your clients will fetch it from — typically an internal CA or a static file on the registry itself at `/.well-known/linuxify-keys.json`).
3. **Import packages from the public registry** (see §5).
4. **Configure clients** to point at the self-hosted registry (see §4).

## 3. Self-Hosting the Sync Server (v2)

The sync server is the optional cloud-sync backend that lets users carry their Linuxify state across devices. The public instance is at `sync.linuxify.sh`; self-hosting replaces it with an internal instance. The sync server is **end-to-end encrypted** by design — it stores encrypted blobs it cannot read, never holds decryption keys, and never performs any operation on user data except store-and-forward. A self-hosted sync server inherits this property: even if the server is compromised, the attacker gets ciphertext only.

### 3.1 Quick start

```bash
docker run -d \
  --name linuxify-sync \
  -p 8081:80 \
  -v ./sync-data:/data \
  -v ./sync-keys:/keys \
  -e SYNC_ENCRYPTION_KEY=/keys/sync-master.pem \
  -e SYNC_DATABASE_URL=postgres://user:pass@db.internal:5432/linuxify_sync \
  -e SYNC_S3_BUCKET=my-sync-blobs \
  -e SYNC_EMAIL_PROVIDER=smtp \
  -e SYNC_SMTP_HOST=smtp.my-company.com \
  ghcr.io/linuxify/sync-server:latest
```

This starts the sync server on port 8081, persists Postgres metadata to `./sync-data/`, reads the encryption key from `./sync-keys/`, and uses S3 for blob storage. Email is sent via SMTP for account verification.

### 3.2 Configuration

Sync server configuration is similar to the registry — env vars plus `config.toml`. The critical pieces are:

- **Storage backend for encrypted blobs**: S3-compatible (Cloudflare R2 in production, but MinIO or AWS S3 work). Blobs are stored under the key `<user_id>/<blob_sha256>` and are content-addressed for dedup within a single user's account.
- **Database**: Postgres only (the sync server does not support SQLite — it needs transactions and concurrent writes that SQLite handles poorly under load). Postgres 14+.
- **Email provider**: SMTP (any provider), or a transactional email service (SendGrid, Postmark, AWS SES) via their API. Used for account verification, password reset, and device-revocation notifications.
- **Encryption keys**: the sync server has a *master* key used to protect user passphrase-derived keys at rest. The master key is the single most sensitive secret in the deployment — lose it and all encrypted blobs are unrecoverable; leak it and all encrypted blobs are decryptable. Store it in a hardware security module (HSM) or a secrets manager (Vault, AWS KMS, GCP KMS); do not store it on disk in plaintext.

### 3.3 Backup

Backup strategy for the sync server:

- **Postgres**: daily `pg_dump` to S3, retained 30 days. Test restore quarterly (see §9).
- **S3 bucket**: enable bucket versioning (so accidental deletes are recoverable) and a lifecycle policy that transitions old versions to Glacier after 90 days. Cross-region replication to a second bucket is recommended for disaster recovery.
- **Encryption keys**: back up the master key to a separate, encrypted, offline medium (e.g., a USB drive in a safe). The master key is the one piece of infrastructure you cannot recover from anything else — if both the live key and the backup are lost, all user data is unrecoverable. This is by design (zero-knowledge sync), but it means key backup is a first-priority ops task.

## 4. Client Configuration

Once the self-hosted registry and/or sync server is running, point clients at it:

```bash
# Registry
linuxify config registry.url https://registry.my-company.com
linuxify config registry.public_key_path /etc/linuxify/registry.pub
# Or, if the registry serves its public key at a well-known URL:
linuxify config registry.public_key_url https://registry.my-company.com/.well-known/linuxify-keys.json

# Sync (optional)
linuxify config sync.url https://sync.my-company.com
linuxify config sync.trust_self_signed false   # true if using internal CA

# If using an internal CA the Linuxify CLI does not trust by default:
linuxify config registry.trust_self_signed true
linuxify config sync.trust_self_signed true
# Better: add the CA to the system trust store and leave these false.
```

After configuring, verify connectivity:

```bash
linuxify registry ping     # should print "registry: ok, version: v1, signing_key: my-company-2025-q1"
linuxify sync ping         # should print "sync: ok, version: v1"
linuxify doctor            # should show ✔ Registry and ✔ Sync lines
```

## 5. Syncing from the Public Registry

A self-hosted registry is useless without packages. The `linuxify registry sync-from-public` command pulls packages from the public `registry.linuxify.sh` into the self-hosted registry:

```bash
linuxify registry sync-from-public
# Pulls all packages from the public registry into the self-hosted one.
# Signs each with the self-hosted registry's signing key (the public registry's
# signature is preserved as a "verified upstream signature" field).
```

For selective sync (e.g., only the packages your organisation actually uses):

```bash
linuxify registry sync-from-public \
    --include "cline,codex,aider,goose,gemini-cli,openhands,freebuff" \
    --include "internal-*" \    # wildcards supported
    --exclude "experimental-*"
```

Schedule this as a cron job (or Kubernetes `CronJob`) to keep the self-hosted registry up to date. A reasonable cadence is hourly: the public registry publishes at most a few times per day, and hourly sync catches new packages within an hour of upstream publication. The sync is incremental (only changed packages are transferred), so hourly sync is cheap.

## 6. Publishing to the Self-Hosted Registry

Internal packages can be published to the self-hosted registry via the CLI:

```bash
linuxify package publish --registry self-hosted \
    --yaml ./my-internal-tool.yml \
    --visibility private \
    --team frontend-platform
```

Publishing requires an API token issued by an admin (see §7). The `--visibility private` flag restricts access to the named team; `--visibility public` makes the package visible to all authenticated users of the registry. Private packages are encrypted at rest with a team-specific key, so even a registry admin cannot read a private package's YAML without the team's key (zero-knowledge within the registry itself).

The published package's YAML is validated against the [package schema](../09-registry/package-spec.md) before being accepted. Schema-invalid YAMLs are rejected with `E_PACKAGE_SCHEMA_INVALID`. The YAML must also declare a `compat.min_linuxify` version; the registry refuses to publish packages requiring a Linuxify version newer than the latest stable release (to prevent users from being forced to upgrade).

## 7. Authentication

The self-hosted registry and sync server support several authentication mechanisms.

**Self-hosted registry**: API tokens (admin-issued via `linuxify-registry admin token create --email user@my-company.com --scope read`), optional OAuth via GitHub Enterprise or GitLab self-hosted, and SAML SSO for enterprises that require it. Tokens are scoped (`read` for clients, `write` for publishers, `admin` for management). Tokens are revocable; revocation takes effect within 60 seconds (the registry caches tokens for 60s).

**Self-hosted sync server**: user accounts (email + password), 2FA (TOTP, optional WebAuthn), and optional SSO via SAML or OIDC. Each user can have multiple devices, each with its own device token. Device tokens are revocable from any other logged-in device (`linuxify sync devices revoke <id>`); revocation is immediate.

For both, the recommended production setup is SSO via your existing identity provider (Okta, Auth0, Azure AD, etc.) so that joining or leaving the company automatically grants or revokes Linuxify access.

## 8. Monitoring

Both servers expose Prometheus metrics at `/metrics` and a health check at `/health`.

Key metrics to alert on:

- **`linuxify_registry_requests_total{status,endpoint}`** — request rate, error rate. Alert on 5xx rate >1% for 5 minutes.
- **`linuxify_registry_request_duration_seconds`** (histogram) — p50/p90/p99 latency per endpoint. Alert on p99 >1s for the package-fetch endpoint.
- **`linuxify_registry_signing_operations_total`** — rate of package signing. Sudden spikes indicate a publish storm or a compromised token.
- **`linuxify_sync_uploads_total`, `linuxify_sync_downloads_total`** — sync activity. Sudden drop to zero indicates a client-side or network issue.
- **`linuxify_sync_encrypted_blob_bytes`** — total encrypted storage used. Alert at 80% of quota.
- **`linuxify_sync_device_revocations_total`** — rate of device revocations. Spikes may indicate a security incident.

A Grafana dashboard template is provided in the Linuxify repo at `ops/grafana/linuxify-self-hosted.json`. Import it, point it at your Prometheus, and you get a pre-built dashboard with panels for request rate, latency, error rate, storage usage, signing operations, and sync activity. Customise alerts per your team's runbook conventions.

Structured JSON logs go to stdout (per the [twelve-factor app](https://12factor.net/logs) convention). Ship them to your existing log aggregator (ELK, Loki, Datadog, Splunk). The log format is documented in [system-architecture §6](../02-architecture/system-architecture.md#6-logging); every log line has a `level`, `msg`, `ts`, `req_id` (for request-scoped logs), and `user_id` (for authenticated requests, hashed for privacy).

Server-side operational metrics follow the same privacy principles as the CLI's opt-in telemetry ([telemetry-privacy](../24-telemetry/telemetry-privacy.md)): no PII in metrics labels, no per-user tracking, only aggregate counts and histograms. The `user_id` in logs is a salted hash, not the raw identifier, so logs cannot be joined back to user records without the salt (which rotates weekly and is held only in the sync server's secret store). Self-hosters inheriting this design get a registry/sync deployment that collects operational telemetry (request rate, latency, error budget) without ever collecting user-identifying telemetry — a property worth preserving when you customise the deployment, so resist the temptation to add raw `user_id` or `email` labels to Prometheus metrics even when an internal stakeholder asks for "per-user dashboards". Per-user analytics belong in the audit log (which is access-controlled), not in the metrics stream (which is typically broader-readable).

## 9. Backup & Recovery

**Registry backup**:

- Back up the `data/` directory (for filesystem backend) or the S3 bucket (for S3 backend) nightly. Retain 30 days.
- Back up the Postgres database (if used) nightly via `pg_dump`. Retain 30 days.
- Back up the signing key (the private key) to offline storage. This is the one secret you cannot recover from anything else; if lost, all packages signed by that key become unverifiable from the client side, and you must rotate the key and re-sign every package.
- **Restore procedure**: stop the registry container, restore `data/` (or S3 bucket) and Postgres dump, restart the container. Verify with `linuxify registry ping` and a `linuxify doctor` from a test client.

**Sync server backup**:

- Back up Postgres nightly. Retain 30 days.
- S3 bucket versioning (so accidental deletes are recoverable) + cross-region replication (for disaster recovery).
- **CRITICAL**: back up the master encryption key to offline storage. Without the master key, all encrypted blobs in S3 are useless ciphertext. If both the live key and the backup are lost, all sync data is unrecoverable. This is by design (zero-knowledge sync), but it makes key backup the single most important ops task for the sync server.
- **Restore procedure**: stop the sync container, restore Postgres and (if needed) S3, restore the master key, restart the container. Verify with `linuxify sync ping` and a test login from a client.

**Test restore quarterly.** An untested backup is not a backup; it is a hope. The quarterly drill: restore the registry to a test container, verify a known package is fetchable, restore the sync server to a test container, verify a test account can log in and sync. Document any issues and update the runbook.

## 10. Upgrading

Both servers support in-place upgrades with automatic migrations:

```bash
docker pull ghcr.io/linuxify/registry-server:latest
docker stop linuxify-registry
docker rm linuxify-registry
docker run -d ... ghcr.io/linuxify/registry-server:latest
# On first start, the new version runs any pending migrations automatically.
# Verify with: docker logs linuxify-registry | grep "migrations complete"
```

The migration framework is the same one used by the client (see [release-pipeline §6](../14-cicd/release-pipeline.md#6-migrations)): each version can register a `migrate()` function that runs on first start of the new version. Migrations are restricted to operating on the registry's own data directory and database; they cannot touch the network or other parts of the filesystem.

**Rollback**: if a migration cannot be reversed (some migrations are one-way, e.g., a schema change that drops a deprecated column), rollback requires restoring from backup. The migration's `migrate()` function declares whether it is reversible; if not, the upgrade is "destructive" and the release notes call this out. Always take a backup before upgrading a destructive migration.

The recommended upgrade cadence is to track the stable channel (the same channel client `pkg install linuxify` uses). Beta-channel server releases are fine for test deployments but should not run in production.

## 11. Scaling

**Registry horizontal scaling**: the registry is stateless except for the database. To scale, run multiple registry containers behind a load balancer, all pointing at the same Postgres database and the same S3 bucket (or shared filesystem). The container's local filesystem is only used for caching; losing a container does not lose data. Add a CDN (Cloudflare, CloudFront, Fastly) in front for package downloads — the package YAMLs are static and cacheable, and the CDN absorbs read load.

**Sync server horizontal scaling**: similar — multiple sync containers behind a load balancer, all pointing at the same Postgres and S3. The sync server is mostly stateless I/O (encryption and decryption happen client-side; the server just stores and forwards blobs), so it scales well horizontally. No CDN in front of sync (blobs are encrypted and per-user; caching them at a CDN would leak metadata about which users share content).

**Database scaling**: for the registry, Postgres on a single instance handles thousands of concurrent clients. For the sync server at large scale (10k+ users), consider Postgres with read replicas (writes go to primary, reads go to replicas) or sharding by `user_id` modulo N.

## 12. Security Hardening

For production deployments:

- **TLS everywhere.** No plain HTTP. Terminate TLS at the reverse proxy (nginx/Caddy) or at the container (the registry supports a `server.tls_cert` and `server.tls_key` config). Use an internal CA or Let's Encrypt.
- **Firewall to internal network only.** The registry and sync server should not be reachable from the public internet unless you specifically want them to be (e.g., for remote workers). Use a VPN (WireGuard, Tailscale) or an IP allowlist at the firewall.
- **Rate limiting at the reverse proxy.** nginx's `limit_req` module or Caddy's `rate_limit` directive. Default: 100 requests/minute per IP for unauthenticated, 1000/minute for authenticated (matches the public registry's rate limits).
- **Audit log enabled.** Every registry publish, every sync login, every device revocation, every admin action is logged to the audit log. The audit log is append-only (chmod +a where supported, otherwise just disciplined ops). Retain 1 year minimum for compliance.
- **Regular security updates of Docker images.** The Linuxify project publishes security-patched images within 24 hours of an upstream vulnerability (per [security-model §12](../13-security/security-model.md#12-vulnerability-reporting)). Subscribe to the `linuxify-announce` mailing list for security advisories.
- **Signing key rotation.** Rotate the registry's signing key quarterly. The 30-day overlap window (both old and new keys sign new packages) ensures clients can verify without interruption. Document the rotation in the audit log.
- **Sync server master key rotation.** Rotate the sync master key annually. This is a complex operation (requires re-encrypting every user's passphrase-derived key under the new master); the sync server has a `linuxify-sync keys rotate` command that does this online with zero downtime. Test in staging first.

## 13. License

Self-hosting the Linuxify registry and sync server is governed by the **Business Source License (BSL)**. The BSL permits non-production use freely (development, testing, personal projects) and permits production use for free up to a threshold:

- **Registry**: free for up to 100 packages and up to 50 users. Above that, a commercial license is required.
- **Sync server**: free for up to 50 users. Above that, a commercial license is required.

**Always free** for: OSS projects (any licence approved by the OSI), personal use, educational use, and contributors to Linuxify itself (anyone with a merged PR gets a perpetual commercial licence as a thank-you). The BSL converts to MIT after 4 years (the "change date"), so even if Linuxify the project disappears, your self-hosted infrastructure remains usable under a permissive licence. This is the same model Sentry, CockroachDB, and Hashicorp use.

For commercial licensing enquiries, contact `enterprise@linuxify.dev`. Pricing is per-user per-year, with volume discounts. The revenue funds the OSS project (maintainer time, infrastructure, security audits).

## 14. Community Support

Self-hosting Linuxify is a community-supported activity. The maintainers run the public infrastructure and do not provide SLA-backed support for self-hosted deployments unless you have a commercial licence.

- **Discord `#self-hosting` channel** — community Q&A. Many self-hosters hang out here and help each other.
- **GitHub Discussions** — tag your post `self-hosting` for visibility.
- **GitHub Issues** — for bugs in the server software (not for "how do I configure nginx" type questions). Reproducible test cases required.
- **Paid support** — for enterprises with a commercial licence. Email `enterprise@linuxify.dev` for a support contract. Response-time SLAs available.
- **Office hours** — monthly, on the community Discord. A maintainer is available for self-hosting questions for 1 hour. Announced in `#announcements`.

If you self-host and would like to be listed on the public "known self-hosted instances" page (optional, helps the community see adoption), email `maintainers@linuxify.dev` with your instance URL, region, and approximate user count.
