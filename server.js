const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;
const SQLITE_PATH = process.env.SQLITE_PATH || path.join(__dirname, 'data', 'parking_history.db');
const SAMPLE_INTERVAL_MS = 60 * 1000;
const FULL_WARNING_THRESHOLD = 5;

let db;
let collectorInterval = null;
let isCollectingSnapshot = false;

const SCHOOL_HOLIDAY_PERIODS_ZONE_A = [
  { label: 'Toussaint', start: '2025-10-18', end: '2025-11-03' },
  { label: 'Noel', start: '2025-12-20', end: '2026-01-05' },
  { label: 'Hiver', start: '2026-02-07', end: '2026-02-23' },
  { label: 'Printemps', start: '2026-04-04', end: '2026-04-20' },
  { label: 'Ete', start: '2026-07-04', end: '2026-08-31' }
];

// Middleware
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Parking locations data
const parkings = {
  bonlieu: {
    name: 'Parking Bonlieu',
    maxCapacity: 652,
    apiId: 'poi:parking:02'
  },
  courier: {
    name: 'Parking Courier',
    maxCapacity: 757,
    apiId: 'poi:parking:04'
  },
  hotelDeVille: {
    name: 'Parking Hotel de Ville',
    maxCapacity: 408,
    apiId: 'poi:parking:01'
  },
  poste: {
    name: 'Parking Poste',
    maxCapacity: 303,
    apiId: 'poi:parking:09'
  },
  sainteClaire: {
    name: 'Parking Sainte Claire',
    maxCapacity: 336,
    apiId: 'poi:parking:10'
  }
};

function buildParkingAvailabilityUrl(apiId) {
  return `https://annecy-mobilites.latitude-cartagene.com/api/availability?type=parking&id=${encodeURIComponent(apiId)}`;
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve(this);
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(row);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(rows);
    });
  });
}

async function initDatabase() {
  fs.mkdirSync(path.dirname(SQLITE_PATH), { recursive: true });
  db = new sqlite3.Database(SQLITE_PATH);

  await dbRun(`
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
    )
  `);

  await dbRun('CREATE INDEX IF NOT EXISTS idx_samples_day_parking ON parking_samples(day_key, parking_key, sampled_at)');
  await dbRun('CREATE INDEX IF NOT EXISTS idx_samples_hour_context ON parking_samples(parking_key, hour, weekday, is_school_holiday)');
}

function getDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getDateFromDayKey(dayKey, hour = 0, minute = 0) {
  const [year, month, day] = dayKey.split('-').map((part) => Number.parseInt(part, 10));
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

function getHolidayInfo(date) {
  const dayValue = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const found = SCHOOL_HOLIDAY_PERIODS_ZONE_A.find((period) => {
    const start = new Date(`${period.start}T00:00:00`).getTime();
    const end = new Date(`${period.end}T23:59:59`).getTime();
    return dayValue >= start && dayValue <= end;
  });

  if (!found) {
    return { isHoliday: false, label: null };
  }
  return { isHoliday: true, label: found.label };
}

function getUtcIso(date) {
  return new Date(date.getTime() - (date.getMilliseconds())).toISOString();
}

async function shouldPersistSample() {
  const row = await dbGet(`
    SELECT sampled_at
    FROM parking_samples
    WHERE parking_key = 'bonlieu'
    ORDER BY sampled_at DESC
    LIMIT 1
  `);

  if (!row || !row.sampled_at) {
    return true;
  }

  return (Date.now() - new Date(row.sampled_at).getTime()) >= SAMPLE_INTERVAL_MS;
}

async function cleanupHistoricalAnomalies() {
  const rows = await dbAll(
    `
    SELECT id, parking_key, availability_percentage
    FROM parking_samples
    ORDER BY parking_key ASC, sampled_at ASC, id ASC
    `
  );

  const idsToDelete = [];

  rows.forEach((row) => {
    const currentPercentage = row.availability_percentage;
    if (!Number.isFinite(currentPercentage) || currentPercentage === 0) {
      idsToDelete.push(row.id);
      return;
    }
  });

  if (!idsToDelete.length) {
    return { deletedCount: 0 };
  }

  await dbRun('BEGIN TRANSACTION');
  try {
    const chunkSize = 400;
    for (let index = 0; index < idsToDelete.length; index += chunkSize) {
      const chunk = idsToDelete.slice(index, index + chunkSize);
      const placeholders = chunk.map(() => '?').join(', ');
      await dbRun(`DELETE FROM parking_samples WHERE id IN (${placeholders})`, chunk);
    }

    await dbRun('COMMIT');
  } catch (error) {
    await dbRun('ROLLBACK');
    throw error;
  }

  return { deletedCount: idsToDelete.length };
}

async function persistSnapshot(parkingsSnapshot) {
  if (!await shouldPersistSample()) {
    return;
  }

  const parkingEntries = Object.entries(parkingsSnapshot);
  const structurallyValidEntries = parkingEntries.filter(([, parkingData]) => {
    if (!parkingData || parkingData.status === 'error') {
      return false;
    }

    if (!Number.isFinite(parkingData.available) || !Number.isFinite(parkingData.occupied)) {
      return false;
    }

    if (!Number.isFinite(parkingData.percentage) || !Number.isFinite(parkingData.maxCapacity)) {
      return false;
    }

    return parkingData.available >= 0
      && parkingData.occupied >= 0
      && parkingData.available <= parkingData.maxCapacity
      && parkingData.occupied <= parkingData.maxCapacity;
  });

  const validEntries = structurallyValidEntries.filter(([, parkingData]) => {
    if (parkingData.percentage === 0) {
      return false;
    }
    return true;
  });

  if (!validEntries.length) {
    console.warn('Snapshot ignored: no valid parking values to persist.');
    return;
  }

  const now = new Date();
  const sampledAt = getUtcIso(now);
  const dayKey = getDateKey(now);
  const weekday = now.getDay();
  const hour = now.getHours();
  const holiday = getHolidayInfo(now);

  await dbRun('BEGIN TRANSACTION');
  try {
    for (const [parkingKey, parkingData] of validEntries) {
      await dbRun(
        `
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
        `,
        [
          sampledAt,
          dayKey,
          weekday,
          hour,
          holiday.isHoliday ? 1 : 0,
          holiday.label,
          parkingKey,
          parkingData.name,
          parkingData.available,
          parkingData.occupied,
          parkingData.maxCapacity,
          parkingData.percentage
        ]
      );
    }
    await dbRun('COMMIT');
  } catch (error) {
    await dbRun('ROLLBACK');
    throw error;
  }
}

function normalizeDayQuery(dayParam) {
  if (!dayParam) {
    return getDateKey(new Date());
  }

  const matches = /^\d{4}-\d{2}-\d{2}$/.test(dayParam);
  if (!matches) {
    return null;
  }

  return dayParam;
}

function getMinuteOfDay(dateValue) {
  const date = new Date(dateValue);
  return (date.getHours() * 60) + date.getMinutes();
}

function median(values) {
  if (!values.length) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }

  return sorted[mid];
}

// Function to fetch parking data from API
async function fetchParkingData(parking) {
  try {
    const response = await fetchURL(buildParkingAvailabilityUrl(parking.apiId));
    const data = JSON.parse(response);

    // Reject malformed payloads instead of turning them into fake zero values.
    if (!Object.prototype.hasOwnProperty.call(data, 'available') || !Number.isFinite(data.available)) {
      throw new Error('Invalid API payload: missing or non-numeric "available" field');
    }

    // Extract available spaces from API response
    const available = Number(data.available);
    if (available < 0 || available > parking.maxCapacity) {
      throw new Error(`Invalid API payload: "available" out of range (${available})`);
    }

    const occupied = parking.maxCapacity - available;
    const percentage = Math.round((available / parking.maxCapacity) * 100);
    
    const isFull = parking.maxCapacity > 400
      ? available <= 100
      : percentage <= 10;

    return {
      name: parking.name,
      available: available,
      occupied: occupied,
      maxCapacity: parking.maxCapacity,
      percentage: percentage,
      lastUpdate: new Date().toLocaleTimeString('fr-FR'),
      status: isFull ? 'full' : percentage > 50 ? 'available' : 'moderate'
    };
  } catch (error) {
    console.error(`Error fetching data for ${parking.name}:`, error);
    return {
      name: parking.name,
      available: 0,
      occupied: 0,
      maxCapacity: parking.maxCapacity,
      percentage: 0,
      lastUpdate: new Date().toLocaleTimeString('fr-FR'),
      status: 'error',
      error: error.message
    };
  }
}

