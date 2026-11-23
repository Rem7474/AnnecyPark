const fs = require('fs');
const path = require('path');
const { getParisParts, getWeekdayForDayKey, isValidDayKey, shiftDayKey } = require('./time');

const EDUCATION_API_URL = 'https://data.education.gouv.fr/api/explore/v2.1/catalog/datasets/fr-en-calendrier-scolaire/records?where='
  + encodeURIComponent('location="Grenoble" and zones="Zone A" and end_date >= "2024-09-01"')
  + '&order_by=start_date&limit=100';

const PUBLIC_HOLIDAYS_API_URL = 'https://calendrier.api.gouv.fr/jours-feries/metropole.json';

const FALLBACK_PUBLIC_HOLIDAYS_FR = Object.freeze({
  '2025-01-01': '1er janvier',
  '2025-04-21': 'Lundi de Pâques',
  '2025-05-01': '1er mai',
  '2025-05-08': '8 mai',
  '2025-05-29': 'Ascension',
  '2025-06-09': 'Lundi de Pentecôte',
  '2025-07-14': '14 juillet',
  '2025-08-15': 'Assomption',
  '2025-11-01': 'Toussaint',
  '2025-11-11': '11 novembre',
  '2025-12-25': 'Jour de Noël',
  '2026-01-01': '1er janvier',
  '2026-04-06': 'Lundi de Pâques',
  '2026-05-01': '1er mai',
  '2026-05-08': '8 mai',
  '2026-05-14': 'Ascension',
  '2026-05-25': 'Lundi de Pentecôte',
  '2026-07-14': '14 juillet',
  '2026-08-15': 'Assomption',
  '2026-11-01': 'Toussaint',
  '2026-11-11': '11 novembre',
  '2026-12-25': 'Jour de Noël',
  '2027-01-01': '1er janvier',
  '2027-03-29': 'Lundi de Pâques',
  '2027-05-01': '1er mai',
  '2027-05-06': 'Ascension',
  '2027-05-08': '8 mai',
  '2027-05-17': 'Lundi de Pentecôte',
  '2027-07-14': '14 juillet',
  '2027-08-15': 'Assomption',
  '2027-11-01': 'Toussaint',
  '2027-11-11': '11 novembre',
  '2027-12-25': 'Jour de Noël',
  '2028-01-01': '1er janvier',
  '2028-04-17': 'Lundi de Pâques',
  '2028-05-01': '1er mai',
  '2028-05-08': '8 mai',
  '2028-05-25': 'Ascension',
  '2028-06-05': 'Lundi de Pentecôte',
  '2028-07-14': '14 juillet',
  '2028-08-15': 'Assomption',
  '2028-11-01': 'Toussaint',
  '2028-11-11': '11 novembre',
  '2028-12-25': 'Jour de Noël'
});

// Half-open [startDayKey, endDayKey) intervals (or inclusive single-day when inclusiveEnd=true).
// Embedded fallback covers 2025-2028 Zone A (Académie de Grenoble / Annecy) if offline on first boot.
const FALLBACK_PERIODS_ZONE_A = [
  { label: 'Vacances de la Toussaint', schoolYear: '2025-2026', startDayKey: '2025-10-18', endDayKey: '2025-11-03', inclusiveEnd: false },
  { label: 'Vacances de Noël', schoolYear: '2025-2026', startDayKey: '2025-12-20', endDayKey: '2026-01-05', inclusiveEnd: false },
  { label: "Vacances d'Hiver", schoolYear: '2025-2026', startDayKey: '2026-02-07', endDayKey: '2026-02-23', inclusiveEnd: false },
  { label: 'Vacances de Printemps', schoolYear: '2025-2026', startDayKey: '2026-04-04', endDayKey: '2026-04-20', inclusiveEnd: false },
  { label: "Pont de l'Ascension", schoolYear: '2025-2026', startDayKey: '2026-05-14', endDayKey: '2026-05-18', inclusiveEnd: false },
  { label: "Vacances d'Été", schoolYear: '2025-2026', startDayKey: '2026-07-04', endDayKey: '2026-09-01', inclusiveEnd: false },
  { label: 'Vacances de la Toussaint', schoolYear: '2026-2027', startDayKey: '2026-10-17', endDayKey: '2026-11-02', inclusiveEnd: false },
  { label: 'Vacances de Noël', schoolYear: '2026-2027', startDayKey: '2026-12-19', endDayKey: '2027-01-04', inclusiveEnd: false },
  { label: "Vacances d'Hiver", schoolYear: '2026-2027', startDayKey: '2027-02-13', endDayKey: '2027-03-01', inclusiveEnd: false },
  { label: 'Vacances de Printemps', schoolYear: '2026-2027', startDayKey: '2027-04-10', endDayKey: '2027-04-26', inclusiveEnd: false },
  { label: "Pont de l'Ascension", schoolYear: '2026-2027', startDayKey: '2027-05-07', endDayKey: '2027-05-07', inclusiveEnd: true },
  { label: "Vacances d'Été", schoolYear: '2026-2027', startDayKey: '2027-07-03', endDayKey: '2027-09-02', inclusiveEnd: false },
  { label: 'Vacances de la Toussaint', schoolYear: '2027-2028', startDayKey: '2027-10-23', endDayKey: '2027-11-08', inclusiveEnd: false },
  { label: 'Vacances de Noël', schoolYear: '2027-2028', startDayKey: '2027-12-18', endDayKey: '2028-01-03', inclusiveEnd: false },
  { label: "Vacances d'Hiver", schoolYear: '2027-2028', startDayKey: '2028-02-19', endDayKey: '2028-03-06', inclusiveEnd: false },
  { label: 'Vacances de Printemps', schoolYear: '2027-2028', startDayKey: '2028-04-22', endDayKey: '2028-05-09', inclusiveEnd: false },
  { label: "Pont de l'Ascension", schoolYear: '2027-2028', startDayKey: '2028-05-25', endDayKey: '2028-05-29', inclusiveEnd: false },
  { label: "Vacances d'Été", schoolYear: '2027-2028', startDayKey: '2028-07-04', endDayKey: '2028-09-01', inclusiveEnd: false }
];

