const {
  PARKINGS_LIST,
  PARKINGS_BY_KEY,
  computeParkingStatus,
  getAvailabilityTier,
  getParkingBySlug
} = require('../data/parkings');
const {
  formatMinutesLabel,
  getParisParts,
  getUtcIsoNoMs,
  getWeekdayForDayKey,
  parisWallClockToIso,
  shiftDayKey
} = require('./time');
const { computeWeatherSimilarityWeight } = require('./weather');

const PREDICTION_BUCKETS = Object.freeze([
  { key: 'weekMinus1', label: 'Semaine -1', offsetWeeks: 1, weight: 0.30 },
  { key: 'weekMinus2', label: 'Semaine -2', offsetWeeks: 2, weight: 0.25 },
  { key: 'weekMinus3', label: 'Semaine -3', offsetWeeks: 3, weight: 0.20 },
  { key: 'weekMinus4', label: 'Semaine -4', offsetWeeks: 4, weight: 0.15 },
  { key: 'weekMinus5', label: 'Semaine -5', offsetWeeks: 5, weight: 0.10 }
]);

const TIME_SLOTS_PROFILE = Object.freeze([
  { id: 'morning', label: '08h–10h', hours: [8, 9] },
  { id: 'lateMorning', label: '10h–12h', hours: [10, 11] },
  { id: 'lunch', label: '12h–14h', hours: [12, 13] },
  { id: 'afternoon', label: '14h–17h', hours: [14, 15, 16] },
  { id: 'evening', label: '17h–20h', hours: [17, 18, 19] },
  { id: 'night', label: '20h–00h', hours: [20, 21, 22, 23] }
]);

const WEEKDAY_ORDER_MON_FIRST = Object.freeze([
  { weekday: 1, label: 'Lundi' },
  { weekday: 2, label: 'Mardi' },
  { weekday: 3, label: 'Mercredi' },
  { weekday: 4, label: 'Jeudi' },
  { weekday: 5, label: 'Vendredi' },
  { weekday: 6, label: 'Samedi' },
  { weekday: 0, label: 'Dimanche' }
]);

function dayKeyDiffDays(dayKeyLater, dayKeyEarlier) {
  const [y1, m1, d1] = dayKeyLater.split('-').map((n) => Number.parseInt(n, 10));
  const [y2, m2, d2] = dayKeyEarlier.split('-').map((n) => Number.parseInt(n, 10));
  return Math.round((Date.UTC(y1, m1 - 1, d1) - Date.UTC(y2, m2 - 1, d2)) / 86400000);
}

/**
 * Compute monotonic weighted quantiles (default P25 / P50 / P75) from [{ value, weight }].
 */
function weightedQuantiles(entries, probs = [0.25, 0.5, 0.75]) {
  const valid = (entries || [])
    .filter((e) => Number.isFinite(e?.value) && Number.isFinite(e?.weight) && e.weight > 0)
    .sort((a, b) => a.value - b.value);

  if (!valid.length) {
    return probs.map(() => null);
  }
  if (valid.length === 1) {
    const single = Math.round(valid[0].value * 10) / 10;
    return probs.map(() => single);
  }

  const totalWeight = valid.reduce((acc, e) => acc + e.weight, 0);
  const points = [];
  let cum = 0;
  for (const item of valid) {
    const mid = (cum + (item.weight / 2)) / totalWeight;
    points.push({ p: mid, v: item.value });
    cum += item.weight;
  }

  return probs.map((prob) => {
    if (prob <= points[0].p) {
      return Math.round(points[0].v * 10) / 10;
    }
    const last = points[points.length - 1];
    if (prob >= last.p) {
      return Math.round(last.v * 10) / 10;
    }
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      if (prob >= a.p && prob <= b.p) {
        const span = b.p - a.p;
        const t = span > 0 ? (prob - a.p) / span : 0;
        return Math.round((a.v + (t * (b.v - a.v))) * 10) / 10;
      }
    }
    return Math.round(last.v * 10) / 10;
  });
}

function getMedianNumber(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) {
    return null;
  }
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function getCurrentTimeSlotId(parisHour) {
  const match = TIME_SLOTS_PROFILE.find((s) => s.hours.includes(parisHour));
  return match ? match.id : null;
}

