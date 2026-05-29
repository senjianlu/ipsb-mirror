export interface Env {
  DB: D1Database;
  /** Cache TTL in days. Defaults to 30. */
  CACHE_TTL_DAYS: string;
}

interface GeoRecord {
  ip: string;
  country_code: string | null;
  country: string | null;
  continent_code: string | null;
  latitude: number | null;
  longitude: number | null;
  asn: string | null;
  organization: string | null;
  timezone: string | null;
  raw_response: string | null;
  created_at: number;
  updated_at: number;
}

type IPSBRaw = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isIPv4(ip: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip);
}

/**
 * Reads the client IP from Cloudflare-injected headers, in priority order:
 *   1. CF-Connecting-IP  — standard CF header, always a single IP
 *   2. True-Client-IP    — CF Enterprise plan; same semantics as above
 *   3. X-Forwarded-For   — comma-separated chain; first entry is the client IP
 *   4. X-Real-IP         — not CF-native; present in local dev / other proxies
 *
 * "Prefer IPv4" is implicit: if the client connected via IPv4, CF-Connecting-IP
 * will be IPv4. There is no way to obtain an IPv4 address when the client
 * connected via IPv6 — we use whatever version the header carries.
 */
function getClientIP(request: Request): { ip: string; version: 4 | 6 } | null {
  for (const header of ['CF-Connecting-IP', 'True-Client-IP', 'X-Real-IP']) {
    const val = request.headers.get(header)?.trim();
    if (val) return { ip: val, version: isIPv4(val) ? 4 : 6 };
  }

  // X-Forwarded-For may contain a chain like "client, proxy1, proxy2"
  const xff = request.headers.get('X-Forwarded-For');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return { ip: first, version: isIPv4(first) ? 4 : 6 };
  }

  return null;
}

