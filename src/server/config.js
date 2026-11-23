const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const ROOT_DIR = path.resolve(__dirname, '..', '..');

function normalizeBaseUrl(rawUrl) {
  const fallback = 'https://park.remcorp.fr';
  const candidate = (rawUrl || fallback).trim().replace(/\/+$/, '');
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return fallback;
    }
    return parsed.origin;
  } catch {
    return fallback;
  }
}

function parseAllowedOrigins(rawOrigins, publicBaseUrl, nodeEnv) {
  const defaults = [publicBaseUrl];
  if (nodeEnv !== 'production') {
    defaults.push('http://localhost:3000', 'http://127.0.0.1:3000');
  }

  if (!rawOrigins) {
    return Array.from(new Set(defaults));
  }

  const parsed = rawOrigins
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  return Array.from(new Set([...defaults, ...parsed]));
}

function getConfig(overrides = {}) {
  const nodeEnv = overrides.nodeEnv || process.env.NODE_ENV || 'development';
  const port = Number.parseInt(overrides.port ?? process.env.PORT ?? '3000', 10) || 3000;
  const sqlitePath = overrides.sqlitePath
    || process.env.SQLITE_PATH
    || path.join(ROOT_DIR, 'data', 'parking_history.db');
  const holidayCachePath = overrides.holidayCachePath
    || process.env.HOLIDAY_CACHE_PATH
    || path.join(path.dirname(sqlitePath), 'holidays_zone_a_cache.json');
  const publicBaseUrl = normalizeBaseUrl(overrides.publicBaseUrl ?? process.env.PUBLIC_BASE_URL);
  const allowedOrigins = parseAllowedOrigins(
    overrides.allowedOrigins ?? process.env.ALLOWED_ORIGINS,
    publicBaseUrl,
    nodeEnv
  );

  return {
    rootDir: ROOT_DIR,
    nodeEnv,
    isProduction: nodeEnv === 'production',
    port,
    sqlitePath,
    holidayCachePath,
    publicBaseUrl,
    allowedOrigins,
    adminToken: overrides.adminToken ?? process.env.ADMIN_TOKEN ?? '',
    sampleIntervalMs: 60 * 1000,
    liveCacheTtlMs: 10 * 1000,
    fetchTimeoutMs: 3500,
    evStaticUrl: overrides.evStaticUrl ?? process.env.EV_STATIC_URL ?? 'https://horizon.nexteneo.com/public/datagouv/irve/statique',
    evDynamicUrl: overrides.evDynamicUrl ?? process.env.EV_DYNAMIC_URL ?? 'https://horizon.nexteneo.com/public/datagouv/irve/dynamique',
    evStaticCacheTtlMs: overrides.evStaticCacheTtlMs ?? (24 * 60 * 60 * 1000),
    evDynamicCacheTtlMs: overrides.evDynamicCacheTtlMs ?? (45 * 1000),
    evRefreshIntervalMs: overrides.evRefreshIntervalMs ?? (60 * 1000),
    evStaleMaxAgeMs: overrides.evStaleMaxAgeMs ?? (15 * 60 * 1000),
    evFetchTimeoutMs: overrides.evFetchTimeoutMs ?? 4000,
    weatherApiUrl: overrides.weatherApiUrl ?? process.env.WEATHER_API_URL ?? 'https://api.open-meteo.com/v1/forecast?latitude=45.901&longitude=6.126&hourly=temperature_2m,precipitation,weather_code&past_days=2&forecast_days=7&timezone=Europe%2FParis',
    weatherRefreshIntervalMs: overrides.weatherRefreshIntervalMs ?? (60 * 60 * 1000),
    weatherFetchTimeoutMs: overrides.weatherFetchTimeoutMs ?? 4500,
    retentionRawDays: 90,
    occupiedWarningThreshold: 10,
    suspiciousZeroDropThresholdPoints: 20,
    suspiciousZeroDropMaxWindowMs: 5 * 60 * 1000,
    tangentWindowMinutes: 15,
    tangentMinPoints: 3,
    tangentMinSlopePerMinute: -0.05,
    tangentMaxEtaMinutes: 180
  };
}

module.exports = {
  ROOT_DIR,
  normalizeBaseUrl,
  getConfig
};
