const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  getParisParts,
  isValidDayKey,
  normalizeDayQuery,
  shiftDayKey,
  parisWallClockToIso
} = require('../src/server/time');
const {
  HolidayService,
  normalizeEducationRecords
} = require('../src/server/holidays');
const { computeParkingStatus, getAvailabilityTier, getParkingBySlug, getParkingByKey } = require('../src/data/parkings');

describe('Time utilities (Europe/Paris & DST)', () => {
  it('validates real calendar dates and rejects invalid ones', () => {
    assert.equal(isValidDayKey('2026-04-17'), true);
    assert.equal(isValidDayKey('2026-02-31'), false);
    assert.equal(isValidDayKey('9999-99-99'), false);
    assert.equal(isValidDayKey('2024-02-29'), true);
    assert.equal(isValidDayKey('2025-02-29'), false);
    assert.equal(normalizeDayQuery('2026-02-31'), null);
  });

  it('converts UTC timestamps accurately to Europe/Paris regardless of host TZ', () => {
    // 2026-07-15T12:00:00Z -> CEST (UTC+2) => 14:00:00 Paris
    const summer = getParisParts('2026-07-15T12:00:00.000Z');
    assert.equal(summer.dayKey, '2026-07-15');
    assert.equal(summer.hour, 14);
    assert.equal(summer.timeLabel, '14:00:00');

    // 2026-01-15T23:30:00Z -> CET (UTC+1) => 2026-01-16 00:30:00 Paris
    const winterBoundary = getParisParts('2026-01-15T23:30:00.000Z');
    assert.equal(winterBoundary.dayKey, '2026-01-16');
    assert.equal(winterBoundary.hour, 0);
    assert.equal(winterBoundary.minute, 30);
  });

  it('shifts day keys across DST transitions cleanly without losing days', () => {
    assert.equal(shiftDayKey('2026-03-29', -7), '2026-03-22');
    assert.equal(shiftDayKey('2026-10-25', 1), '2026-10-26');
    // 24 distinct hourly ISO timestamps on winter DST transition day (2026-10-25)
    const hours = new Set();
    for (let h = 0; h < 24; h += 1) {
      const iso = parisWallClockToIso('2026-10-25', h, 0);
      hours.add(iso);
      assert.equal(getParisParts(iso).hour, h);
    }
    assert.equal(hours.size, 24);
  });
});