function jsonBody(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function parseCacheTTL(raw: string | undefined): number {
  const n = parseInt(raw ?? '30', 10);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const cacheTTLDays = parseCacheTTL(env.CACHE_TTL_DAYS);
    const cacheTTLMs = cacheTTLDays * 86_400_000;
    const now = Date.now();

    const client = getClientIP(request);
    if (!client) {
      return jsonBody({
        error: 'Unable to determine client IP address',
        _meta: { source: 'error', hint: 'CF-Connecting-IP header not present' },
      }, 400);
    }

    // -----------------------------------------------------------------------
    // 1. Check D1 cache
    // -----------------------------------------------------------------------
    const cached = await env.DB
      .prepare('SELECT * FROM ip_cache WHERE ip = ?')
      .bind(client.ip)
      .first<GeoRecord>();

    if (cached && now - cached.updated_at < cacheTTLMs) {
      return jsonBody({
        ip: cached.ip,
        country_code: cached.country_code,
        country: cached.country,
        continent_code: cached.continent_code,
        latitude: cached.latitude,
        longitude: cached.longitude,
        asn: cached.asn,
        organization: cached.organization,
        timezone: cached.timezone,
        _meta: {
          source: 'cache',
          ip_version: client.version,
          created_at: new Date(cached.created_at).toISOString(),
          updated_at: new Date(cached.updated_at).toISOString(),
          cache_ttl_days: cacheTTLDays,
          ipsb_raw: cached.raw_response ? JSON.parse(cached.raw_response) as unknown : null,
        },
      });
    }

    // -----------------------------------------------------------------------
    // 2. Fetch from ip.sb
    // -----------------------------------------------------------------------
    let ipsb: IPSBRaw | null = null;
    let ipsbStatus: number | null = null;
    let ipsbError: string | null = null;

    try {
      const res = await fetch(`https://api.ip.sb/geoip/${client.ip}`, {
        headers: { 'User-Agent': 'ipsb-mirror/1.0' },
        signal: AbortSignal.timeout(10_000),
      });
      ipsbStatus = res.status;
      const text = await res.text();
      try {
        ipsb = JSON.parse(text) as IPSBRaw;
      } catch {
        ipsbError = `Non-JSON response: ${text.slice(0, 256)}`;
      }
    } catch (err) {
      ipsbError = err instanceof Error ? err.message : String(err);
    }

    // -----------------------------------------------------------------------
    // 3. On success — upsert into D1 and return fresh data
    // -----------------------------------------------------------------------
    if (ipsb !== null && ipsbStatus !== null && ipsbStatus >= 200 && ipsbStatus < 300) {
      const geo = {
        ip:             typeof ipsb['ip']             === 'string' ? ipsb['ip']             : client.ip,
        country_code:   typeof ipsb['country_code']   === 'string' ? ipsb['country_code']   : null,
        country:        typeof ipsb['country']        === 'string' ? ipsb['country']        : null,
        continent_code: typeof ipsb['continent_code'] === 'string' ? ipsb['continent_code'] : null,
        latitude:       typeof ipsb['latitude']       === 'number' ? ipsb['latitude']       : null,
        longitude:      typeof ipsb['longitude']      === 'number' ? ipsb['longitude']      : null,
        asn:            ipsb['asn'] != null            ? String(ipsb['asn'])                : null,
        organization:   typeof ipsb['organization']   === 'string' ? ipsb['organization']   : null,
        timezone:       typeof ipsb['timezone']       === 'string' ? ipsb['timezone']       : null,
      };

      // Preserve original created_at on re-fetch; use now for new records
      const createdAt = cached?.created_at ?? now;

      ctx.waitUntil(
        env.DB.prepare(`
          INSERT INTO ip_cache
            (ip, country_code, country, continent_code, latitude, longitude,
             asn, organization, timezone, raw_response, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(ip) DO UPDATE SET
            country_code   = excluded.country_code,
            country        = excluded.country,
            continent_code = excluded.continent_code,
            latitude       = excluded.latitude,
            longitude      = excluded.longitude,
            asn            = excluded.asn,
            organization   = excluded.organization,
            timezone       = excluded.timezone,
            raw_response   = excluded.raw_response,
            updated_at     = excluded.updated_at
        `).bind(
          geo.ip, geo.country_code, geo.country, geo.continent_code,
          geo.latitude, geo.longitude, geo.asn, geo.organization,
          geo.timezone, JSON.stringify(ipsb),
          createdAt, now,
        ).run()
      );

      return jsonBody({
        ...geo,
        _meta: {
          source: 'api',
          ip_version: client.version,
          fetched_at: new Date(now).toISOString(),
          cache_ttl_days: cacheTTLDays,
          ipsb_status: ipsbStatus,
          ipsb_raw: ipsb,
        },
      });
    }

    // -----------------------------------------------------------------------
    // 4. API failed — serve stale cache if available, otherwise 502
    // -----------------------------------------------------------------------
    if (cached) {
      return jsonBody({
        ip: cached.ip,
        country_code: cached.country_code,
        country: cached.country,
        continent_code: cached.continent_code,
        latitude: cached.latitude,
        longitude: cached.longitude,
        asn: cached.asn,
        organization: cached.organization,
        timezone: cached.timezone,
        _meta: {
          source: 'cache_stale',
          ip_version: client.version,
          created_at: new Date(cached.created_at).toISOString(),
          updated_at: new Date(cached.updated_at).toISOString(),
          cache_ttl_days: cacheTTLDays,
          ipsb_raw: cached.raw_response ? JSON.parse(cached.raw_response) as unknown : null,
          ipsb_refresh_status: ipsbStatus,
          ipsb_refresh_error: ipsbError,
        },
      }, 206);
    }

    return jsonBody({
      error: 'Failed to retrieve geolocation data',
      ip: client.ip,
      _meta: {
        source: 'error',
        ip_version: client.version,
        ipsb_status: ipsbStatus,
        ipsb_error: ipsbError,
        ipsb_raw: ipsb,
      },
    }, 502);
  },
};