function normalizeEducationRecords(records) {
  if (!Array.isArray(records)) {
    return [];
  }

  const normalized = [];
  const seen = new Set();

  for (const record of records) {
    if (!record || record.population === 'Enseignants') {
      continue;
    }

    if (!record.start_date || !record.end_date || !record.description) {
      continue;
    }

    let label = String(record.description).trim();
    if (/rentr[ée]e/i.test(label)) {
      continue;
    }

    let startParts;
    let endParts;
    try {
      startParts = getParisParts(record.start_date);
      endParts = getParisParts(record.end_date);
    } catch {
      continue;
    }

    const startDayKey = startParts.dayKey;
    let endDayKey = endParts.dayKey;
    if (startDayKey > endDayKey) {
      continue;
    }
    let inclusiveEnd = startDayKey === endDayKey;

    if (/^D[ée]but des Vacances d'[EÉ]t[ée]/i.test(label) && startDayKey === endDayKey) {
      label = "Vacances d'Été";
      const year = startDayKey.slice(0, 4);
      endDayKey = `${year}-09-01`;
      inclusiveEnd = false;
    }

    const dedupKey = `${startDayKey}|${endDayKey}|${label}`;
    if (seen.has(dedupKey)) {
      continue;
    }
    seen.add(dedupKey);

    normalized.push({
      label,
      schoolYear: record.annee_scolaire || null,
      startDayKey,
      endDayKey,
      inclusiveEnd
    });
  }

  return normalized.sort((a, b) => a.startDayKey.localeCompare(b.startDayKey));
}

class HolidayService {
  constructor({ cachePath, fetcher = fetch, autoFetch = true } = {}) {
    this.cachePath = cachePath;
    this.fetcher = fetcher;
    this.autoFetch = autoFetch;
    this.periods = [...FALLBACK_PERIODS_ZONE_A];
    this.publicHolidays = { ...FALLBACK_PUBLIC_HOLIDAYS_FR };
    this.source = 'embedded-fallback';
    this.lastFetchedAt = null;
  }

  loadFromDisk() {
    if (!this.cachePath || !fs.existsSync(this.cachePath)) {
      return false;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
      let loaded = false;
      if (Array.isArray(raw.periods) && raw.periods.length > 0) {
        this.periods = raw.periods;
        this.source = raw.source || 'disk-cache';
        this.lastFetchedAt = raw.fetchedAt || null;
        loaded = true;
      }
      if (raw.publicHolidays && typeof raw.publicHolidays === 'object') {
        this.publicHolidays = { ...FALLBACK_PUBLIC_HOLIDAYS_FR, ...raw.publicHolidays };
      }
      return loaded;
    } catch (error) {
      console.warn('Unable to read holiday cache file:', error.message);
    }
    return false;
  }

  saveToDisk(periods, fetchedAt, publicHolidays = this.publicHolidays) {
    if (!this.cachePath) {
      return;
    }
    try {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      const tmpPath = `${this.cachePath}.tmp`;
      fs.writeFileSync(
        tmpPath,
        JSON.stringify({ source: 'data.education.gouv.fr', fetchedAt, periods, publicHolidays }, null, 2),
        'utf8'
      );
      fs.renameSync(tmpPath, this.cachePath);
    } catch (error) {
      console.warn('Unable to persist holiday cache file:', error.message);
    }
  }

