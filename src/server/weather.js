const { getParisParts, getUtcIsoNoMs, isValidDayKey } = require('./time');

const DEFAULT_WEATHER_URL = 'https://api.open-meteo.com/v1/forecast?latitude=45.901&longitude=6.126&hourly=temperature_2m,precipitation,weather_code&past_days=2&forecast_days=7&timezone=Europe%2FParis';
const MAX_WEATHER_BYTES = 256 * 1024;
const DEFAULT_WEATHER_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_WEATHER_TIMEOUT_MS = 4500;

const BUCKET_LABELS = Object.freeze({
  sunny: 'Ensoleillé',
  cloudy: 'Couvert',
  rain: 'Pluie',
  snow: 'Neige'
});

/**
 * Map WMO weather interpretation code + hourly precipitation (mm) to 4 coarse mobility buckets.
 */
function classifyWeatherBucket(weatherCode, precipitationMm) {
  const code = Number(weatherCode);
  const precip = Number(precipitationMm);

  if ([71, 73, 75, 77, 85, 86].includes(code)) {
    return 'snow';
  }
  if (
    (Number.isFinite(precip) && precip >= 0.4)
    || [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99].includes(code)
  ) {
    return 'rain';
  }
  if (Number.isFinite(code) && code <= 2) {
    return 'sunny';
  }
  return 'cloudy';
}

function getWeatherBucketLabel(bucket) {
  return BUCKET_LABELS[bucket] || 'Couvert';
}

function summarizeDayWeatherRows(dayKey, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }

  // Prefer daytime hours (08h..19h) for driver/lake-parking sensitivity
  const daytime = rows.filter((r) => r.hour >= 8 && r.hour <= 19);
  const sampleRows = daytime.length > 0 ? daytime : rows;

  const temps = sampleRows.map((r) => Number(r.temp_c)).filter(Number.isFinite);
  const minTemp = temps.length ? Math.round(Math.min(...temps)) : null;
  const maxTemp = temps.length ? Math.round(Math.max(...temps)) : null;
  const totalPrecipMm = Number(
    sampleRows.reduce((acc, r) => acc + (Number.isFinite(Number(r.precipitation_mm)) ? Number(r.precipitation_mm) : 0), 0).toFixed(1)
  );

  const counts = { sunny: 0, cloudy: 0, rain: 0, snow: 0 };
  for (const r of sampleRows) {
    const b = r.condition_bucket || classifyWeatherBucket(r.weather_code, r.precipitation_mm);
    if (Object.prototype.hasOwnProperty.call(counts, b)) {
      counts[b] += 1;
    }
  }

  let dominantBucket = 'cloudy';
  if (counts.snow >= 2) {
    dominantBucket = 'snow';
  } else if (counts.rain >= 3 || totalPrecipMm >= 2.0) {
    dominantBucket = 'rain';
  } else if (counts.sunny >= Math.ceil(sampleRows.length * 0.45)) {
    dominantBucket = 'sunny';
  }

  const bucketLabel = getWeatherBucketLabel(dominantBucket);
  const tempText = maxTemp !== null ? `${maxTemp} °C max` : '';
  const precipText = dominantBucket === 'rain' && totalPrecipMm > 0 ? ` (${totalPrecipMm} mm)` : '';
  const label = tempText ? `${bucketLabel} · ${tempText}${precipText}` : bucketLabel;

  return {
    dayKey,
    bucket: dominantBucket,
    bucketLabel,
    minTempC: minTemp,
    maxTempC: maxTemp,
    totalPrecipMm,
    label,
    hourly: rows
  };
}

function computeWeatherSimilarityWeight(targetSummary, candidateSummary) {
  if (!targetSummary || !candidateSummary) {
    return 1.0;
  }
  const wet = (b) => b === 'rain' || b === 'snow';
  let weight = 1.0;

  if (targetSummary.bucket === candidateSummary.bucket) {
    weight = 1.35;
  } else if (wet(targetSummary.bucket) !== wet(candidateSummary.bucket)) {
    weight = 0.65;
  }

  if (
    Number.isFinite(targetSummary.maxTempC)
    && Number.isFinite(candidateSummary.maxTempC)
    && Math.abs(targetSummary.maxTempC - candidateSummary.maxTempC) <= 6
  ) {
    weight *= 1.1;
  }

  return Number(weight.toFixed(3));
}