// Helper function to fetch URL data
function fetchURL(url) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https');
    const protocol = isHttps ? require('https') : http;
    
    protocol.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode} while fetching ${url}`));
          return;
        }
        resolve(data);
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

async function fetchAllParkingsSnapshot() {
  const entries = await Promise.all(
    Object.entries(parkings).map(async ([parkingKey, parkingConfig]) => {
      const parkingData = await fetchParkingData(parkingConfig);
      return [parkingKey, parkingData];
    })
  );

  return Object.fromEntries(entries);
}

async function collectAndPersistSnapshot() {
  if (isCollectingSnapshot) {
    return null;
  }

  isCollectingSnapshot = true;
  try {
    const snapshot = await fetchAllParkingsSnapshot();
    await persistSnapshot(snapshot);
    return snapshot;
  } finally {
    isCollectingSnapshot = false;
  }
}

function startBackgroundCollector() {
  const runCollector = async () => {
    try {
      await collectAndPersistSnapshot();
    } catch (error) {
      console.error('Background collector failed:', error);
    }
  };

  // Prime un premier echantillon des le demarrage.
  runCollector();
  collectorInterval = setInterval(runCollector, SAMPLE_INTERVAL_MS);
}

// API endpoint to get all parking data
app.get('/api/parkings', async (req, res) => {
  try {
    let snapshot = await collectAndPersistSnapshot();
    if (!snapshot) {
      // Si le collecteur tourne deja, on repond quand meme avec un snapshot frais.
      snapshot = await fetchAllParkingsSnapshot();
    }
    
    res.json({
      timestamp: new Date().toISOString(),
      parkings: snapshot
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch parking data', details: error.message });
  }
});

app.get('/api/history/day', async (req, res) => {
  try {
    const dayKey = normalizeDayQuery(req.query.date);

    if (!dayKey) {
      res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
      return;
    }

    const rows = await dbAll(
      `
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
      `,
      [dayKey]
    );

    const grouped = new Map();
    rows.forEach((row) => {
      if (!grouped.has(row.sampled_at)) {
        grouped.set(row.sampled_at, {
          timestamp: row.sampled_at,
          parkings: {}
        });
      }

      grouped.get(row.sampled_at).parkings[row.parking_key] = {
        name: row.parking_name,
        available: row.available,
        occupied: row.occupied,
        maxCapacity: row.max_capacity,
        percentage: row.availability_percentage
      };
    });

    res.json({
      date: dayKey,
      points: Array.from(grouped.values())
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch day history', details: error.message });
  }
});

app.get('/api/stats/typical', async (req, res) => {
  try {
    const parkingKey = req.query.parkingKey;
    const hour = Number.parseInt(req.query.hour, 10);
    const weekday = Number.parseInt(req.query.weekday, 10);

    if (!parkingKey || !Object.prototype.hasOwnProperty.call(parkings, parkingKey)) {
      res.status(400).json({ error: 'Invalid parkingKey.' });
      return;
    }

    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      res.status(400).json({ error: 'Invalid hour. Expected 0..23.' });
      return;
    }

    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      res.status(400).json({ error: 'Invalid weekday. Expected 0..6.' });
      return;
    }

    const rows = await dbAll(
      `
      SELECT
        is_school_holiday,
        ROUND(AVG(availability_percentage), 1) AS avg_availability,
        MIN(availability_percentage) AS min_availability,
        MAX(availability_percentage) AS max_availability,
        COUNT(*) AS sample_count
      FROM parking_samples
      WHERE parking_key = ?
        AND hour = ?
        AND weekday = ?
      GROUP BY is_school_holiday
      `,
      [parkingKey, hour, weekday]
    );

    const byContext = {
      schoolHoliday: null,
      nonHoliday: null
    };

    rows.forEach((row) => {
      const payload = {
        avgAvailability: row.avg_availability,
        minAvailability: row.min_availability,
        maxAvailability: row.max_availability,
        sampleCount: row.sample_count
      };

      if (row.is_school_holiday === 1) {
        byContext.schoolHoliday = payload;
      } else {
        byContext.nonHoliday = payload;
      }
    });

    res.json({
      parkingKey,
      hour,
      weekday,
      context: byContext
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to compute stats', details: error.message });
  }
});

app.get('/api/stats/eta-full', async (req, res) => {
  try {
    const parkingKey = req.query.parkingKey;

    if (!parkingKey || !Object.prototype.hasOwnProperty.call(parkings, parkingKey)) {
      res.status(400).json({ error: 'Invalid parkingKey.' });
      return;
    }

    const now = new Date();
    const weekday = now.getDay();
    const dayKey = getDateKey(now);
    const holiday = getHolidayInfo(now);

    const rows = await dbAll(
      `
      SELECT
        day_key,
        sampled_at,
        availability_percentage
      FROM parking_samples
      WHERE parking_key = ?
        AND weekday = ?
        AND is_school_holiday = ?
        AND day_key <> ?
      ORDER BY day_key ASC, sampled_at ASC
      `,
      [parkingKey, weekday, holiday.isHoliday ? 1 : 0, dayKey]
    );

    const byDay = new Map();
    rows.forEach((row) => {
      if (!byDay.has(row.day_key)) {
        byDay.set(row.day_key, []);
      }
      byDay.get(row.day_key).push(row);
    });

    const fullMinutes = [];
    byDay.forEach((samples) => {
      const firstFull = samples.find((sample) => sample.availability_percentage <= FULL_WARNING_THRESHOLD);
      if (!firstFull) {
        return;
      }
      fullMinutes.push(getMinuteOfDay(firstFull.sampled_at));
    });

    if (!fullMinutes.length) {
      res.json({
        parkingKey,
        hasPrediction: false,
        reason: 'not-enough-full-days',
        sampleDays: byDay.size,
        context: {
          weekday,
          isSchoolHoliday: holiday.isHoliday,
          holidayLabel: holiday.label
        }
      });
      return;
    }

    const predictedFullMinute = median(fullMinutes);
    const nowMinute = (now.getHours() * 60) + now.getMinutes();

    res.json({
      parkingKey,
      hasPrediction: true,
      thresholdPercent: FULL_WARNING_THRESHOLD,
      sampleDays: byDay.size,
      predictedFullMinute,
      etaMinutes: predictedFullMinute - nowMinute,
      context: {
        weekday,
        isSchoolHoliday: holiday.isHoliday,
        holidayLabel: holiday.label
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to compute ETA to full', details: error.message });
  }
});

app.get('/api/prediction/day', async (req, res) => {
  try {
    const dayKey = normalizeDayQuery(req.query.date);

    if (!dayKey) {
      res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
      return;
    }

    const targetDate = getDateFromDayKey(dayKey, 12, 0);
    const weekday = targetDate.getDay();
    const holiday = getHolidayInfo(targetDate);

    const rows = await dbAll(
      `
      SELECT
        parking_key,
        parking_name,
        hour,
        ROUND(AVG(availability_percentage), 1) AS avg_availability,
        COUNT(*) AS sample_count
      FROM parking_samples
      WHERE weekday = ?
        AND is_school_holiday = ?
        AND day_key <> ?
      GROUP BY parking_key, parking_name, hour
      ORDER BY hour ASC, parking_key ASC
      `,
      [weekday, holiday.isHoliday ? 1 : 0, dayKey]
    );

    const pointsByHour = new Map();
    for (let hour = 0; hour < 24; hour += 1) {
      pointsByHour.set(hour, {
        timestamp: getDateFromDayKey(dayKey, hour, 0).toISOString(),
        parkings: {}
      });
    }

    const sampleCountByParking = {};
    rows.forEach((row) => {
      if (!pointsByHour.has(row.hour)) {
        return;
      }

      pointsByHour.get(row.hour).parkings[row.parking_key] = {
        name: row.parking_name,
        percentage: row.avg_availability,
        sampleCount: row.sample_count
      };

      sampleCountByParking[row.parking_key] = (sampleCountByParking[row.parking_key] || 0) + row.sample_count;
    });

    res.json({
      date: dayKey,
      mode: 'prediction',
      context: {
        weekday,
        weekdayLabel: ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'][weekday],
        isSchoolHoliday: holiday.isHoliday,
        holidayLabel: holiday.label
      },
      sampleCountByParking,
      points: Array.from(pointsByHour.values())
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to compute day prediction', details: error.message });
  }
});

app.post('/api/history/cleanup-anomalies', async (req, res) => {
  try {
    const result = await cleanupHistoricalAnomalies();
    res.json({
      status: 'ok',
      deletedCount: result.deletedCount,
      rule: 'Removes samples with 0% availability (API anomalies)'
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to cleanup anomalies', details: error.message });
  }
});

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
initDatabase()
  .then(() => {
    return cleanupHistoricalAnomalies();
  })
  .then((result) => {
    if (result.deletedCount > 0) {
      console.log(`Historical anomaly cleanup removed ${result.deletedCount} sample(s).`);
    } else {
      console.log('Historical anomaly cleanup found no sample to remove.');
    }

    app.listen(PORT, () => {
      console.log(`Parking Dashboard server is running at http://localhost:${PORT}`);
      console.log(`SQLite database: ${SQLITE_PATH}`);
      console.log(`Background collector interval: ${SAMPLE_INTERVAL_MS}ms`);
    });

    startBackgroundCollector();
  })
  .catch((error) => {
    console.error('Database initialization failed:', error);
    process.exit(1);
  });
