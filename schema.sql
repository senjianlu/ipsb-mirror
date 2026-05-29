CREATE TABLE IF NOT EXISTS ip_cache (
    ip             TEXT    PRIMARY KEY,
    country_code   TEXT,
    country        TEXT,
    continent_code TEXT,
    latitude       REAL,
    longitude      REAL,
    asn            TEXT,
    organization   TEXT,
    timezone       TEXT,
    raw_response   TEXT,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ip_cache_updated_at ON ip_cache (updated_at);
