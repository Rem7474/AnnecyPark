const { PARKINGS_LIST } = require('../data/parkings');

const MAX_CSV_BYTES = 1024 * 1024;
const DEFAULT_STATIC_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DYNAMIC_TTL_MS = 45 * 1000;
const DEFAULT_REFRESH_INTERVAL_MS = 60 * 1000;
const DEFAULT_STALE_MAX_AGE_MS = 15 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 4000;

/**
 * Parse an RFC-4180 CSV payload (UTF-8 BOM tolerant, quoted commas/newlines) into header-keyed objects.
 */
function parseCsvRows(csvText) {
  if (typeof csvText !== 'string' || !csvText.trim()) {
    return [];
  }

  const input = csvText.charCodeAt(0) === 0xFEFF ? csvText.slice(1) : csvText;
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r') {
      if (input[i + 1] === '\n') {
        i += 1;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  if (rows.length < 2) {
    return [];
  }

  const headers = rows[0].map((h) => h.trim());
  const records = [];

  for (let i = 1; i < rows.length; i += 1) {
    const values = rows[i];
    if (values.length === 1 && !values[0].trim()) {
      continue;
    }
    const record = {};
    for (let j = 0; j < headers.length; j += 1) {
      const header = headers[j];
      if (!header) {
        continue;
      }
      record[header] = (values[j] || '').trim();
    }
    records.push(record);
  }

  return records;
}

/**
 * Index all unique charge points (id_pdc_itinerance) belonging to tracked Annecy parkings.
 */
function buildStationPdcIndex(staticRows) {
  const stationToMeta = new Map(
    PARKINGS_LIST
      .filter((parking) => Boolean(parking.evStationId))
      .map((parking) => [parking.evStationId, parking])
  );

  const buckets = new Map();
  for (const row of staticRows || []) {
    const stationId = (row.id_station_itinerance || '').trim();
    const pdcId = (row.id_pdc_itinerance || '').trim();
    const meta = stationToMeta.get(stationId);
    if (!meta || !pdcId) {
      continue;
    }

    let entry = buckets.get(meta.key);
    if (!entry) {
      entry = {
        parkingKey: meta.key,
        stationId,
        pdcSet: new Set(),
        maxPowerKw: 0
      };
      buckets.set(meta.key, entry);
    }

    entry.pdcSet.add(pdcId);
    const power = Number.parseFloat(String(row.puissance_nominale || '').replace(',', '.'));
    if (Number.isFinite(power) && power > entry.maxPowerKw) {
      entry.maxPowerKw = power;
    }
  }

  const byParking = {};
  for (const [parkingKey, entry] of buckets.entries()) {
    const pdcIds = Array.from(entry.pdcSet);
    if (pdcIds.length === 0) {
      continue;
    }
    byParking[parkingKey] = {
      parkingKey,
      stationId: entry.stationId,
      pdcIds,
      maxPowerKw: entry.maxPowerKw > 0 ? Math.round(entry.maxPowerKw) : 22
    };
  }

  return {
    byParking,
    trackedCount: Object.keys(byParking).length
  };
}

/**
 * Aggregate dynamic EV point statuses per tracked parking using mutually exclusive states.
 */
function aggregateNexteneoByParking(staticIndex, dynamicRows, { stale = false } = {}) {
  const dynByPdc = new Map();
  for (const row of dynamicRows || []) {
    const pdcId = (row.id_pdc_itinerance || '').trim();
    if (pdcId) {
      dynByPdc.set(pdcId, row);
    }
  }

  const byParking = {};
  const entries = Object.values(staticIndex?.byParking || {});

  for (const entry of entries) {
    let available = 0;
    let occupied = 0;
    let outOfService = 0;
    let unknown = 0;
    let latestEventAt = null;

    for (const pdcId of entry.pdcIds) {
      const dyn = dynByPdc.get(pdcId);
      if (!dyn) {
        unknown += 1;
        continue;
      }

      const eventTs = (dyn.horodatage || '').trim();
      if (eventTs && (!latestEventAt || eventTs > latestEventAt)) {
        latestEventAt = eventTs;
      }

      const etat = (dyn.etat_pdc || '').trim().toLowerCase();
      const occ = (dyn.occupation_pdc || '').trim().toLowerCase();

      // Always classify hors_service first: NEXTENEO often sends occupation_pdc='occupe' alongside hors_service.
      if (etat === 'hors_service') {
        outOfService += 1;
      } else if (etat === 'en_service' && occ === 'libre') {
        available += 1;
      } else if (etat === 'en_service' && (occ === 'occupe' || occ === 'reserve')) {
        occupied += 1;
      } else {
        unknown += 1;
      }
    }

    const total = entry.pdcIds.length;
    if (total === 0 || (available + occupied + outOfService) === 0) {
      continue;
    }

    byParking[entry.parkingKey] = {
      available,
      occupied,
      outOfService,
      unknown,
      total,
      maxPowerKw: entry.maxPowerKw,
      latestEventAt,
      provider: 'NEXTENEO',
      stationId: entry.stationId,
      stale: Boolean(stale)
    };
  }

  return byParking;
}

function markStaleByParking(byParking, stale) {
  const cloned = {};
  for (const [key, value] of Object.entries(byParking || {})) {
    if (value) {
      cloned[key] = { ...value, stale: Boolean(stale) };
    }
  }
  return cloned;
}

/**
 * Shallow-clone parkings snapshot with per-parking live EV data without mutating collector caches.
 */
function attachEvLiveToParkings(parkingsMap, evByParking) {
  const enriched = {};
  for (const [key, dto] of Object.entries(parkingsMap || {})) {
    enriched[key] = dto
      ? { ...dto, evLive: evByParking?.[key] || null }
      : dto;
  }
  return enriched;
}

function createEvCollector({ config = {}, fetcher = fetch, nowFn = () => Date.now() } = {}) {
  const staticUrl = config.evStaticUrl || 'https://horizon.nexteneo.com/public/datagouv/irve/statique';
  const dynamicUrl = config.evDynamicUrl || 'https://horizon.nexteneo.com/public/datagouv/irve/dynamique';
  const staticCacheTtlMs = config.evStaticCacheTtlMs ?? DEFAULT_STATIC_TTL_MS;
  const dynamicCacheTtlMs = config.evDynamicCacheTtlMs ?? DEFAULT_DYNAMIC_TTL_MS;
  const refreshIntervalMs = config.evRefreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
  const staleMaxAgeMs = config.evStaleMaxAgeMs ?? DEFAULT_STALE_MAX_AGE_MS;
  const fetchTimeoutMs = config.evFetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;

  let stationIndex = null;
  let lastStaticSuccessMs = 0;
  let inFlightStatic = null;

  let latestByParking = null;
  let lastDynamicSuccessMs = 0;
  let lastSuccessIso = null;
  let lastRefreshStale = true;
  let inFlightDynamic = null;
  let refreshTimer = null;

  async function fetchCsvText(url) {
    const response = await fetcher(url, {
      headers: { Accept: 'text/csv, text/plain;q=0.9, */*;q=0.1' },
      signal: AbortSignal.timeout(fetchTimeoutMs)
    });

    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      throw new Error(`HTTP ${response.status}`);
    }

    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_CSV_BYTES) {
      throw new Error('EV CSV payload exceeded maximum allowed size');
    }

    return text;
  }

  async function ensureStationIndex({ force = false } = {}) {
    const nowMs = nowFn();
    if (!force && stationIndex && (nowMs - lastStaticSuccessMs) < staticCacheTtlMs) {
      return stationIndex;
    }

    if (!inFlightStatic) {
      inFlightStatic = (async () => {
        try {
          const csvText = await fetchCsvText(staticUrl);
          const rows = parseCsvRows(csvText);
          const parsedIndex = buildStationPdcIndex(rows);
          if (parsedIndex.trackedCount > 0) {
            stationIndex = parsedIndex;
            lastStaticSuccessMs = nowFn();
          }
        } catch (error) {
          console.warn('NEXTENEO static IRVE fetch failed:', error.message);
        }
        return stationIndex;
      })().finally(() => {
        inFlightStatic = null;
      });
    }

    return inFlightStatic;
  }

  function buildExpiredOrFallbackSnapshot() {
    const ageMs = nowFn() - lastDynamicSuccessMs;
    if (latestByParking && ageMs <= staleMaxAgeMs) {
      return {
        byParking: markStaleByParking(latestByParking, true),
        fetchedAt: lastSuccessIso,
        stale: true
      };
    }
    return {
      byParking: {},
      fetchedAt: null,
      stale: true
    };
  }

  async function collectDynamicNow() {
    try {
      const index = await ensureStationIndex();
      if (!index || index.trackedCount === 0) {
        lastRefreshStale = true;
        return buildExpiredOrFallbackSnapshot();
      }

      const csvText = await fetchCsvText(dynamicUrl);
      const dynRows = parseCsvRows(csvText);
      const aggregated = aggregateNexteneoByParking(index, dynRows, { stale: false });
      if (Object.keys(aggregated).length === 0) {
        lastRefreshStale = true;
        return buildExpiredOrFallbackSnapshot();
      }

      const nowMs = nowFn();
      latestByParking = aggregated;
      lastDynamicSuccessMs = nowMs;
      lastSuccessIso = new Date(nowMs).toISOString();
      lastRefreshStale = false;

      return {
        byParking: markStaleByParking(latestByParking, false),
        fetchedAt: lastSuccessIso,
        stale: false
      };
    } catch (error) {
      console.warn('NEXTENEO dynamic IRVE fetch failed:', error.message);
      lastRefreshStale = true;
      return buildExpiredOrFallbackSnapshot();
    }
  }

  async function getSnapshot({ force = false } = {}) {
    const ageMs = nowFn() - lastDynamicSuccessMs;
    if (!force && latestByParking && ageMs < dynamicCacheTtlMs) {
      return {
        byParking: markStaleByParking(latestByParking, false),
        fetchedAt: lastSuccessIso,
        stale: false
      };
    }

    if (!inFlightDynamic) {
      inFlightDynamic = collectDynamicNow().finally(() => {
        inFlightDynamic = null;
      });
    }

    return inFlightDynamic;
  }

  function getCachedSnapshot() {
    if (!latestByParking) {
      return {
        byParking: {},
        fetchedAt: null,
        stale: true
      };
    }

    const ageMs = nowFn() - lastDynamicSuccessMs;
    if (ageMs > staleMaxAgeMs) {
      return {
        byParking: {},
        fetchedAt: null,
        stale: true
      };
    }

    const isStale = lastRefreshStale || ageMs >= dynamicCacheTtlMs;
    return {
      byParking: markStaleByParking(latestByParking, isStale),
      fetchedAt: lastSuccessIso,
      stale: isStale
    };
  }

  function start() {
    if (refreshTimer) {
      return;
    }
    getSnapshot({ force: true }).catch(() => {});
    refreshTimer = setInterval(() => {
      getSnapshot({ force: true }).catch(() => {});
    }, refreshIntervalMs);
    if (typeof refreshTimer.unref === 'function') {
      refreshTimer.unref();
    }
  }

  function stop() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  function getStatus() {
    const cached = getCachedSnapshot();
    return {
      enabled: true,
      trackedParkings: PARKINGS_LIST.filter((p) => Boolean(p.evStationId)).map((p) => p.key),
      lastSuccessAt: lastSuccessIso,
      stale: cached.stale
    };
  }

  return {
    getSnapshot,
    getCachedSnapshot,
    start,
    stop,
    getStatus
  };
}

module.exports = {
  parseCsvRows,
  buildStationPdcIndex,
  aggregateNexteneoByParking,
  attachEvLiveToParkings,
  createEvCollector
};
