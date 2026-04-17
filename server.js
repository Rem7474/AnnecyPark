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
    url: 'https://annecy-mobilites.latitude-cartagene.com/api/availability?type=parking&id=poi:parking:02'
  },
  courier: {
    name: 'Parking Courier',
    maxCapacity: 757,
    url: 'https://annecy-mobilites.latitude-cartagene.com/api/availability?type=parking&id=poi:parking:04'
  },
  hotelDeVille: {
    name: 'Parking Hotel de Ville',
    maxCapacity: 408,
    url: 'https://annecy-mobilites.latitude-cartagene.com/api/availability?type=parking&id=poi:parking:02'
  }
};

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

async function persistSnapshot(parkingsSnapshot) {
  if (!await shouldPersistSample()) {
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
    for (const [parkingKey, parkingData] of Object.entries(parkingsSnapshot)) {
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
    const response = await fetchURL(parking.url);
    const data = JSON.parse(response);
    
    // Extract available spaces from API response
    const available = data.available || 0;
    const occupied = parking.maxCapacity - available;
    const percentage = Math.round((available / parking.maxCapacity) * 100);
    
    return {
      name: parking.name,
      available: available,
      occupied: occupied,
      maxCapacity: parking.maxCapacity,
      percentage: percentage,
      lastUpdate: new Date().toLocaleTimeString('fr-FR'),
      status: percentage > 50 ? 'available' : percentage > 20 ? 'moderate' : 'full'
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
        resolve(data);
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

async function fetchAllParkingsSnapshot() {
  const bonlieu = await fetchParkingData(parkings.bonlieu);
  const courier = await fetchParkingData(parkings.courier);
  const hotelDeVille = await fetchParkingData(parkings.hotelDeVille);

  return {
    bonlieu,
    courier,
    hotelDeVille
  };
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

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
initDatabase()
  .then(() => {
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
