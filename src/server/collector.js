const { PARKINGS_LIST, computeParkingStatus } = require('../data/parkings');
const { getParisParts, getUtcIsoNoMs } = require('./time');

const MAX_RESPONSE_BYTES = 65536;

function buildParkingAvailabilityUrl(apiId) {
  return `https://annecy-mobilites.latitude-cartagene.com/api/interface/grandannecy/realtime/instantSystemParkings/${encodeURIComponent(`instantsystem-parking:${apiId}`)}`;
}

function buildErrorParkingDto(meta, previousData, parisTimeLabel) {
  if (previousData && previousData.status !== 'error') {
    return {
      ...previousData,
      stale: true,
      staleReason: 'Source Annecy Mobilités temporairement indisponible'
    };
  }

  return {
    key: meta.key,
    slug: meta.slug,
    name: meta.name,
    shortName: meta.shortName,
    available: 0,
    occupied: 0,
    maxCapacity: meta.maxCapacity,
    percentage: 0,
    occupiedPrm: null,
    status: 'error',
    statusText: 'Indisponible',
    lastUpdate: parisTimeLabel,
    stale: true,
    error: 'Données temporairement indisponibles',
    zone: meta.zone,
    zoneKey: meta.zoneKey,
    lat: meta.lat,
    lng: meta.lng,
    maxHeightMeters: meta.maxHeightMeters,
    pmrSpots: meta.pmrSpots,
    evChargers: meta.evChargers,
    address: meta.address,
    navigation: meta.navigation
  };
}

