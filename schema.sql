CREATE TABLE IF NOT EXISTS ip_cache (
    ip               TEXT    PRIMARY KEY,
    country_code     TEXT,
    country          TEXT,
    continent_code   TEXT,
    isp              TEXT,
    organization     TEXT,
    asn              INTEGER,
    asn_organization TEXT,
    latitude         REAL,
    longitude        REAL,
    timezone         TEXT,
    offset           INTEGER,
    raw_response     TEXT,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ip_cache_updated_at ON ip_cache (updated_at);