describe('Zone A Holidays (data.education.gouv.fr normalization)', () => {
  it('excludes teachers, parses Paris dates, and excludes return-to-school Mondays', () => {
    const sampleApiResults = [
      {
        annee_scolaire: '2025-2026',
        description: 'Vacances de la Toussaint',
        population: '-',
        start_date: '2025-10-17T22:00:00+00:00',
        end_date: '2025-11-02T23:00:00+00:00'
      },
      {
        annee_scolaire: '2026-2027',
        description: "Vacances d'Été",
        population: 'Enseignants',
        start_date: '2027-07-02T22:00:00+00:00',
        end_date: '2027-08-31T22:00:00+00:00'
      },
      {
        annee_scolaire: '2026-2027',
        description: "Pont de l'Ascension",
        population: '-',
        start_date: '2027-05-06T22:00:00+00:00',
        end_date: '2027-05-06T22:00:00+00:00'
      }
    ];

    const normalized = normalizeEducationRecords(sampleApiResults);
    assert.equal(normalized.length, 2);
    assert.equal(normalized[0].startDayKey, '2025-10-18');
    assert.equal(normalized[0].endDayKey, '2025-11-03');
    assert.equal(normalized[0].inclusiveEnd, false);
    assert.equal(normalized[1].startDayKey, '2027-05-07');
    assert.equal(normalized[1].inclusiveEnd, true);
  });

  it('ignores Rentrée scolaire entries and malformed date records without discarding valid periods', () => {
    const records = [
      {
        annee_scolaire: '2026-2027',
        description: 'Rentrée scolaire des élèves',
        population: '-',
        start_date: '2026-09-01T00:00:00+02:00',
        end_date: '2026-09-01T00:00:00+02:00'
      },
      {
        annee_scolaire: '2026-2027',
        description: 'Corrupted entry',
        population: '-',
        start_date: 'not-a-date',
        end_date: '2026-10-20T00:00:00+02:00'
      },
      {
        annee_scolaire: '2026-2027',
        description: 'Vacances de Noël',
        population: '-',
        start_date: '2026-12-18T23:00:00+00:00',
        end_date: '2027-01-03T23:00:00+00:00'
      }
    ];

    const normalized = normalizeEducationRecords(records);
    assert.equal(normalized.length, 1);
    assert.equal(normalized[0].label, 'Vacances de Noël');
    assert.equal(normalized[0].startDayKey, '2026-12-19');
    assert.equal(normalized[0].endDayKey, '2027-01-04');
  });

  it('fetches, caches on disk, and evaluates half-open and single-day holidays', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'annecy-hol-'));
    const cachePath = path.join(tmpDir, 'holidays.json');

    try {
      const service = new HolidayService({
        cachePath,
        fetcher: async () => ({
          ok: true,
          json: async () => ({
            results: [
              {
                annee_scolaire: '2026-2027',
                description: 'Vacances de la Toussaint',
                population: '-',
                start_date: '2026-10-16T22:00:00+00:00',
                end_date: '2026-11-01T23:00:00+00:00'
              },
              {
                annee_scolaire: '2026-2027',
                description: "Pont de l'Ascension",
                population: '-',
                start_date: '2027-05-06T22:00:00+00:00',
                end_date: '2027-05-06T22:00:00+00:00'
              }
            ]
          })
        })
      });

      const status = await service.init();
      assert.equal(status.updated, true);
      assert.equal(fs.existsSync(cachePath), true);

      // Inside Toussaint 2026
      assert.equal(service.getHolidayInfo('2026-10-17').isHoliday, true);
      assert.equal(service.getHolidayInfo('2026-11-01').isHoliday, true);
      // Monday return-to-school (2026-11-02) MUST NOT be holiday
      assert.equal(service.getHolidayInfo('2026-11-02').isHoliday, false);
      // Single-day Pont de l'Ascension (2027-05-07)
      assert.equal(service.getHolidayInfo('2027-05-07').isHoliday, true);
      assert.equal(service.getHolidayInfo('2027-05-08').isHoliday, false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Parking catalog & status threshold logic', () => {
  it('never labels a parking with remaining spots as Complet', () => {
    const hotelDeVille31 = computeParkingStatus(31, 408);
    assert.equal(hotelDeVille31.percentage, 8);
    assert.equal(hotelDeVille31.status, 'critical');
    assert.equal(hotelDeVille31.statusText, 'Presque complet');

    const bonlieu80 = computeParkingStatus(80, 652);
    assert.equal(bonlieu80.percentage, 12);
    assert.equal(bonlieu80.status, 'moderate');

    const zero = computeParkingStatus(0, 652);
    assert.equal(zero.status, 'full');
    assert.equal(zero.statusText, 'Complet');
  });

  it('resolves slugs and SQLite keys consistently', () => {
    assert.equal(getParkingBySlug('hotel-de-ville')?.key, 'hotelDeVille');
    assert.equal(getParkingByKey('sainteClaire')?.slug, 'sainte-claire');
    assert.equal(getParkingBySlug('inexistant'), null);
  });

  it('computes 6 availability tiers cleanly from status and percentage', () => {
    assert.equal(getAvailabilityTier('available', 70), 'high');
    assert.equal(getAvailabilityTier('moderate', 45), 'medium');
    assert.equal(getAvailabilityTier('moderate', 30), 'medium');
    assert.equal(getAvailabilityTier('moderate', 20), 'low');
    assert.equal(getAvailabilityTier('critical', 8), 'critical');
    assert.equal(getAvailabilityTier('full', 0), 'full');
    assert.equal(getAvailabilityTier('error', 0), 'error');
  });
});