  async refresh() {
    if (!this.autoFetch || typeof this.fetcher !== 'function') {
      return { updated: false, source: this.source, count: this.periods.length };
    }

    let updated = false;

    try {
      const response = await this.fetcher(EDUCATION_API_URL, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(6000)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = await response.json();
      const normalized = normalizeEducationRecords(payload.results);
      if (normalized.length > 0) {
        this.periods = normalized;
        this.source = 'data.education.gouv.fr';
        this.lastFetchedAt = new Date().toISOString();
        updated = true;
      }
    } catch (error) {
      console.warn('Holiday refresh from data.education.gouv.fr failed, keeping cache/fallback:', error.message);
    }

    try {
      const phRes = await this.fetcher(PUBLIC_HOLIDAYS_API_URL, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(6000)
      });
      if (phRes.ok) {
        const phJson = await phRes.json();
        if (phJson && typeof phJson === 'object' && !Array.isArray(phJson)) {
          const validEntries = {};
          for (const [k, v] of Object.entries(phJson)) {
            if (isValidDayKey(k) && typeof v === 'string' && v.trim()) {
              validEntries[k] = v.trim();
            }
          }
          if (Object.keys(validEntries).length > 0) {
            this.publicHolidays = { ...FALLBACK_PUBLIC_HOLIDAYS_FR, ...validEntries };
            updated = true;
          }
        }
      }
    } catch (error) {
      console.warn('Public holidays refresh from calendrier.api.gouv.fr failed:', error.message);
    }

    if (updated) {
      this.saveToDisk(this.periods, this.lastFetchedAt || new Date().toISOString(), this.publicHolidays);
    }

    return { updated, source: this.source, count: this.periods.length };
  }

  async init() {
    this.loadFromDisk();
    return this.refresh();
  }

  isPublicHoliday(dayKey) {
    return isValidDayKey(dayKey) && Object.prototype.hasOwnProperty.call(this.publicHolidays, dayKey);
  }

  isBridgeDay(dayKey) {
    if (!isValidDayKey(dayKey) || this.isPublicHoliday(dayKey)) {
      return false;
    }
    const { weekday } = getWeekdayForDayKey(dayKey);
    if (weekday === 5) {
      return this.isPublicHoliday(shiftDayKey(dayKey, -1));
    }
    if (weekday === 1) {
      return this.isPublicHoliday(shiftDayKey(dayKey, 1));
    }
    return false;
  }

  getHolidayInfo(dateOrDayKey = new Date()) {
    const dayKey = typeof dateOrDayKey === 'string' && isValidDayKey(dateOrDayKey)
      ? dateOrDayKey
      : getParisParts(dateOrDayKey).dayKey;

    const match = this.periods.find((period) => {
      if (period.inclusiveEnd) {
        return dayKey >= period.startDayKey && dayKey <= period.endDayKey;
      }
      return dayKey >= period.startDayKey && dayKey < period.endDayKey;
    });

    const publicHolidayLabel = this.publicHolidays[dayKey] || null;
    const isPublicHoliday = Boolean(publicHolidayLabel);
    const bridgeDay = !isPublicHoliday && this.isBridgeDay(dayKey);
    const isSchoolHoliday = Boolean(match);

    let dayProfileType = 'regular';
    let contextLabel = 'Hors vacances scolaires (Zone A)';

    if (isPublicHoliday) {
      dayProfileType = 'public-holiday';
      contextLabel = `Jour férié · ${publicHolidayLabel}`;
    } else if (isSchoolHoliday) {
      dayProfileType = 'school-holiday';
      contextLabel = `Vacances scolaires · ${match.label} (Zone A)`;
    } else if (bridgeDay) {
      dayProfileType = 'bridge';
      contextLabel = 'Pont · Jour férié voisin';
    }

    return {
      isHoliday: isSchoolHoliday,
      label: match ? match.label : null,
      isPublicHoliday,
      publicHolidayLabel,
      isBridgeDay: bridgeDay,
      dayProfileType,
      contextLabel
    };
  }

  getStatus() {
    return {
      source: this.source,
      lastFetchedAt: this.lastFetchedAt,
      periodCount: this.periods.length,
      publicHolidayCount: Object.keys(this.publicHolidays).length
    };
  }
}

module.exports = {
  EDUCATION_API_URL,
  PUBLIC_HOLIDAYS_API_URL,
  FALLBACK_PERIODS_ZONE_A,
  FALLBACK_PUBLIC_HOLIDAYS_FR,
  normalizeEducationRecords,
  HolidayService
};