function createWeatherService({ config = {}, dbStore, fetcher = fetch, autoFetch = true } = {}) {
  const weatherApiUrl = config.weatherApiUrl || DEFAULT_WEATHER_URL;
  const refreshIntervalMs = config.weatherRefreshIntervalMs ?? DEFAULT_WEATHER_INTERVAL_MS;
  const fetchTimeoutMs = config.weatherFetchTimeoutMs ?? DEFAULT_WEATHER_TIMEOUT_MS;

  const summaryCache = new Map();
  let lastFetchedAt = null;
  let lastError = null;
  let inFlight = null;
  let intervalTimer = null;

  async function refresh(now = new Date()) {
    if (!autoFetch || typeof fetcher !== 'function') {
      return { updated: false, rowCount: 0, dayCount: dbStore.getWeatherDayCount() };
    }

    if (inFlight) {
      return inFlight;
    }

    inFlight = (async () => {
      try {
        const response = await fetcher(weatherApiUrl, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(fetchTimeoutMs)
        });

        if (!response.ok) {
          await response.body?.cancel?.().catch(() => {});
          throw new Error(`HTTP ${response.status}`);
        }

        const text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > MAX_WEATHER_BYTES) {
          throw new Error('Open-Meteo payload exceeded maximum allowed size');
        }

        const payload = JSON.parse(text);
        const times = payload?.hourly?.time;
        const temps = payload?.hourly?.temperature_2m || [];
        const precips = payload?.hourly?.precipitation || [];
        const codes = payload?.hourly?.weather_code || [];

        if (!Array.isArray(times) || times.length === 0) {
          throw new Error('Invalid Open-Meteo hourly payload');
        }

        const todayKey = getParisParts(now).dayKey;
        const fetchedAt = getUtcIsoNoMs(now);
        const normalizedRows = [];

        for (let i = 0; i < times.length; i += 1) {
          const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):\d{2}$/.exec(String(times[i] || ''));
          if (!match) {
            continue;
          }
          const dayKey = match[1];
          const hour = Number.parseInt(match[2], 10);
          if (!isValidDayKey(dayKey) || hour < 0 || hour > 23) {
            continue;
          }

          const rawTemp = Number(temps[i]);
          const rawPrecip = Number(precips[i]);
          const rawCode = Number(codes[i]);
          const tempC = Number.isFinite(rawTemp) ? Math.round(rawTemp * 10) / 10 : null;
          const precipitationMm = Number.isFinite(rawPrecip) ? Math.round(rawPrecip * 10) / 10 : 0;
          const weatherCode = Number.isFinite(rawCode) ? Math.round(rawCode) : 3;

          normalizedRows.push({
            dayKey,
            hour,
            tempC,
            precipitationMm,
            weatherCode,
            conditionBucket: classifyWeatherBucket(weatherCode, precipitationMm),
            isForecast: dayKey >= todayKey,
            fetchedAt
          });
        }

        const inserted = dbStore.upsertWeatherHourly(normalizedRows);
        summaryCache.clear();
        lastFetchedAt = fetchedAt;
        lastError = null;
        return { updated: true, rowCount: inserted, dayCount: dbStore.getWeatherDayCount() };
      } catch (error) {
        lastError = error.message;
        console.warn('Open-Meteo refresh failed, keeping cached DB weather:', error.message);
        return { updated: false, rowCount: 0, dayCount: dbStore.getWeatherDayCount() };
      } finally {
        inFlight = null;
      }
    })();

    return inFlight;
  }

  function getDaySummary(dayKey) {
    if (!isValidDayKey(dayKey)) {
      return null;
    }
    if (summaryCache.has(dayKey)) {
      return summaryCache.get(dayKey);
    }
    const rows = dbStore.getWeatherForDay(dayKey);
    const summary = summarizeDayWeatherRows(dayKey, rows);
    summaryCache.set(dayKey, summary);
    return summary;
  }

  function getSummariesForDays(dayKeys) {
    const out = {};
    const missing = [];
    for (const dk of dayKeys || []) {
      if (!isValidDayKey(dk)) {
        continue;
      }
      if (summaryCache.has(dk)) {
        out[dk] = summaryCache.get(dk);
      } else {
        missing.push(dk);
      }
    }

    if (missing.length > 0) {
      const rows = dbStore.getWeatherForDays(missing);
      const grouped = new Map();
      for (const row of rows) {
        if (!grouped.has(row.day_key)) {
          grouped.set(row.day_key, []);
        }
        grouped.get(row.day_key).push(row);
      }
      for (const dk of missing) {
        const summary = summarizeDayWeatherRows(dk, grouped.get(dk) || []);
        summaryCache.set(dk, summary);
        out[dk] = summary;
      }
    }

    return out;
  }

  function getCurrentWeather(now = new Date()) {
    const paris = getParisParts(now);
    const summary = getDaySummary(paris.dayKey);
    if (!summary || !Array.isArray(summary.hourly) || summary.hourly.length === 0) {
      return null;
    }
    const hourRow = summary.hourly.find((r) => r.hour === paris.hour) || summary.hourly[0];
    const bucket = hourRow.condition_bucket || summary.bucket;
    const bucketLabel = getWeatherBucketLabel(bucket);
    const tempC = Number.isFinite(Number(hourRow.temp_c)) ? Math.round(Number(hourRow.temp_c)) : null;
    const precipMm = Number.isFinite(Number(hourRow.precipitation_mm)) ? Number(hourRow.precipitation_mm) : 0;

    return {
      dayKey: paris.dayKey,
      hour: paris.hour,
      tempC,
      precipMm,
      bucket,
      bucketLabel,
      label: tempC !== null ? `${tempC} °C · ${bucketLabel}` : bucketLabel
    };
  }

  function start() {
    if (intervalTimer || !autoFetch) {
      return;
    }
    intervalTimer = setInterval(() => {
      refresh().catch(() => {});
    }, refreshIntervalMs);
    if (typeof intervalTimer.unref === 'function') {
      intervalTimer.unref();
    }
  }

  function stop() {
    if (intervalTimer) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
  }

  function getStatus() {
    return {
      enabled: true,
      source: 'open-meteo',
      lastFetchedAt,
      cachedDays: dbStore.getWeatherDayCount(),
      lastError
    };
  }

  return {
    refresh,
    getDaySummary,
    getSummariesForDays,
    getCurrentWeather,
    start,
    stop,
    getStatus
  };
}

module.exports = {
  DEFAULT_WEATHER_URL,
  classifyWeatherBucket,
  getWeatherBucketLabel,
  summarizeDayWeatherRows,
  computeWeatherSimilarityWeight,
  createWeatherService
};
