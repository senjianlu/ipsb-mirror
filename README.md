# ipsb-mirror

A Cloudflare Worker that mirrors the [ip.sb](https://ip.sb) GeoIP API with a D1-backed cache.

[中文文档](README.zh.md)

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/senjianlu/ipsb-mirror)

> **After clicking Deploy:** Cloudflare will prompt you to create or select a D1 database. Once deployed, initialize the schema using **one** of the following methods:
>
> **Option A — Cloudflare Dashboard (no local setup required)**
> 1. Open [Cloudflare Dashboard](https://dash.cloudflare.com) → **D1** → select your `ipsb-mirror` database
> 2. Go to the **Console** tab, paste the contents of [`schema.sql`](schema.sql), and click **Execute**
>
> **Option B — Wrangler CLI (requires local clone)**
> ```bash
> git clone https://github.com/senjianlu/ipsb-mirror && cd ipsb-mirror
> npm install
> npx wrangler login
> wrangler d1 execute ipsb-mirror --file=schema.sql
> ```

---

### Overview

`ipsb-mirror` identifies the caller's IP address from Cloudflare's injected request headers and returns geolocation data sourced from `api.ip.sb`. Results are cached in a Cloudflare D1 (SQLite) database to reduce upstream API calls and improve response latency. Every response includes a `_meta` block carrying the raw upstream payload for transparency and debugging.

### Features

- Detects client IP from `CF-Connecting-IP` (IPv4 preferred, IPv6 fallback)
- D1-backed cache with a configurable TTL (default: 30 days)
- Upsert-safe writes — no duplicate-key errors under concurrent requests
- Serves stale cache on upstream failure rather than returning a hard error
- Always returns the raw ip.sb response in `_meta.ipsb_raw` regardless of data source

### Architecture

```
Client
  │  GET /
  ▼
Cloudflare Worker (src/index.ts)
  │
  ├─► D1 ip_cache table ──── hit & fresh ──► 200 { source: "cache" }
  │
  ├─► api.ip.sb/geoip/{ip} ─ success ──────► 200 { source: "api" }
  │         (upsert result into D1 via ctx.waitUntil)
  │
  ├─► api.ip.sb failure + stale cache ─────► 206 { source: "cache_stale" }
  │
  └─► api.ip.sb failure + no cache ────────► 502 { source: "error" }
```

### Prerequisites

- [Node.js](https://nodejs.org) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (installed as a dev dependency)
- A Cloudflare account with Workers and D1 enabled

### Deployment

```bash
# 1. Install dependencies
npm install

# 2. Authenticate with Cloudflare
npx wrangler login

# 3. Create the D1 database and note the returned database_id
npm run db:create

# 4. Paste the database_id into wrangler.toml
#    [[d1_databases]]
#    database_id = "paste-here"

# 5. Apply the database schema to production
npm run db:init

# 6. Deploy the Worker
npm run deploy
```

### Local Development

```bash
# Copy the example env file
cp .dev.vars.example .dev.vars

# Initialize the local D1 database
npm run db:init:local

# Start the local dev server (http://localhost:8787)
npm run dev
```

> **Note:** Cloudflare headers (`CF-Connecting-IP`, `True-Client-IP`) are not present in local dev. The Worker falls back to `X-Real-IP` and then `X-Forwarded-For`. Use `curl` to simulate a real IP:
> ```bash
> curl -H "X-Real-IP: 1.1.1.1" http://localhost:8787
> ```

### Configuration

All configuration lives in `wrangler.toml` under `[vars]`. These are plaintext and safe to commit.

| Variable | Default | Description |
|---|---|---|
| `CACHE_TTL_DAYS` | `30` | Number of days before a cached entry is considered stale and refreshed from ip.sb |

To override per environment, add a `[env.production.vars]` block or use `wrangler secret put` for sensitive values.

### API Response

**`GET /`** — Returns geolocation data for the requesting client's IP.

#### Success (200 — from cache)

```json
{
  "ip": "185.255.55.55",
  "country_code": "NL",
  "country": "Netherlands",
  "continent_code": "EU",
  "latitude": 52.3824,
  "longitude": 4.8995,
  "asn": "3214",
  "organization": "xTom GmbH",
  "timezone": "Europe/Amsterdam",
  "_meta": {
    "source": "cache",
    "ip_version": 4,
    "created_at": "2025-01-01T00:00:00.000Z",
    "updated_at": "2025-01-15T12:00:00.000Z",
    "cache_ttl_days": 30,
    "ipsb_raw": { "...": "..." }
  }
}
```

#### `_meta.source` values

| Value | HTTP | Meaning |
|---|---|---|
| `cache` | 200 | Data served from D1, within TTL |
| `api` | 200 | Fresh data fetched from ip.sb, written to D1 |
| `cache_stale` | 206 | ip.sb unreachable; returning expired cache entry |
| `error` | 400 / 502 | No IP detected (400) or no cache and ip.sb failed (502) |