function createCollector({ config, dbStore, fetcher = fetch }) {
  let latestSnapshotCache = null;
  let latestMeta = {
    timestamp: null,
    parisTime: '--:--:--',
    stale: true
  };
  let lastFetchMs = 0;
  let inFlightPromise = null;
  let collectorInterval = null;

  async function fetchJsonSafe(url) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetcher(url, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(config.fetchTimeoutMs)
        });

        if (!response.ok) {
          await response.body?.cancel?.().catch(() => {});
          const err = new Error(`HTTP ${response.status}`);
          err.retryable = response.status >= 500;
          throw err;
        }

        const text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
          throw new Error('Upstream payload exceeded maximum allowed size');
        }

        return JSON.parse(text);
      } catch (error) {
        lastError = error;
        const shouldRetry = attempt === 0 && (error.retryable !== false);
        if (!shouldRetry) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw lastError;
  }

  async function fetchSingleParking(meta, previousData, parisTimeLabel) {
    try {
      const data = await fetchJsonSafe(buildParkingAvailabilityUrl(meta.apiId));
      if (!data || !Object.prototype.hasOwnProperty.call(data, 'availablePlaces') || !Number.isFinite(Number(data.availablePlaces))) {
        throw new Error('Invalid API payload');
      }

      const rawAvailable = Math.round(Number(data.availablePlaces));
      if (rawAvailable < 0) {
        throw new Error(`Negative available count (${rawAvailable})`);
      }

      const clampedAvailable = Math.min(rawAvailable, meta.maxCapacity);
      const occupied = Math.max(0, meta.maxCapacity - clampedAvailable);
      const { status, statusText, percentage } = computeParkingStatus(clampedAvailable, meta.maxCapacity);
      const occupiedPrm = (
        data.occupied_PRM !== null
        && data.occupied_PRM !== undefined
        && Number.isFinite(Number(data.occupied_PRM))
      )
        ? Number(data.occupied_PRM)
        : null;

      return {
        key: meta.key,
        slug: meta.slug,
        name: meta.name,
        shortName: meta.shortName,
        available: rawAvailable,
        occupied,
        maxCapacity: meta.maxCapacity,
        percentage,
        occupiedPrm,
        status,
        statusText,
        lastUpdate: parisTimeLabel,
        stale: false,
        zone: meta.zone,
        zoneKey: meta.zoneKey,
        lat: meta.lat,
        lng: meta.lng,
        maxHeightMeters: meta.maxHeightMeters,
        pmrSpots: meta.pmrSpots,
        evChargers: meta.evChargers,
        address: meta.address,
        navigation: meta.navigation
      };
    } catch (error) {
      console.error(`Error fetching data for ${meta.name}:`, error.message);
      return buildErrorParkingDto(meta, previousData, parisTimeLabel);
    }
  }

  function hydrateFromDb() {
    if (latestSnapshotCache) {
      return;
    }
    const persisted = dbStore.getLatestPersistedSnapshot();
    if (persisted) {
      latestSnapshotCache = persisted.parkings;
      latestMeta = {
        timestamp: persisted.timestamp,
        parisTime: persisted.parisTime,
        stale: true
      };
    }
  }

  async function collectNow() {
    const now = new Date();
    const paris = getParisParts(now);
    const timestamp = getUtcIsoNoMs(now);

    const entries = await Promise.all(
      PARKINGS_LIST.map(async (meta) => {
        const prev = latestSnapshotCache ? latestSnapshotCache[meta.key] : null;
        const dto = await fetchSingleParking(meta, prev, paris.timeLabel);
        return [meta.key, dto];
      })
    );

    const snapshot = Object.fromEntries(entries);
    const anyFresh = entries.some(([, dto]) => !dto.stale);
    const anyStale = entries.some(([, dto]) => dto.stale);

    latestSnapshotCache = snapshot;
    if (anyFresh) {
      latestMeta = {
        timestamp,
        parisTime: paris.timeLabel,
        stale: anyStale
      };
    } else if (!latestMeta.timestamp) {
      latestMeta = {
        timestamp: null,
        parisTime: '--:--:--',
        stale: true
      };
    } else {
      latestMeta = {
        ...latestMeta,
        stale: true
      };
    }
    lastFetchMs = Date.now();

    try {
      dbStore.persistSnapshot(snapshot, now);
    } catch (error) {
      console.error('Failed to persist snapshot:', error.message);
    }

    return {
      timestamp: latestMeta.timestamp,
      parisTime: latestMeta.parisTime,
      stale: latestMeta.stale,
      parkings: latestSnapshotCache
    };
  }

  async function getLiveSnapshot({ force = false } = {}) {
    if (!force && latestSnapshotCache && (Date.now() - lastFetchMs) < config.liveCacheTtlMs) {
      return {
        timestamp: latestMeta.timestamp,
        parisTime: latestMeta.parisTime,
        stale: latestMeta.stale,
        parkings: latestSnapshotCache
      };
    }

    if (!inFlightPromise) {
      inFlightPromise = collectNow().finally(() => {
        inFlightPromise = null;
      });
    }

    return inFlightPromise;
  }

  function getCachedOrDbSnapshot() {
    hydrateFromDb();
    if (!latestSnapshotCache) {
      return null;
    }
    return {
      timestamp: latestMeta.timestamp,
      parisTime: latestMeta.parisTime,
      stale: latestMeta.stale,
      parkings: latestSnapshotCache
    };
  }

  function start() {
    hydrateFromDb();
    if (collectorInterval) {
      return;
    }
    getLiveSnapshot({ force: true }).catch((error) => {
      console.error('Initial background collector failed:', error.message);
    });
    collectorInterval = setInterval(() => {
      getLiveSnapshot({ force: true }).catch((error) => {
        console.error('Background collector failed:', error.message);
      });
    }, config.sampleIntervalMs);
    if (typeof collectorInterval.unref === 'function') {
      collectorInterval.unref();
    }
  }

  function stop() {
    if (collectorInterval) {
      clearInterval(collectorInterval);
      collectorInterval = null;
    }
  }

  return {
    hydrateFromDb,
    getLiveSnapshot,
    getCachedOrDbSnapshot,
    start,
    stop
  };
}

module.exports = {
  buildParkingAvailabilityUrl,
  createCollector
};