function createAnalytics({ dbStore, config, holidayService, weatherService = null }) {
  const { db } = dbStore;
  const profileCache = new Map();
  const overlayCache = new Map();
  let insightsCache = null;
  const PROFILE_CACHE_TTL_MS = 15 * 60 * 1000;
  const OVERLAY_CACHE_TTL_MS = 5 * 60 * 1000;
  const INSIGHTS_CACHE_TTL_MS = 30 * 60 * 1000;

  const stmtDayRaw = db.prepare(`
    SELECT
      sampled_at,
      parking_key,
      parking_name,
      available,
      occupied,
      max_capacity,
      availability_percentage
    FROM parking_samples
    WHERE day_key = ?
    ORDER BY sampled_at ASC
  `);

  const stmtDayRollup = db.prepare(`
    SELECT
      day_key,
      slot_15m,
      parking_key,
      ROUND(avg_available) AS available,
      ROUND(avg_percentage) AS availability_percentage
    FROM parking_samples_15m
    WHERE day_key = ?
    ORDER BY slot_15m ASC
  `);

  const stmtTypicalAll = db.prepare(`
    SELECT
      parking_key,
      is_school_holiday,
      ROUND(SUM(sum_pct) * 1.0 / SUM(cnt), 1) AS avg_availability,
      MIN(min_pct) AS min_availability,
      MAX(max_pct) AS max_availability,
      SUM(cnt) AS sample_count
    FROM (
      SELECT
        parking_key,
        is_school_holiday,
        availability_percentage AS sum_pct,
        1 AS cnt,
        availability_percentage AS min_pct,
        availability_percentage AS max_pct
      FROM parking_samples
      WHERE hour = ? AND weekday = ?

      UNION ALL

      SELECT
        parking_key,
        is_school_holiday,
        avg_percentage * sample_count AS sum_pct,
        sample_count AS cnt,
        min_percentage AS min_pct,
        max_percentage AS max_pct
      FROM parking_samples_15m
      WHERE hour = ? AND weekday = ?
    )
    GROUP BY parking_key, is_school_holiday
  `);

  const stmtEtaRegressionAll = db.prepare(`
    SELECT parking_key, sampled_at, available, availability_percentage
    FROM parking_samples
    WHERE sampled_at >= ? AND sampled_at <= ?
    ORDER BY parking_key ASC, sampled_at ASC
  `);

  const stmtEtaContextAll = db.prepare(`
    SELECT parking_key, day_key, sampled_at, NULL AS slot_15m, availability_percentage
    FROM parking_samples
    WHERE weekday = ?
      AND is_school_holiday = ?
      AND day_key <> ?
      AND availability_percentage <= ?

    UNION ALL

    SELECT parking_key, day_key, NULL AS sampled_at, slot_15m, ROUND(avg_percentage, 1) AS availability_percentage
    FROM parking_samples_15m
    WHERE weekday = ?
      AND is_school_holiday = ?
      AND day_key <> ?
      AND avg_percentage <= ?
  `);

  const stmtEtaAboveContextAll = db.prepare(`
    SELECT parking_key, day_key, sampled_at, NULL AS slot_15m, availability_percentage
    FROM parking_samples
    WHERE weekday = ?
      AND is_school_holiday = ?
      AND day_key <> ?
      AND availability_percentage >= ?

    UNION ALL

    SELECT parking_key, day_key, NULL AS sampled_at, slot_15m, ROUND(avg_percentage, 1) AS availability_percentage
    FROM parking_samples_15m
    WHERE weekday = ?
      AND is_school_holiday = ?
      AND day_key <> ?
      AND avg_percentage >= ?
  `);

  const stmtEtaDistinctDays = db.prepare(`
    SELECT parking_key, COUNT(DISTINCT day_key) AS sample_days
    FROM (
      SELECT parking_key, day_key
      FROM parking_samples
      WHERE weekday = ?
        AND is_school_holiday = ?
        AND day_key <> ?

      UNION ALL

      SELECT parking_key, day_key
      FROM parking_samples_15m
      WHERE weekday = ?
        AND is_school_holiday = ?
        AND day_key <> ?
    )
    GROUP BY parking_key
  `);

  const stmtProfileRaw = db.prepare(`
    SELECT
      weekday,
      hour,
      is_school_holiday,
      ROUND(SUM(sum_pct) * 1.0 / SUM(cnt), 1) AS avg_availability,
      SUM(cnt) AS sample_count
    FROM (
      SELECT parking_key, weekday, hour, is_school_holiday, availability_percentage AS sum_pct, 1 AS cnt
      FROM parking_samples
      WHERE parking_key = ?

      UNION ALL

      SELECT parking_key, weekday, hour, is_school_holiday, avg_percentage * sample_count AS sum_pct, sample_count AS cnt
      FROM parking_samples_15m
      WHERE parking_key = ?
    )
    GROUP BY weekday, hour, is_school_holiday
  `);

  const stmtObservedDaysBefore = db.prepare(`
    SELECT day_key, weekday, MAX(is_school_holiday) AS is_school_holiday
    FROM (
      SELECT day_key, weekday, is_school_holiday
      FROM parking_samples
      WHERE day_key < ?

      UNION

      SELECT day_key, weekday, is_school_holiday
      FROM parking_samples_15m
      WHERE day_key < ?
    )
    GROUP BY day_key, weekday
    ORDER BY day_key DESC
  `);

  function querySlots15mForDays(dayKeys) {
    const cleanDays = Array.from(new Set((dayKeys || []).filter(Boolean)));
    if (!cleanDays.length) {
      return [];
    }
    const placeholders = cleanDays.map(() => '?').join(', ');
    return db.prepare(`
      SELECT
        day_key,
        parking_key,
        slot_15m,
        ROUND(SUM(sum_pct) * 1.0 / SUM(cnt), 1) AS avg_percentage,
        SUM(cnt) AS sample_count
      FROM (
        SELECT
          day_key,
          parking_key,
          ((hour * 4) + (CAST(substr(sampled_at, 15, 2) AS INTEGER) / 15)) AS slot_15m,
          availability_percentage AS sum_pct,
          1 AS cnt
        FROM parking_samples
        WHERE day_key IN (${placeholders})

        UNION ALL

        SELECT
          day_key,
          parking_key,
          slot_15m,
          avg_percentage * sample_count AS sum_pct,
          sample_count AS cnt
        FROM parking_samples_15m
        WHERE day_key IN (${placeholders})
      )
      GROUP BY day_key, parking_key, slot_15m
      ORDER BY day_key ASC, slot_15m ASC, parking_key ASC
    `).all(...cleanDays, ...cleanDays);
  }

  function selectComparableDays(targetDayKey) {
    const targetHoliday = holidayService.getHolidayInfo(targetDayKey);
    const targetWeekday = getWeekdayForDayKey(targetDayKey).weekday;
    const holidayFlag = targetHoliday.isHoliday ? 1 : 0;
    const allBefore = stmtObservedDaysBefore.all(targetDayKey, targetDayKey);

    if (!allBefore.length) {
      return { candidates: [], contextMatch: 'none', targetHoliday, targetWeekday };
    }

    const yearAgoAnchor = shiftDayKey(targetDayKey, -364);
    const seasonalMin = shiftDayKey(yearAgoAnchor, -14);
    const seasonalMax = shiftDayKey(yearAgoAnchor, 14);

    let contextMatch = 'exact';
    let recentPool;
    let seasonalPool = [];

    if (targetHoliday.isPublicHoliday) {
      recentPool = allBefore.filter((d) => {
        const info = holidayService.getHolidayInfo(d.day_key);
        return info.isPublicHoliday || d.weekday === 0;
      });
      if (recentPool.length > 0) {
        contextMatch = 'public-holiday';
      }
    } else if (targetHoliday.isBridgeDay) {
      recentPool = allBefore.filter((d) => {
        const info = holidayService.getHolidayInfo(d.day_key);
        return info.isBridgeDay || d.weekday === targetWeekday;
      });
      contextMatch = recentPool.some((d) => holidayService.getHolidayInfo(d.day_key).isBridgeDay) ? 'bridge' : 'exact';
    } else {
      recentPool = allBefore.filter((d) => d.weekday === targetWeekday && d.is_school_holiday === holidayFlag);
      seasonalPool = recentPool.filter((d) => d.day_key >= seasonalMin && d.day_key <= seasonalMax);
    }

    if (!recentPool || recentPool.length === 0) {
      recentPool = allBefore.filter((d) => d.weekday === targetWeekday);
      contextMatch = recentPool.length > 0 ? 'fallback-weekday' : 'none';
    }

    const pickedMap = new Map();
    for (const d of recentPool.slice(0, 12)) {
      pickedMap.set(d.day_key, { dayKey: d.day_key, weekday: d.weekday, isSchoolHoliday: d.is_school_holiday, isSeasonal: false });
    }
    for (const d of seasonalPool.slice(0, 4)) {
      if (!pickedMap.has(d.day_key)) {
        pickedMap.set(d.day_key, { dayKey: d.day_key, weekday: d.weekday, isSchoolHoliday: d.is_school_holiday, isSeasonal: true });
      }
    }

    return {
      candidates: Array.from(pickedMap.values()),
      contextMatch,
      targetHoliday,
      targetWeekday
    };
  }

  function getDayHistory(dayKey) {
    const rawRows = stmtDayRaw.all(dayKey);
    if (rawRows.length > 0) {
      const grouped = new Map();
      for (const row of rawRows) {
        let point = grouped.get(row.sampled_at);
        if (!point) {
          point = { timestamp: row.sampled_at, parkings: {} };
          grouped.set(row.sampled_at, point);
        }
        point.parkings[row.parking_key] = {
          name: row.parking_name,
          available: row.available,
          occupied: row.occupied,
          maxCapacity: row.max_capacity,
          percentage: row.availability_percentage
        };
      }
      return {
        date: dayKey,
        resolution: '1m',
        points: Array.from(grouped.values())
      };
    }

    const rollupRows = stmtDayRollup.all(dayKey);
    const grouped = new Map();
    for (const row of rollupRows) {
      const hour = Math.floor(row.slot_15m / 4);
      const minute = (row.slot_15m % 4) * 15;
      const iso = parisWallClockToIso(dayKey, hour, minute);
      let point = grouped.get(iso);
      if (!point) {
        point = { timestamp: iso, parkings: {} };
        grouped.set(iso, point);
      }
      const meta = PARKINGS_BY_KEY[row.parking_key];
      const maxCap = meta ? meta.maxCapacity : 0;
      const avail = Math.max(0, Math.min(maxCap || row.available, row.available));
      point.parkings[row.parking_key] = {
        name: meta ? meta.name : row.parking_key,
        available: avail,
        occupied: maxCap ? Math.max(0, maxCap - avail) : 0,
        maxCapacity: maxCap,
        percentage: row.availability_percentage
      };
    }

    return {
      date: dayKey,
      resolution: rollupRows.length ? '15m' : '1m',
      points: Array.from(grouped.values())
    };
  }

  function getTypicalStatsAll(hour, weekday) {
    const rows = stmtTypicalAll.all(hour, weekday, hour, weekday);
    const byParking = {};

    for (const meta of PARKINGS_LIST) {
      byParking[meta.key] = {
        parkingKey: meta.key,
        name: meta.name,
        schoolHoliday: null,
        nonHoliday: null
      };
    }

    for (const row of rows) {
      const target = byParking[row.parking_key];
      if (!target) {
        continue;
      }
      const payload = {
        avgAvailability: Number(row.avg_availability),
        minAvailability: Number(row.min_availability),
        maxAvailability: Number(row.max_availability),
        sampleCount: Number(row.sample_count)
      };
      if (row.is_school_holiday === 1) {
        target.schoolHoliday = payload;
      } else {
        target.nonHoliday = payload;
      }
    }

    return {
      hour,
      weekday,
      byParking
    };
  }

  function getTypicalStatsForParking(parkingKey, hour, weekday) {
    const all = getTypicalStatsAll(hour, weekday);
    const entry = all.byParking[parkingKey];
    return {
      parkingKey,
      hour,
      weekday,
      context: {
        schoolHoliday: entry ? entry.schoolHoliday : null,
        nonHoliday: entry ? entry.nonHoliday : null
      }
    };
  }

  function computeSingleEta({
    parkingKey,
    regressionRows,
    velocityRows,
    belowThresholdRows,
    aboveRecoveryRows,
    sampleDays,
    typicalEntry,
    nowMinute,
    weekday,
    holiday
  }) {
    const latestSample = velocityRows.length ? velocityRows[velocityRows.length - 1] : null;
    const threshold = config.occupiedWarningThreshold;

    const tangent = {
      hasEstimate: false,
      etaMinutes: null,
      predictedMinute: null,
      predictedTimeLabel: null,
      slopePerMinute: null,
      pointsUsed: regressionRows.length,
      method: `linear-regression-${config.tangentWindowMinutes}m`,
      currentPercentage: null,
      currentSampleAt: null
    };

    const currentAvailable = latestSample && Number.isFinite(Number(latestSample.available))
      ? Number(latestSample.available)
      : null;

    if (latestSample && Number.isFinite(latestSample.availability_percentage)) {
      const currentPercentage = Number(latestSample.availability_percentage);
      tangent.currentPercentage = currentPercentage;
      tangent.currentSampleAt = latestSample.sampled_at;

      if (currentPercentage <= threshold) {
        tangent.hasEstimate = true;
        tangent.etaMinutes = 0;
        tangent.predictedMinute = nowMinute;
        tangent.predictedTimeLabel = formatMinutesLabel(nowMinute);
      } else if (regressionRows.length >= config.tangentMinPoints) {
        const baseMs = new Date(regressionRows[0].sampled_at).getTime();
        const samples = regressionRows
          .map((s) => ({
            x: (new Date(s.sampled_at).getTime() - baseMs) / 60000,
            y: Number(s.availability_percentage)
          }))
          .filter((s) => Number.isFinite(s.x) && Number.isFinite(s.y));

        if (samples.length >= config.tangentMinPoints) {
          const n = samples.length;
          const sumX = samples.reduce((acc, s) => acc + s.x, 0);
          const sumY = samples.reduce((acc, s) => acc + s.y, 0);
          const sumXY = samples.reduce((acc, s) => acc + (s.x * s.y), 0);
          const sumX2 = samples.reduce((acc, s) => acc + (s.x * s.x), 0);
          const denom = (n * sumX2) - (sumX * sumX);

          if (denom !== 0) {
            const slopePerMinute = ((n * sumXY) - (sumX * sumY)) / denom;
            tangent.slopePerMinute = Number(slopePerMinute.toFixed(4));

            if (slopePerMinute <= config.tangentMinSlopePerMinute) {
              const etaRaw = (currentPercentage - threshold) / Math.abs(slopePerMinute);
              const etaMinutes = Math.max(0, Math.round(etaRaw));
              if (etaMinutes <= config.tangentMaxEtaMinutes && (nowMinute + etaMinutes) < (24 * 60)) {
                const predictedMinute = nowMinute + etaMinutes;
                tangent.hasEstimate = true;
                tangent.etaMinutes = etaMinutes;
                tangent.predictedMinute = predictedMinute;
                tangent.predictedTimeLabel = formatMinutesLabel(predictedMinute);
              }
            }
          }
        }
      }
    }

    // Live 15-min velocity trend from velocityRows
    let trend = {
      direction: 'unknown',
      deltaSpots15m: null,
      deltaPct15m: null,
      label: null
    };
    if (velocityRows.length >= 2) {
      const oldest = velocityRows[0];
      const latest = velocityRows[velocityRows.length - 1];
      const dtMinutes = (new Date(latest.sampled_at).getTime() - new Date(oldest.sampled_at).getTime()) / 60000;
      if (dtMinutes >= 4) {
        const dSpots = Number(latest.available) - Number(oldest.available);
        const dPct = Number(latest.availability_percentage) - Number(oldest.availability_percentage);
        const scale = 15 / dtMinutes;
        const deltaSpots15m = Math.round(dSpots * scale);
        const deltaPct15m = Math.round(dPct * scale);
        if (deltaSpots15m <= -3) {
          trend = {
            direction: 'filling',
            deltaSpots15m,
            deltaPct15m,
            label: `↘ ${deltaSpots15m} pl./15 min`
          };
        } else if (deltaSpots15m >= 3) {
          trend = {
            direction: 'emptying',
            deltaSpots15m,
            deltaPct15m,
            label: `↗ +${deltaSpots15m} pl./15 min`
          };
        } else {
          trend = {
            direction: 'stable',
            deltaSpots15m,
            deltaPct15m,
            label: '→ Flux stable'
          };
        }
      }
    }

    // Anomaly score vs typical context average
    const ctxStats = holiday.isHoliday ? typicalEntry?.schoolHoliday : typicalEntry?.nonHoliday;
    let vsTypical = null;
    if (
      ctxStats
      && ctxStats.sampleCount >= 3
      && tangent.currentPercentage !== null
      && Number.isFinite(ctxStats.avgAvailability)
    ) {
      const deltaPoints = Math.round(tangent.currentPercentage - ctxStats.avgAvailability);
      let status = 'normal';
      let label = 'Dans la moyenne habituelle';
      if (deltaPoints >= 8) {
        status = 'quieter';
        label = `+${deltaPoints} pts vs habituel`;
      } else if (deltaPoints <= -8) {
        status = 'busier';
        label = `${deltaPoints} pts vs habituel`;
      }
      vsTypical = {
        typicalPercentage: ctxStats.avgAvailability,
        deltaPoints,
        status,
        label
      };
    }

    // Per-day median first future saturation (outlier-resistant)
    const allBelowWithMinute = belowThresholdRows
      .map((row) => ({
        ...row,
        minuteOfDay: row.sampled_at
          ? getParisParts(row.sampled_at).minuteOfDay
          : (Number(row.slot_15m) * 15)
      }))
      .filter((row) => Number.isFinite(row.minuteOfDay));

    const allSaturatedDays = new Map();
    for (const row of allBelowWithMinute) {
      const prev = allSaturatedDays.get(row.day_key);
      if (prev === undefined || row.minuteOfDay < prev) {
        allSaturatedDays.set(row.day_key, row.minuteOfDay);
      }
    }

    const futureBelowRows = allBelowWithMinute.filter((row) => row.minuteOfDay >= nowMinute);

    const earliestByDay = new Map();
    for (const row of futureBelowRows) {
      const existing = earliestByDay.get(row.day_key);
      if (!existing || row.minuteOfDay < existing.minuteOfDay) {
        earliestByDay.set(row.day_key, row);
      }
    }

    const saturatedDaysCount = earliestByDay.size;
    const denominatorDays = Math.max(sampleDays, saturatedDaysCount);
    const saturationProbability = denominatorDays > 0
      ? Math.round((saturatedDaysCount / denominatorDays) * 100)
      : 0;

    let nearestBelowThresholdStat = {
      hasEstimate: false,
      minuteOfDay: null,
      predictedTimeLabel: null,
      availabilityPercentage: null,
      sampleCount: 0,
      sampleDays: 0,
      saturatedDaysCount,
      saturationProbability
    };

    const allowHabitualAlert = (sampleDays <= 1 && saturatedDaysCount === 1)
      || (saturatedDaysCount >= 1 && saturationProbability >= 30);

    if (allowHabitualAlert && saturatedDaysCount > 0) {
      const dayEntries = Array.from(earliestByDay.values());
      const medianMinute = getMedianNumber(dayEntries.map((r) => r.minuteOfDay));
      const matching = dayEntries.filter((r) => Math.abs(r.minuteOfDay - medianMinute) <= 30);
      const avgSrc = matching.length ? matching : dayEntries;
      const sumPct = avgSrc.reduce((acc, row) => acc + Number(row.availability_percentage), 0);

      nearestBelowThresholdStat = {
        hasEstimate: true,
        minuteOfDay: medianMinute,
        predictedTimeLabel: formatMinutesLabel(medianMinute),
        availabilityPercentage: Math.round((sumPct / avgSrc.length) * 10) / 10,
        sampleCount: dayEntries.length,
        sampleDays: dayEntries.length,
        saturatedDaysCount,
        saturationProbability
      };
    }

    // Recovery / de-saturation estimate when currently saturated or near full
    let recoveryEstimate = {
      hasEstimate: false,
      minuteOfDay: null,
      predictedTimeLabel: null,
      sampleDays: 0
    };
    const currentlyLow = (currentAvailable === 0)
      || (tangent.currentPercentage !== null && tangent.currentPercentage <= threshold);

    if (currentlyLow && aboveRecoveryRows.length > 0 && allSaturatedDays.size > 0) {
      const recoveryByDay = new Map();
      for (const row of aboveRecoveryRows) {
        const satStartMin = allSaturatedDays.get(row.day_key);
        if (satStartMin === undefined) {
          continue;
        }
        const m = row.sampled_at
          ? getParisParts(row.sampled_at).minuteOfDay
          : (Number(row.slot_15m) * 15);
        if (Number.isFinite(m) && m > nowMinute && m > satStartMin) {
          const prev = recoveryByDay.get(row.day_key);
          if (prev === undefined || m < prev) {
            recoveryByDay.set(row.day_key, m);
          }
        }
      }
      if (recoveryByDay.size > 0) {
        const medRecMin = getMedianNumber(Array.from(recoveryByDay.values()));
        recoveryEstimate = {
          hasEstimate: true,
          minuteOfDay: medRecMin,
          predictedTimeLabel: formatMinutesLabel(medRecMin),
          sampleDays: recoveryByDay.size
        };
      }
    }

    let summaryText = 'Affluence normale';
    const isZeroPlaces = currentAvailable !== null
      ? currentAvailable === 0
      : tangent.currentPercentage === 0;

    if (isZeroPlaces) {
      summaryText = recoveryEstimate.hasEstimate
        ? `Complet actuellement · Se libère vers ${recoveryEstimate.predictedTimeLabel}`
        : 'Complet actuellement';
    } else if (tangent.currentPercentage !== null && tangent.currentPercentage <= threshold) {
      summaryText = recoveryEstimate.hasEstimate
        ? `Presque complet (≤ ${threshold} %) · Fluide vers ${recoveryEstimate.predictedTimeLabel}`
        : `Presque complet (≤ ${threshold} %)`;
    } else if (tangent.hasEstimate) {
      summaryText = `Saturation estimée vers ${tangent.predictedTimeLabel} (~${tangent.etaMinutes} min)`;
    } else if (nearestBelowThresholdStat.hasEstimate) {
      const probNote = denominatorDays >= 3 ? ` · ${saturationProbability} % des cas` : '';
      summaryText = `Habituellement < ${threshold} % vers ${nearestBelowThresholdStat.predictedTimeLabel}${probNote}`;
    }

    const hasPrediction = tangent.hasEstimate || nearestBelowThresholdStat.hasEstimate;
    const etaMinutes = tangent.hasEstimate
      ? tangent.etaMinutes
      : (nearestBelowThresholdStat.hasEstimate ? nearestBelowThresholdStat.minuteOfDay - nowMinute : null);

    return {
      parkingKey,
      hasPrediction,
      thresholdPercent: threshold,
      sampleDays,
      predictedFullMinute: tangent.hasEstimate
        ? tangent.predictedMinute
        : nearestBelowThresholdStat.minuteOfDay,
      etaMinutes,
      summaryText,
      tangent,
      nearestBelowThresholdStat,
      recoveryEstimate,
      trend,
      vsTypical,
      context: {
        weekday,
        isSchoolHoliday: holiday.isHoliday,
        holidayLabel: holiday.label,
        dayProfileType: holiday.dayProfileType
      }
    };
  }

  function getEtaFullAll(now = new Date(), options = {}) {
    const paris = getParisParts(now);
    const holiday = holidayService.getHolidayInfo(paris.dayKey);
    const nowIso = getUtcIsoNoMs(now);
    const regWindowMs = config.tangentWindowMinutes * 60 * 1000;
    const velWindowMs = Math.max(config.tangentWindowMinutes, 20) * 60 * 1000;
    const velStartIso = getUtcIsoNoMs(new Date(now.getTime() - velWindowMs));
    const regCutoffMs = now.getTime() - regWindowMs;
    const holidayFlag = holiday.isHoliday ? 1 : 0;

    const velocityAllRows = stmtEtaRegressionAll.all(velStartIso, nowIso);
    const belowRows = stmtEtaContextAll.all(
      paris.weekday,
      holidayFlag,
      paris.dayKey,
      config.occupiedWarningThreshold,
      paris.weekday,
      holidayFlag,
      paris.dayKey,
      config.occupiedWarningThreshold
    );
    const recoveryThreshold = config.occupiedWarningThreshold + 5;
    const aboveRows = stmtEtaAboveContextAll.all(
      paris.weekday,
      holidayFlag,
      paris.dayKey,
      recoveryThreshold,
      paris.weekday,
      holidayFlag,
      paris.dayKey,
      recoveryThreshold
    );
    const dayCountRows = stmtEtaDistinctDays.all(
      paris.weekday,
      holidayFlag,
      paris.dayKey,
      paris.weekday,
      holidayFlag,
      paris.dayKey
    );
    const typicalAll = getTypicalStatsAll(paris.hour, paris.weekday);

    const velByParking = new Map();
    const regByParking = new Map();
    for (const row of velocityAllRows) {
      if (!velByParking.has(row.parking_key)) {
        velByParking.set(row.parking_key, []);
      }
      velByParking.get(row.parking_key).push(row);

      if (new Date(row.sampled_at).getTime() >= regCutoffMs) {
        if (!regByParking.has(row.parking_key)) {
          regByParking.set(row.parking_key, []);
        }
        regByParking.get(row.parking_key).push(row);
      }
    }

    const belowByParking = new Map();
    for (const row of belowRows) {
      if (!belowByParking.has(row.parking_key)) {
        belowByParking.set(row.parking_key, []);
      }
      belowByParking.get(row.parking_key).push(row);
    }

    const aboveByParking = new Map();
    for (const row of aboveRows) {
      if (!aboveByParking.has(row.parking_key)) {
        aboveByParking.set(row.parking_key, []);
      }
      aboveByParking.get(row.parking_key).push(row);
    }

    const daysByParking = new Map();
    for (const row of dayCountRows) {
      daysByParking.set(row.parking_key, Number(row.sample_days) || 0);
    }

    const byParking = {};
    for (const meta of PARKINGS_LIST) {
      byParking[meta.key] = computeSingleEta({
        parkingKey: meta.key,
        regressionRows: regByParking.get(meta.key) || [],
        velocityRows: velByParking.get(meta.key) || [],
        belowThresholdRows: belowByParking.get(meta.key) || [],
        aboveRecoveryRows: aboveByParking.get(meta.key) || [],
        sampleDays: daysByParking.get(meta.key) || 0,
        typicalEntry: typicalAll.byParking[meta.key] || null,
        nowMinute: paris.minuteOfDay,
        weekday: paris.weekday,
        holiday
      });
    }

    return {
      timestamp: options.timestamp || nowIso,
      context: {
        weekday: paris.weekday,
        isSchoolHoliday: holiday.isHoliday,
        holidayLabel: holiday.label,
        dayProfileType: holiday.dayProfileType
      },
      byParking
    };
  }

  function getEtaFullForParking(parkingKey, now = new Date()) {
    const all = getEtaFullAll(now);
    return all.byParking[parkingKey];
  }

  function getPredictionDay(dayKey, options = {}) {
    const now = options.now || new Date();
    const parisToday = getParisParts(now);
    const { weekday, weekdayLabel } = getWeekdayForDayKey(dayKey);
    const { candidates, contextMatch, targetHoliday } = selectComparableDays(dayKey);

    const targetWeather = weatherService ? weatherService.getDaySummary(dayKey) : null;
    const candidateWeatherMap = (weatherService && candidates.length > 0)
      ? weatherService.getSummariesForDays(candidates.map((c) => c.dayKey))
      : {};

    let hasWeatherAdjustment = false;
    const weightedDays = candidates.map((c) => {
      const ageDays = Math.max(1, dayKeyDiffDays(dayKey, c.dayKey));
      const recencyWeight = c.isSeasonal ? 0.35 : Math.exp(-ageDays / 42);
      const candWeather = candidateWeatherMap[c.dayKey] || null;
      const weatherWeight = (targetWeather && candWeather)
        ? computeWeatherSimilarityWeight(targetWeather, candWeather)
        : 1.0;
      if (targetWeather && candWeather) {
        hasWeatherAdjustment = true;
      }
      return {
        ...c,
        weight: recencyWeight * weatherWeight,
        weatherBucket: candWeather?.bucket || null
      };
    });

    const dayWeightMap = new Map(weightedDays.map((d) => [d.dayKey, d.weight]));
    const slotRows = querySlots15mForDays(weightedDays.map((d) => d.dayKey));

    // lookup[parkingKey][slot15m] -> [{ value, weight, count }]
    const byParkingSlot = new Map();
    for (const meta of PARKINGS_LIST) {
      byParkingSlot.set(meta.key, new Map());
    }
    for (const r of slotRows) {
      const slot = Number(r.slot_15m);
      if (!Number.isInteger(slot) || slot < 0 || slot > 95) {
        continue;
      }
      const weight = dayWeightMap.get(r.day_key);
      if (!weight) {
        continue;
      }
      const pMap = byParkingSlot.get(r.parking_key);
      if (!pMap) {
        continue;
      }
      if (!pMap.has(slot)) {
        pMap.set(slot, []);
      }
      pMap.get(slot).push({
        value: Number(r.avg_percentage),
        weight,
        count: Number(r.sample_count) || 1
      });
    }

    // Compute baseline quantile curves per parking & slot
    const baselineByParkingSlot = new Map();
    for (const meta of PARKINGS_LIST) {
      const pMap = byParkingSlot.get(meta.key);
      const resMap = new Map();
      for (const [slot, entries] of pMap.entries()) {
        const [p25, p50, p75] = weightedQuantiles(entries, [0.25, 0.5, 0.75]);
        if (p50 === null) {
          continue;
        }
        const totalW = entries.reduce((acc, e) => acc + e.weight, 0);
        const satW = entries.reduce((acc, e) => acc + (e.value <= config.occupiedWarningThreshold ? e.weight : 0), 0);
        const sampleCount = entries.reduce((acc, e) => acc + e.count, 0);
        resMap.set(slot, {
          p25,
          p50,
          p75,
          saturationRisk: totalW > 0 ? Math.round((satW / totalW) * 100) : 0,
          sampleCount,
          isNowcast: false
        });
      }
      baselineByParkingSlot.set(meta.key, resMap);
    }

    // Intraday nowcast adjustment for today
    const nowSlot = parisToday.slot15m;
    const isTodayNowcast = dayKey === parisToday.dayKey && Boolean(options.liveParkings);
    if (isTodayNowcast) {
      for (const meta of PARKINGS_LIST) {
        const liveEntry = options.liveParkings[meta.key];
        const livePct = (liveEntry && liveEntry.status !== 'error' && Number.isFinite(Number(liveEntry.percentage)))
          ? Number(liveEntry.percentage)
          : null;
        if (livePct === null) {
          continue;
        }
        const resMap = baselineByParkingSlot.get(meta.key);
        let anchor = resMap.get(nowSlot);
        if (!anchor) {
          for (let delta = 1; delta <= 4 && !anchor; delta += 1) {
            anchor = resMap.get(nowSlot - delta) || resMap.get(nowSlot + delta);
          }
        }
        if (!anchor) {
          continue;
        }
        const residual = livePct - anchor.p50;
        for (const [slot, val] of resMap.entries()) {
          if (slot > nowSlot) {
            const deltaMin = (slot - nowSlot) * 15;
            const shift = residual * Math.exp(-deltaMin / 150);
            const clamp = (n) => Math.max(0, Math.min(100, Math.round(n * 10) / 10));
            resMap.set(slot, {
              ...val,
              p25: clamp(val.p25 + shift),
              p50: clamp(val.p50 + shift),
              p75: clamp(val.p75 + shift),
              isNowcast: true
            });
          }
        }
      }
    }

    const points = [];
    const sampleCountByParking = {};
    const spreadValues = [];
    const summaryAcc = Object.fromEntries(
      PARKINGS_LIST.map((m) => [m.key, { sum: 0, count: 0, minPct: Infinity, minSlot: null, maxRisk: 0 }])
    );

    for (let slot = 0; slot < 96; slot += 1) {
      const hour = Math.floor(slot / 4);
      const minute = (slot % 4) * 15;
      const parkingsAtSlot = {};

      for (const meta of PARKINGS_LIST) {
        const val = baselineByParkingSlot.get(meta.key)?.get(slot);
        if (!val) {
          continue;
        }
        const avail = Math.max(0, Math.min(meta.maxCapacity, Math.round((val.p50 / 100) * meta.maxCapacity)));
        parkingsAtSlot[meta.key] = {
          name: meta.name,
          percentage: val.p50,
          p25: val.p25,
          p75: val.p75,
          available: avail,
          saturationRisk: val.saturationRisk,
          sampleCount: val.sampleCount,
          isNowcast: val.isNowcast
        };
        sampleCountByParking[meta.key] = (sampleCountByParking[meta.key] || 0) + val.sampleCount;

        if (hour >= 8 && hour <= 20) {
          spreadValues.push(Math.max(0, val.p75 - val.p25));
        }

        const acc = summaryAcc[meta.key];
        acc.sum += val.p50;
        acc.count += 1;
        acc.maxRisk = Math.max(acc.maxRisk, val.saturationRisk);
        if (val.p50 < acc.minPct) {
          acc.minPct = val.p50;
          acc.minSlot = slot;
        }
      }

      if (Object.keys(parkingsAtSlot).length > 0) {
        points.push({
          timestamp: parisWallClockToIso(dayKey, hour, minute),
          slot15m: slot,
          hour,
          minute,
          parkings: parkingsAtSlot
        });
      }
    }

    const avgSpreadPct = spreadValues.length
      ? Math.round((spreadValues.reduce((a, b) => a + b, 0) / spreadValues.length) * 10) / 10
      : null;

    const matchedDaysCount = candidates.length;
    let level = 'none';
    if (matchedDaysCount >= 5 && (avgSpreadPct === null || avgSpreadPct <= 16)) {
      level = 'high';
    } else if (matchedDaysCount >= 2) {
      level = 'medium';
    } else if (matchedDaysCount === 1) {
      level = 'low';
    }

    let confLabel = 'Historique insuffisant pour cette date';
    if (matchedDaysCount > 0) {
      const lvlText = level === 'high' ? 'Confiance élevée' : (level === 'medium' ? 'Confiance modérée' : 'Confiance indicative');
      const spreadTxt = avgSpreadPct !== null ? ` · dispersion ±${Math.round(avgSpreadPct / 2)} pts` : '';
      const weatherTxt = hasWeatherAdjustment ? ' · météo incluse' : '';
      const fallbackTxt = contextMatch === 'fallback-weekday' ? ' (repli même jour)' : '';
      confLabel = `${lvlText} · ${matchedDaysCount} j. similaires${spreadTxt}${weatherTxt}${fallbackTxt}`;
    }

    const summaryByParking = {};
    for (const meta of PARKINGS_LIST) {
      const acc = summaryAcc[meta.key];
      summaryByParking[meta.key] = acc.count > 0
        ? {
          avgPercentage: Math.round((acc.sum / acc.count) * 10) / 10,
          minPercentage: acc.minPct,
          peakTimeLabel: formatMinutesLabel(acc.minSlot * 15),
          maxSaturationRisk: acc.maxRisk
        }
        : null;
    }

    return {
      date: dayKey,
      mode: 'prediction',
      resolution: '15m',
      strategy: {
        type: 'weighted-15m-quantile',
        matchedDaysCount,
        contextMatch,
        sampleDays: weightedDays.slice(0, 6).map((d) => ({
          dayKey: d.dayKey,
          isSeasonal: d.isSeasonal,
          weatherBucket: d.weatherBucket
        }))
      },
      context: {
        weekday,
        weekdayLabel,
        isSchoolHoliday: targetHoliday.isHoliday,
        holidayLabel: targetHoliday.label,
        isPublicHoliday: targetHoliday.isPublicHoliday,
        publicHolidayLabel: targetHoliday.publicHolidayLabel,
        isBridgeDay: targetHoliday.isBridgeDay,
        dayProfileType: targetHoliday.dayProfileType,
        contextLabel: targetHoliday.contextLabel
      },
      weather: targetWeather
        ? {
          bucket: targetWeather.bucket,
          bucketLabel: targetWeather.bucketLabel,
          minTempC: targetWeather.minTempC,
          maxTempC: targetWeather.maxTempC,
          totalPrecipMm: targetWeather.totalPrecipMm,
          label: targetWeather.label
        }
        : null,
      confidence: {
        level,
        matchedDaysCount,
        avgSpreadPct,
        contextMatch,
        weatherAdjusted: hasWeatherAdjustment,
        label: confLabel
      },
      summaryByParking,
      sampleCountByParking,
      points
    };
  }

  function getTodayOverlay(now = new Date(), liveParkings = null) {
    const paris = getParisParts(now);
    const cacheKey = `${paris.dayKey}|${paris.slot15m}|${liveParkings ? 'live' : 'base'}`;
    const cached = overlayCache.get(cacheKey);
    if (cached && (Date.now() - cached.createdAt) < OVERLAY_CACHE_TTL_MS) {
      return cached.value;
    }

    const pred = getPredictionDay(paris.dayKey, { now, liveParkings });
    const result = {
      dayKey: paris.dayKey,
      nowSlot15m: paris.slot15m,
      confidenceLabel: pred.confidence.label,
      points: pred.points
    };

    if (overlayCache.size > 12) {
      overlayCache.clear();
    }
    overlayCache.set(cacheKey, { createdAt: Date.now(), value: result });
    return result;
  }

  function getArrivalRecommendation(dayKey, timeStr = '14:00', now = new Date()) {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(timeStr || '').trim());
    const hour = match ? Number.parseInt(match[1], 10) : 14;
    const minute = match ? Number.parseInt(match[2], 10) : 0;
    const targetSlot = Math.min(95, (hour * 4) + Math.floor(minute / 15));

    const parisNow = getParisParts(now);
    const prediction = getPredictionDay(dayKey, { now });

    // Pick exact targetSlot or nearest point within +-4 slots (1 hour)
    let bestPoint = null;
    let bestDist = Infinity;
    for (const pt of prediction.points) {
      const dist = Math.abs(pt.slot15m - targetSlot);
      if (dist <= 4 && dist < bestDist) {
        bestDist = dist;
        bestPoint = pt;
      }
    }

    const rankings = PARKINGS_LIST.map((meta) => {
      const pData = bestPoint?.parkings?.[meta.key] || null;
      if (!pData) {
        return {
          parkingKey: meta.key,
          slug: meta.slug,
          name: meta.name,
          shortName: meta.shortName,
          hasData: false,
          percentage: null,
          p25: null,
          p75: null,
          available: null,
          saturationRisk: null,
          tier: 'error'
        };
      }
      const { status } = computeParkingStatus(pData.available, meta.maxCapacity);
      return {
        parkingKey: meta.key,
        slug: meta.slug,
        name: meta.name,
        shortName: meta.shortName,
        hasData: true,
        percentage: pData.percentage,
        p25: pData.p25,
        p75: pData.p75,
        available: pData.available,
        maxCapacity: meta.maxCapacity,
        saturationRisk: pData.saturationRisk,
        tier: getAvailabilityTier(status, pData.percentage)
      };
    }).sort((a, b) => {
      if (a.hasData && !b.hasData) return -1;
      if (!a.hasData && b.hasData) return 1;
      if (!a.hasData && !b.hasData) return 0;
      if (b.available !== a.available) return b.available - a.available;
      return b.percentage - a.percentage;
    });

    const top = rankings.find((r) => r.hasData) || null;
    const timeLabel = `${String(hour).padStart(2, '0')}h${String(minute).padStart(2, '0')}`;
    const recommendationText = top
      ? `Meilleur choix vers ${timeLabel} : ${top.name} (~${top.available} places libres · ${top.percentage} %, risque saturation ${top.saturationRisk} %)`
      : `Pas encore assez d’historique comparable pour recommander un parking vers ${timeLabel}.`;

    return {
      date: dayKey,
      time: timeStr,
      timeLabel,
      slot15m: bestPoint ? bestPoint.slot15m : targetSlot,
      context: prediction.context,
      weather: prediction.weather,
      confidence: prediction.confidence,
      isToday: dayKey === parisNow.dayKey,
      hasData: Boolean(top),
      recommendationText,
      rankings
    };
  }

  function computeInsightsCore(now = new Date()) {
    const todayKey = getParisParts(now).dayKey;

    // 1. Dataset summary
    const rawAgg = db.prepare(`
      SELECT COUNT(*) AS cnt, COUNT(DISTINCT day_key) AS days, MIN(day_key) AS min_d, MAX(day_key) AS max_d
      FROM parking_samples
    `).get();
    const rollAgg = db.prepare(`
      SELECT COUNT(*) AS buckets, SUM(sample_count) AS samples, COUNT(DISTINCT day_key) AS days, MIN(day_key) AS min_d, MAX(day_key) AS max_d
      FROM parking_samples_15m
    `).get();
    const totalDaysRow = db.prepare(`
      SELECT COUNT(DISTINCT day_key) AS days FROM (
        SELECT day_key FROM parking_samples
        UNION
        SELECT day_key FROM parking_samples_15m
      )
    `).get();

    const firstDayKey = [rawAgg?.min_d, rollAgg?.min_d].filter(Boolean).sort()[0] || null;
    const lastDayKey = [rawAgg?.max_d, rollAgg?.max_d].filter(Boolean).sort().at(-1) || null;

    const busiestRow = db.prepare(`
      SELECT day_key, ROUND(AVG(pct), 1) AS avg_avail, COUNT(*) AS rows_cnt
      FROM (
        SELECT day_key, availability_percentage AS pct FROM parking_samples WHERE hour >= 9 AND hour <= 19
        UNION ALL
        SELECT day_key, avg_percentage AS pct FROM parking_samples_15m WHERE hour >= 9 AND hour <= 19
      )
      GROUP BY day_key
      HAVING rows_cnt >= 20
      ORDER BY avg_avail ASC
      LIMIT 1
    `).get();

    const dataset = {
      totalRawSamples: Number(rawAgg?.cnt) || 0,
      totalRollupBuckets: Number(rollAgg?.buckets) || 0,
      totalRecordedSamples: (Number(rawAgg?.cnt) || 0) + (Number(rollAgg?.samples) || 0),
      distinctDays: Number(totalDaysRow?.days) || 0,
      firstDayKey,
      lastDayKey,
      busiestDay: busiestRow ? { dayKey: busiestRow.day_key, avgAvailability: Number(busiestRow.avg_avail) } : null
    };

    // 2. Causal backtesting over up to last 14 completed days
    const completedDays = stmtObservedDaysBefore.all(todayKey, todayKey).slice(0, 14);
    let absErrSum = 0;
    let errPoints = 0;
    let within10 = 0;
    let evaluatedDays = 0;

    if (completedDays.length >= 2) {
      const obsRows = querySlots15mForDays(completedDays.map((d) => d.day_key));
      const obsByDay = new Map();
      for (const r of obsRows) {
        if (!obsByDay.has(r.day_key)) {
          obsByDay.set(r.day_key, []);
        }
        obsByDay.get(r.day_key).push(r);
      }

      for (const dayEntry of completedDays) {
        const pred = getPredictionDay(dayEntry.day_key, { now });
        if (!pred.confidence.matchedDaysCount || !pred.points.length) {
          continue;
        }
        const predLookup = new Map();
        for (const pt of pred.points) {
          for (const [pKey, pVal] of Object.entries(pt.parkings)) {
            predLookup.set(`${pKey}|${pt.slot15m}`, pVal.percentage);
          }
        }
        let dayErrPts = 0;
        for (const obs of (obsByDay.get(dayEntry.day_key) || [])) {
          const hr = Math.floor(Number(obs.slot_15m) / 4);
          if (hr < 8 || hr > 20) {
            continue;
          }
          const predicted = predLookup.get(`${obs.parking_key}|${obs.slot_15m}`);
          if (predicted === undefined) {
            continue;
          }
          const err = Math.abs(predicted - Number(obs.avg_percentage));
          absErrSum += err;
          errPoints += 1;
          dayErrPts += 1;
          if (err <= 10) {
            within10 += 1;
          }
        }
        if (dayErrPts > 0) {
          evaluatedDays += 1;
        }
      }
    }

    const backtesting = {
      evaluatedDays,
      samplePoints: errPoints,
      maePct: errPoints > 0 ? Math.round((absErrSum / errPoints) * 10) / 10 : null,
      within10PctRate: errPoints > 0 ? Math.round((within10 / errPoints) * 100) : null
    };

    // 3. Turnover (rotation) over last 14 days from 1-min samples (08h..20h)
    const turnoverSinceDay = shiftDayKey(todayKey, -14);
    const rawTurnoverRows = db.prepare(`
      SELECT parking_key, day_key, sampled_at, available
      FROM parking_samples
      WHERE day_key >= ? AND hour >= 8 AND hour < 20
      ORDER BY parking_key ASC, sampled_at ASC
    `).all(turnoverSinceDay);

    const turnoverAcc = Object.fromEntries(
      PARKINGS_LIST.map((m) => [m.key, { absDiff: 0, totalMin: 0 }])
    );
    const prevByParking = new Map();

    for (const r of rawTurnoverRows) {
      const prev = prevByParking.get(r.parking_key);
      if (prev && prev.dayKey === r.day_key) {
        const dtMin = (new Date(r.sampled_at).getTime() - prev.ms) / 60000;
        if (dtMin > 0 && dtMin <= 5) {
          const acc = turnoverAcc[r.parking_key];
          if (acc) {
            acc.absDiff += Math.abs(Number(r.available) - prev.available);
            acc.totalMin += dtMin;
          }
        }
      }
      prevByParking.set(r.parking_key, {
        dayKey: r.day_key,
        ms: new Date(r.sampled_at).getTime(),
        available: Number(r.available)
      });
    }

    const turnoverByParking = {};
    for (const meta of PARKINGS_LIST) {
      const acc = turnoverAcc[meta.key];
      if (!acc || acc.totalMin < 10) {
        turnoverByParking[meta.key] = null;
        continue;
      }
      const avgMovesPerHour = Math.round(acc.absDiff / (acc.totalMin / 60));
      let rating = 'lente';
      let label = `Rotation modérée (~${avgMovesPerHour} pl./h en journée)`;
      if (avgMovesPerHour >= 45) {
        rating = 'rapide';
        label = `Rotation rapide (~${avgMovesPerHour} pl./h en journée)`;
      } else if (avgMovesPerHour >= 20) {
        rating = 'modérée';
      } else {
        label = `Rotation lente (~${avgMovesPerHour} pl./h en journée)`;
      }
      turnoverByParking[meta.key] = {
        avgMovesPerHour,
        rating,
        observedHours: Math.round((acc.totalMin / 60) * 10) / 10,
        label
      };
    }

    // 4. Spillover & saturation lag between neighboring parkings across recent 45 days
    const recent45Days = stmtObservedDaysBefore.all(todayKey, todayKey).slice(0, 45);
    const spilloverByParking = {};
    for (const meta of PARKINGS_LIST) {
      spilloverByParking[meta.key] = [];
    }

    if (recent45Days.length > 0) {
      const spRows = querySlots15mForDays(recent45Days.map((d) => d.day_key));
      // dayKey -> parkingKey -> slot -> avg_percentage
      const spLookup = new Map();
      for (const r of spRows) {
        if (!spLookup.has(r.day_key)) {
          spLookup.set(r.day_key, new Map());
        }
        const byP = spLookup.get(r.day_key);
        if (!byP.has(r.parking_key)) {
          byP.set(r.parking_key, new Map());
        }
        byP.get(r.parking_key).set(Number(r.slot_15m), Number(r.avg_percentage));
      }

      for (const meta of PARKINGS_LIST) {
        const satDaysA = [];
        for (const [dk, byP] of spLookup.entries()) {
          const slotsA = byP.get(meta.key);
          if (!slotsA) {
            continue;
          }
          let firstSatSlotA = null;
          for (const [slot, pct] of slotsA.entries()) {
            if (pct <= config.occupiedWarningThreshold && (firstSatSlotA === null || slot < firstSatSlotA)) {
              firstSatSlotA = slot;
            }
          }
          if (firstSatSlotA !== null) {
            satDaysA.push({ dayKey: dk, firstSatSlotA, byP });
          }
        }

        if (satDaysA.length > 0) {
          for (const altSlug of meta.alternatives || []) {
            const altMeta = getParkingBySlug(altSlug);
            if (!altMeta) {
              continue;
            }
            let obsDays = 0;
            let stillOpenCount = 0;
            const lags = [];

            for (const item of satDaysA) {
              const slotsB = item.byP.get(altMeta.key);
              if (!slotsB || !slotsB.has(item.firstSatSlotA)) {
                continue;
              }
              obsDays += 1;
              if (slotsB.get(item.firstSatSlotA) > 20) {
                stillOpenCount += 1;
              }
              let firstSatSlotB = null;
              for (const [slotB, pctB] of slotsB.entries()) {
                if (slotB >= item.firstSatSlotA && pctB <= config.occupiedWarningThreshold) {
                  if (firstSatSlotB === null || slotB < firstSatSlotB) {
                    firstSatSlotB = slotB;
                  }
                }
              }
              if (firstSatSlotB !== null) {
                lags.push((firstSatSlotB - item.firstSatSlotA) * 15);
              }
            }

            if (obsDays > 0) {
              const stillAvailableRate = Math.round((stillOpenCount / obsDays) * 100);
              const medianLagMinutes = lags.length ? getMedianNumber(lags) : null;
              const label = medianLagMinutes !== null && medianLagMinutes > 0
                ? `Quand ${meta.shortName} sature, ${altMeta.shortName} reste disponible dans ${stillAvailableRate} % des cas (~${medianLagMinutes} min de répit)`
                : `Quand ${meta.shortName} sature, ${altMeta.shortName} reste disponible dans ${stillAvailableRate} % des cas`;

              spilloverByParking[meta.key].push({
                alternativeKey: altMeta.key,
                alternativeSlug: altMeta.slug,
                alternativeName: altMeta.shortName,
                observedDays: obsDays,
                stillAvailableRate,
                medianLagMinutes,
                label
              });
            }
          }
        }
      }
    }

    return {
      generatedAt: getUtcIsoNoMs(now),
      dataset,
      backtesting,
      turnoverByParking,
      spilloverByParking
    };
  }

  function getInsightsOverview(now = new Date()) {
    if (insightsCache && (Date.now() - insightsCache.createdAt) < INSIGHTS_CACHE_TTL_MS) {
      return insightsCache.value;
    }
    const value = computeInsightsCore(now);
    insightsCache = { createdAt: Date.now(), value };
    return value;
  }

  function getPredictionDayLegacyCompat(dayKey, options) {
    return getPredictionDay(dayKey, options);
  }

  function getParkingProfile7x24(parkingKey) {
    const cached = profileCache.get(parkingKey);
    if (cached && (Date.now() - cached.createdAt) < PROFILE_CACHE_TTL_MS) {
      return cached.value;
    }

    const meta = PARKINGS_BY_KEY[parkingKey];
    const maxCap = meta ? meta.maxCapacity : 100;
    const rows = stmtProfileRaw.all(parkingKey, parkingKey);
    const byKey = new Map();
    let totalSamples = 0;

    for (const row of rows) {
      const k = `${row.is_school_holiday}|${row.weekday}|${row.hour}`;
      byKey.set(k, {
        avgAvailability: Number(row.avg_availability),
        sampleCount: Number(row.sample_count)
      });
      totalSamples += Number(row.sample_count) || 0;
    }

    function buildTableForContext(holidayFlag) {
      return WEEKDAY_ORDER_MON_FIRST.map((wd) => {
        const slots = TIME_SLOTS_PROFILE.map((slot) => {
          let weighted = 0;
          let cnt = 0;
          for (const h of slot.hours) {
            const entry = byKey.get(`${holidayFlag}|${wd.weekday}|${h}`);
            if (entry) {
              weighted += entry.avgAvailability * entry.sampleCount;
              cnt += entry.sampleCount;
            }
          }
          const avgAvailability = cnt > 0 ? Math.round((weighted / cnt) * 10) / 10 : null;
          let tier = 'none';
          if (avgAvailability !== null) {
            const estAvail = avgAvailability === 0 ? 0 : Math.max(1, Math.round((avgAvailability / 100) * maxCap));
            const { status } = computeParkingStatus(estAvail, maxCap);
            tier = getAvailabilityTier(status, avgAvailability);
          }
          return {
            id: slot.id,
            label: slot.label,
            avgAvailability,
            tier,
            sampleCount: cnt
          };
        });

        return {
          weekday: wd.weekday,
          label: wd.label,
          slots
        };
      });
    }

    function computeHourlyPeaks(weekdayFilterFn) {
      const peakHours = [];
      const quietHours = [];
      const summary = [];

      for (let hour = 7; hour <= 23; hour += 1) {
        let sum = 0;
        let cnt = 0;
        for (let wd = 0; wd < 7; wd += 1) {
          if (!weekdayFilterFn(wd)) {
            continue;
          }
          for (const hf of [0, 1]) {
            const entry = byKey.get(`${hf}|${wd}|${hour}`);
            if (entry) {
              sum += entry.avgAvailability * entry.sampleCount;
              cnt += entry.sampleCount;
            }
          }
        }
        if (cnt > 0) {
          const avg = Math.round((sum / cnt) * 10) / 10;
          summary.push({ hour, avgAvailability: avg, sampleCount: cnt });
          if (avg <= 15) {
            peakHours.push(`${String(hour).padStart(2, '0')}h`);
          }
          if (avg >= 55) {
            quietHours.push(`${String(hour).padStart(2, '0')}h`);
          }
        }
      }
      return {
        peakHours: peakHours.slice(0, 5),
        quietHours: quietHours.slice(0, 5),
        summary
      };
    }

    const overall = computeHourlyPeaks(() => true);
    const weekdayOnly = computeHourlyPeaks((wd) => wd >= 1 && wd <= 5);
    const weekendOnly = computeHourlyPeaks((wd) => wd === 0 || wd === 6);
    const insights = getInsightsOverview();

    const result = {
      parkingKey,
      totalSamples,
      hasData: totalSamples > 0,
      slotsHeader: TIME_SLOTS_PROFILE.map((s) => s.label),
      nonHolidayTable: buildTableForContext(0),
      schoolHolidayTable: buildTableForContext(1),
      peakSaturationHours: overall.peakHours,
      quietestHours: overall.quietHours,
      weekdayPeaks: weekdayOnly.peakHours,
      weekendPeaks: weekendOnly.peakHours,
      weekdayQuietest: weekdayOnly.quietHours,
      weekendQuietest: weekendOnly.quietHours,
      hourlySummary: overall.summary,
      turnover: insights.turnoverByParking[parkingKey] || null,
      spillover: insights.spilloverByParking[parkingKey] || []
    };

    profileCache.set(parkingKey, { createdAt: Date.now(), value: result });
    return result;
  }

  function clearProfileCache() {
    profileCache.clear();
    overlayCache.clear();
    insightsCache = null;
  }

  return {
    getDayHistory,
    getTypicalStatsAll,
    getTypicalStatsForParking,
    getEtaFullAll,
    getEtaFullForParking,
    getPredictionDay: getPredictionDayLegacyCompat,
    getTodayOverlay,
    getArrivalRecommendation,
    getInsightsOverview,
    getParkingProfile7x24,
    clearProfileCache
  };
}

module.exports = {
  PREDICTION_BUCKETS,
  TIME_SLOTS_PROFILE,
  WEEKDAY_ORDER_MON_FIRST,
  weightedQuantiles,
  getCurrentTimeSlotId,
  createAnalytics
};
