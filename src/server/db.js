const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { PARKINGS_LIST, computeParkingStatus, getParkingByKey } = require('../data/parkings');
const { getParisParts, getUtcIsoNoMs, isValidDayKey, shiftDayKey } = require('./time');

function createDbStore({ sqlitePath, config, holidayService }) {
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  const db = new Database(sqlitePath);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('temp_store = MEMORY');

  db.exec(`
    CREATE TABLE IF NOT EXISTS parking_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sampled_at TEXT NOT NULL,
      day_key TEXT NOT NULL,
      weekday INTEGER NOT NULL,
      hour INTEGER NOT NULL,
      is_school_holiday INTEGER NOT NULL,
      holiday_label TEXT,
      parking_key TEXT NOT NULL,
      parking_name TEXT NOT NULL,
      available INTEGER NOT NULL,
      occupied INTEGER NOT NULL,
      max_capacity INTEGER NOT NULL,
      availability_percentage INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS parking_samples_15m (
      day_key TEXT NOT NULL,
      slot_15m INTEGER NOT NULL,
      weekday INTEGER NOT NULL,
      hour INTEGER NOT NULL,
      is_school_holiday INTEGER NOT NULL,
      parking_key TEXT NOT NULL,
      avg_available REAL NOT NULL,
      avg_percentage REAL NOT NULL,
      min_percentage INTEGER NOT NULL,
      max_percentage INTEGER NOT NULL,
      sample_count INTEGER NOT NULL,
      PRIMARY KEY (day_key, slot_15m, parking_key)
    );

    CREATE TABLE IF NOT EXISTS weather_hourly (
      day_key TEXT NOT NULL,
      hour INTEGER NOT NULL,
      temp_c REAL,
      precipitation_mm REAL,
      weather_code INTEGER,
      condition_bucket TEXT NOT NULL,
      is_forecast INTEGER NOT NULL DEFAULT 0,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (day_key, hour)
    );

    CREATE INDEX IF NOT EXISTS idx_samples_day_parking ON parking_samples(day_key, parking_key, sampled_at);
    CREATE INDEX IF NOT EXISTS idx_samples_hour_context ON parking_samples(parking_key, hour, weekday, is_school_holiday);
    CREATE INDEX IF NOT EXISTS idx_samples_parking_ts ON parking_samples(parking_key, sampled_at DESC);
    CREATE INDEX IF NOT EXISTS idx_samples_day_ts ON parking_samples(day_key, sampled_at ASC);
    CREATE INDEX IF NOT EXISTS idx_samples_sampled_at ON parking_samples(sampled_at DESC);
    CREATE INDEX IF NOT EXISTS idx_samples_weekday_holiday ON parking_samples(weekday, is_school_holiday, parking_key, sampled_at);
    CREATE INDEX IF NOT EXISTS idx_samples15_day_parking ON parking_samples_15m(day_key, parking_key, slot_15m);
    CREATE INDEX IF NOT EXISTS idx_samples15_hour_context ON parking_samples_15m(parking_key, hour, weekday, is_school_holiday);
    CREATE INDEX IF NOT EXISTS idx_samples15_weekday_holiday ON parking_samples_15m(weekday, is_school_holiday, parking_key, day_key, slot_15m);
    CREATE INDEX IF NOT EXISTS idx_weather_day ON weather_hourly(day_key, hour);
  `);

  const stmtLastSampledAt = db.prepare(`
    SELECT MAX(sampled_at) AS last_sampled_at
    FROM parking_samples
  `);

  const stmtLastParkingSample = db.prepare(`
    SELECT sampled_at, available, occupied, max_capacity, availability_percentage
    FROM parking_samples
    WHERE parking_key = ?
    ORDER BY sampled_at DESC, id DESC
    LIMIT 1
  `);

  const stmtInsertSample = db.prepare(`
    INSERT INTO parking_samples (
      sampled_at,
      day_key,
      weekday,
      hour,
      is_school_holiday,
      holiday_label,
      parking_key,
      parking_name,
      available,
      occupied,
      max_capacity,
      availability_percentage
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const stmtAllForCleanup = db.prepare(`
    SELECT id, parking_key, sampled_at, available, availability_percentage
    FROM parking_samples
    ORDER BY parking_key ASC, sampled_at ASC, id ASC
  `);

  const stmtDeleteById = db.prepare('DELETE FROM parking_samples WHERE id = ?');

  const stmtOldSamples = db.prepare(`
    SELECT sampled_at, is_school_holiday, parking_key, available, availability_percentage
    FROM parking_samples
    WHERE day_key < ?
    ORDER BY sampled_at ASC
  `);

  const stmtUpsert15m = db.prepare(`
    INSERT OR REPLACE INTO parking_samples_15m (
      day_key,
      slot_15m,
      weekday,
      hour,
      is_school_holiday,
      parking_key,
      avg_available,
      avg_percentage,
      min_percentage,
      max_percentage,
      sample_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const stmtDeleteOldRaw = db.prepare('DELETE FROM parking_samples WHERE day_key < ?');

  function shouldPersistSample(nowMs = Date.now()) {
    const row = stmtLastSampledAt.get();
    if (!row || !row.last_sampled_at) {
      return true;
    }
    const lastMs = new Date(row.last_sampled_at).getTime();
    if (!Number.isFinite(lastMs)) {
      return true;
    }
    return (nowMs - lastMs) >= config.sampleIntervalMs;
  }

  function isSuspiciousZeroDrop(prevSample, currentPercentage, currentMs, currentAvailable = 0) {
    if (
      currentAvailable !== 0
      || currentPercentage !== 0
      || !prevSample
      || !Number.isFinite(prevSample.availability_percentage)
    ) {
      return false;
    }
    if (prevSample.availability_percentage <= config.suspiciousZeroDropThresholdPoints) {
      return false;
    }
    const prevMs = new Date(prevSample.sampled_at).getTime();
    if (!Number.isFinite(prevMs)) {
      return false;
    }
    const deltaMs = currentMs - prevMs;
    return deltaMs >= 0 && deltaMs <= config.suspiciousZeroDropMaxWindowMs;
  }

  const insertSnapshotTx = db.transaction((rowsToInsert) => {
    for (const row of rowsToInsert) {
      stmtInsertSample.run(
        row.sampledAt,
        row.dayKey,
        row.weekday,
        row.hour,
        row.isHoliday,
        row.holidayLabel,
        row.parkingKey,
        row.parkingName,
        row.available,
        row.occupied,
        row.maxCapacity,
        row.percentage
      );
    }
  });

  function persistSnapshot(parkingsSnapshot, now = new Date()) {
    const nowMs = now.getTime();
    if (!shouldPersistSample(nowMs)) {
      return { persistedCount: 0, skipped: 'interval' };
    }

    const paris = getParisParts(now);
    const sampledAt = getUtcIsoNoMs(now);
    const holiday = holidayService.getHolidayInfo(paris.dayKey);

    const rowsToInsert = [];
    for (const [parkingKey, parkingData] of Object.entries(parkingsSnapshot || {})) {
      if (!parkingData || parkingData.status === 'error' || parkingData.stale) {
        continue;
      }

      const available = Number(parkingData.available);
      const occupied = Number(parkingData.occupied);
      const maxCapacity = Number(parkingData.maxCapacity);
      const percentage = Number(parkingData.percentage);

      if (
        !Number.isFinite(available)
        || !Number.isFinite(occupied)
        || !Number.isFinite(maxCapacity)
        || !Number.isFinite(percentage)
        || available < 0
        || occupied < 0
        || maxCapacity <= 0
      ) {
        continue;
      }

      const prevSample = stmtLastParkingSample.get(parkingKey);
      if (isSuspiciousZeroDrop(prevSample, percentage, nowMs, Math.round(available))) {
        console.warn(
          `Sample ignored for ${parkingKey}: sudden drop to 0% from ${prevSample.availability_percentage}% within 5 min.`
        );
        continue;
      }

      rowsToInsert.push({
        sampledAt,
        dayKey: paris.dayKey,
        weekday: paris.weekday,
        hour: paris.hour,
        isHoliday: holiday.isHoliday ? 1 : 0,
        holidayLabel: holiday.label,
        parkingKey,
        parkingName: parkingData.name,
        available: Math.round(available),
        occupied: Math.round(occupied),
        maxCapacity: Math.round(maxCapacity),
        percentage: Math.min(100, Math.max(0, Math.round(percentage)))
      });
    }

    if (rowsToInsert.length === 0) {
      return { persistedCount: 0, skipped: 'no-valid-entries' };
    }

    insertSnapshotTx(rowsToInsert);
    return { persistedCount: rowsToInsert.length, sampledAt };
  }

  const cleanupTx = db.transaction(() => {
    const rows = stmtAllForCleanup.all();
    const byParking = new Map();
    for (const row of rows) {
      if (!byParking.has(row.parking_key)) {
        byParking.set(row.parking_key, []);
      }
      byParking.get(row.parking_key).push(row);
    }

    const idsToDelete = [];
    const maxBounceWindowMs = 15 * 60 * 1000;

    for (const parkingRows of byParking.values()) {
      let prevKept = null;

      for (let i = 0; i < parkingRows.length; i += 1) {
        const current = parkingRows[i];
        const pct = current.availability_percentage;

        if (!Number.isFinite(pct)) {
          idsToDelete.push(current.id);
          continue;
        }

        const currMs = new Date(current.sampled_at).getTime();
        const currAvail = Number.isFinite(current.available) ? current.available : 0;
        if (isSuspiciousZeroDrop(prevKept, pct, currMs, currAvail)) {
          const nextRow = parkingRows[i + 1] || null;
          let shouldDelete = false;

          if (!nextRow) {
            shouldDelete = true;
          } else {
            const nextMs = new Date(nextRow.sampled_at).getTime();
            const dtNext = nextMs - currMs;
            // Isolated glitch: immediately bounces back above 0 within 15 minutes
            if (Number.isFinite(nextRow.availability_percentage)
              && (nextRow.availability_percentage > 0 || (Number.isFinite(nextRow.available) && nextRow.available > 0))
              && dtNext >= 0
              && dtNext <= maxBounceWindowMs) {
              shouldDelete = true;
            }
          }

          if (shouldDelete) {
            idsToDelete.push(current.id);
            continue;
          }
        }

        prevKept = current;
      }
    }

    for (const id of idsToDelete) {
      stmtDeleteById.run(id);
    }

    return { deletedCount: idsToDelete.length };
  });

  function cleanupHistoricalAnomalies() {
    return cleanupTx();
  }

  const rollupTx = db.transaction((cutoffDayKey) => {
    const oldRows = stmtOldSamples.all(cutoffDayKey);
    if (!oldRows.length) {
      return { rolledUpBuckets: 0, deletedRawRows: 0 };
    }

    const buckets = new Map();
    for (const row of oldRows) {
      const paris = getParisParts(row.sampled_at);
      const key = `${paris.dayKey}|${paris.slot15m}|${row.parking_key}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          dayKey: paris.dayKey,
          slot15m: paris.slot15m,
          weekday: paris.weekday,
          hour: paris.hour,
          isHoliday: row.is_school_holiday ? 1 : 0,
          parkingKey: row.parking_key,
          sumAvailable: 0,
          sumPct: 0,
          minPct: row.availability_percentage,
          maxPct: row.availability_percentage,
          count: 0
        };
        buckets.set(key, bucket);
      }
      bucket.sumAvailable += Number(row.available) || 0;
      bucket.sumPct += Number(row.availability_percentage) || 0;
      bucket.minPct = Math.min(bucket.minPct, Number(row.availability_percentage) || 0);
      bucket.maxPct = Math.max(bucket.maxPct, Number(row.availability_percentage) || 0);
      bucket.count += 1;
    }

    for (const b of buckets.values()) {
      stmtUpsert15m.run(
        b.dayKey,
        b.slot15m,
        b.weekday,
        b.hour,
        b.isHoliday,
        b.parkingKey,
        Math.round((b.sumAvailable / b.count) * 10) / 10,
        Math.round((b.sumPct / b.count) * 10) / 10,
        b.minPct,
        b.maxPct,
        b.count
      );
    }

    const delResult = stmtDeleteOldRaw.run(cutoffDayKey);
    return { rolledUpBuckets: buckets.size, deletedRawRows: delResult.changes || 0 };
  });

  function rollupAndPruneOldSamples(now = new Date()) {
    const todayKey = getParisParts(now).dayKey;
    const cutoffDayKey = shiftDayKey(todayKey, -config.retentionRawDays);
    return rollupTx(cutoffDayKey);
  }

  function getLatestPersistedSnapshot() {
    const parkings = {};
    let latestIso = null;

    for (const meta of PARKINGS_LIST) {
      const row = stmtLastParkingSample.get(meta.key);
      if (!row) {
        continue;
      }

      if (!latestIso || row.sampled_at > latestIso) {
        latestIso = row.sampled_at;
      }

      const rowParis = getParisParts(row.sampled_at);
      const { status, statusText, percentage } = computeParkingStatus(row.available, meta.maxCapacity);

      parkings[meta.key] = {
        key: meta.key,
        slug: meta.slug,
        name: meta.name,
        shortName: meta.shortName,
        available: row.available,
        occupied: row.occupied,
        maxCapacity: meta.maxCapacity,
        percentage,
        occupiedPrm: null,
        status,
        statusText,
        lastUpdate: rowParis.timeLabel,
        stale: true,
        staleReason: 'Dernier relevé enregistré en base',
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

    if (!latestIso) {
      return null;
    }

    return {
      timestamp: latestIso,
      parisTime: getParisParts(latestIso).timeLabel,
      stale: true,
      parkings
    };
  }

  function getLastSampledAtIso() {
    const row = stmtLastSampledAt.get();
    return row && row.last_sampled_at ? row.last_sampled_at : null;
  }

  const stmtUpsertWeather = db.prepare(`
    INSERT OR REPLACE INTO weather_hourly (
      day_key, hour, temp_c, precipitation_mm, weather_code, condition_bucket, is_forecast, fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const stmtGetWeatherDay = db.prepare(`
    SELECT day_key, hour, temp_c, precipitation_mm, weather_code, condition_bucket, is_forecast, fetched_at
    FROM weather_hourly
    WHERE day_key = ?
    ORDER BY hour ASC
  `);

  const stmtWeatherDayCount = db.prepare('SELECT COUNT(DISTINCT day_key) AS cnt FROM weather_hourly');

  const upsertWeatherTx = db.transaction((rows) => {
    for (const r of rows) {
      stmtUpsertWeather.run(
        r.dayKey,
        r.hour,
        r.tempC,
        r.precipitationMm,
        r.weatherCode,
        r.conditionBucket,
        r.isForecast ? 1 : 0,
        r.fetchedAt
      );
    }
  });

  function upsertWeatherHourly(rows) {
    if (!Array.isArray(rows) || rows.length === 0) {
      return 0;
    }
    upsertWeatherTx(rows);
    return rows.length;
  }

  function getWeatherForDay(dayKey) {
    if (!isValidDayKey(dayKey)) {
      return [];
    }
    return stmtGetWeatherDay.all(dayKey);
  }

  function getWeatherForDays(dayKeys) {
    const valid = Array.from(new Set((dayKeys || []).filter(isValidDayKey)));
    if (!valid.length) {
      return [];
    }
    const placeholders = valid.map(() => '?').join(', ');
    return db.prepare(`
      SELECT day_key, hour, temp_c, precipitation_mm, weather_code, condition_bucket, is_forecast, fetched_at
      FROM weather_hourly
      WHERE day_key IN (${placeholders})
      ORDER BY day_key ASC, hour ASC
    `).all(...valid);
  }

  function getWeatherDayCount() {
    const row = stmtWeatherDayCount.get();
    return Number(row?.cnt) || 0;
  }

  function healthCheck() {
    const row = db.prepare('SELECT 1 AS ok').get();
    return Boolean(row && row.ok === 1);
  }

  function close() {
    db.close();
  }

  return {
    db,
    shouldPersistSample,
    isSuspiciousZeroDrop,
    persistSnapshot,
    cleanupHistoricalAnomalies,
    rollupAndPruneOldSamples,
    getLatestPersistedSnapshot,
    getLastSampledAtIso,
    upsertWeatherHourly,
    getWeatherForDay,
    getWeatherForDays,
    getWeatherDayCount,
    healthCheck,
    close,
    getParkingMeta: getParkingByKey
  };
}

module.exports = {
  createDbStore
};
