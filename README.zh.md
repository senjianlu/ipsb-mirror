# ipsb-mirror

基于 Cloudflare Workers 的 [ip.sb](https://ip.sb) GeoIP 镜像服务，使用 D1 数据库缓存查询结果。

[English Documentation](README.md)

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/senjianlu/ipsb-mirror)

> **首次部署需要按顺序完成以下手动步骤：**
>
> 1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com) → **D1** → **Create database**，数据库名填 `ipsb-mirror`，创建后复制 **Database ID**
> 2. 进入该数据库的 **Console** 标签页，将 [`schema.sql`](schema.sql) 的内容粘贴进去，点击 **Execute** 初始化表结构
> 3. 在你 fork 的仓库中，修改 `wrangler.toml` — 将 `your-database-id-here` 替换为刚复制的 ID，commit 并 push，自动触发重新部署

---

### 概述

`ipsb-mirror` 通过读取 Cloudflare 注入的请求头获取访客真实 IP，并向 `api.ip.sb` 查询该 IP 的地理位置数据。查询结果会缓存到 Cloudflare D1（SQLite）数据库，以减少对上游 API 的调用、降低响应延迟。每条响应都包含 `_meta` 字段，携带上游的原始返回内容，便于调试。

### 功能特性

- 从 `CF-Connecting-IP` 读取客户端 IP，优先 IPv4，其次 IPv6
- 基于 Cloudflare D1 的缓存，TTL 可通过环境变量配置（默认 30 天）
- 使用 upsert 写入，并发请求不会产生主键冲突
- 上游 API 不可用时，降级返回过期缓存而非直接报错
- 无论数据来源如何，响应中始终携带 `_meta.ipsb_raw`（ip.sb 的原始响应）

### 架构说明

```
客户端
  │  GET /
  ▼
Cloudflare Worker (src/index.ts)
  │
  ├─► D1 ip_cache 表 ────── 命中且未过期 ──► 200 { source: "cache" }
  │
  ├─► api.ip.sb/geoip/{ip} ─ 成功 ─────────► 200 { source: "api" }
  │         （通过 ctx.waitUntil 异步 upsert 到 D1）
  │
  ├─► api.ip.sb 失败 + 过期缓存 ───────────► 206 { source: "cache_stale" }
  │
  └─► api.ip.sb 失败 + 无缓存 ─────────────► 502 { source: "error" }
```

### 前置条件

- [Node.js](https://nodejs.org) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)（已作为 dev dependency 包含）
- 已开通 Workers 和 D1 的 Cloudflare 账号

### 部署流程

```bash
# 1. 安装依赖
npm install

# 2. 登录 Cloudflare
npx wrangler login

# 3. 创建 D1 数据库，记录返回的 database_id
npm run db:create

# 4. 将 database_id 填入 wrangler.toml
#    [[d1_databases]]
#    database_id = "粘贴到这里"

# 5. 初始化生产数据库表结构
npm run db:init

# 6. 部署 Worker
npm run deploy
```

### 本地开发

```bash
# 复制示例环境变量文件
cp .dev.vars.example .dev.vars

# 初始化本地 D1 数据库
npm run db:init:local

# 启动本地开发服务器（http://localhost:8787）
npm run dev
```

> **提示：** 本地开发环境中 Cloudflare 注入的头（`CF-Connecting-IP`、`True-Client-IP`）不存在，Worker 会依次回退到 `X-Real-IP`、`X-Forwarded-For`。可用 `curl` 模拟：
> ```bash
> curl -H "X-Real-IP: 1.1.1.1" http://localhost:8787
> ```

### 配置说明

所有配置项在 `wrangler.toml` 的 `[vars]` 块中声明，均为明文，可以提交到版本控制。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CACHE_TTL_DAYS` | `30` | 缓存有效天数。超过此时间的记录将在下次请求时重新向 ip.sb 拉取 |

如需按环境覆盖，可在 `wrangler.toml` 中添加 `[env.production.vars]` 块；敏感值请使用 `wrangler secret put`。

### API 响应格式

**`GET /`** — 返回当前访问者 IP 的地理位置数据。

#### 成功响应（200 — 来自缓存）

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

#### `_meta.source` 取值说明

| 值 | HTTP 状态码 | 含义 |
|---|---|---|
| `cache` | 200 | 数据来自 D1，且在 TTL 有效期内 |
| `api` | 200 | 从 ip.sb 实时获取，已写入 D1 |
| `cache_stale` | 206 | ip.sb 不可达，返回已过期的缓存数据 |
| `error` | 400 / 502 | 无法识别 IP（400）或无缓存且 ip.sb 失败（502） |
