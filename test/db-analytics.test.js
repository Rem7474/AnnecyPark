const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getConfig } = require('../src/server/config');
const { HolidayService } = require('../src/server/holidays');
const { createDbStore } = require('../src/server/db');
const { createAnalytics } = require('../src/server/analytics');
const { createCollector } = require('../src/server/collector');
const { getParisParts, parisWallClockToIso, shiftDayKey } = require('../src/server/time');

function createTempHarness() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'annecy-db-'));
  const sqlitePath = path.join(tmpDir, 'test.db');
  const config = getConfig({ sqlitePath, nodeEnv: 'test' });
  const holidayService = new HolidayService({ autoFetch: false });
  const dbStore = createDbStore({ sqlitePath, config, holidayService });
  const analytics = createAnalytics({ dbStore, config, holidayService });

  return {
    tmpDir,
    config,
    holidayService,
    dbStore,
    analytics,
    cleanup() {
      dbStore.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

describe('SQLite WAL, Sampling, Anomaly Cleanup & Analytics', () => {
  it('does not block other parkings if bonlieu fails and enforces Δt <= 5min for 0% drops', () => {
    const h = createTempHarness();
    try {
      const t0 = new Date('2026-11-23T10:00:00.000Z');
      const snap1 = {
        bonlieu: { name: 'Parking Bonlieu', available: 0, occupied: 0, maxCapacity: 652, percentage: 0, status: 'error', stale: false },
        courier: { name: 'Parking Courier', available: 400, occupied: 357, maxCapacity: 757, percentage: 53, status: 'available', stale: false }
      };
      const r1 = h.dbStore.persistSnapshot(snap1, t0);
      assert.equal(r1.persistedCount, 1);

      // 10s later: must skip because MAX(sampled_at) was updated by courier even though bonlieu errored!
      const t10s = new Date('2026-11-23T10:00:10.000Z');
      const r2 = h.dbStore.persistSnapshot(snap1, t10s);
      assert.equal(r2.persistedCount, 0);
      assert.equal(r2.skipped, 'interval');

      // 2 min later: isolated glitch drop to 0% from 53% within 5 min -> rejected
      const t2m = new Date('2026-11-23T10:02:00.000Z');
      const snapGlitch = {
        courier: { name: 'Parking Courier', available: 0, occupied: 757, maxCapacity: 757, percentage: 0, status: 'full', stale: false }
      };
      const r3 = h.dbStore.persistSnapshot(snapGlitch, t2m);
      assert.equal(r3.persistedCount, 0);

      // 2 hours later: genuine drop to 0% after long gap -> persisted
      const t2h = new Date('2026-11-23T12:00:00.000Z');
      const r4 = h.dbStore.persistSnapshot(snapGlitch, t2h);
      assert.equal(r4.persistedCount, 1);
    } finally {
      h.cleanup();
    }
  });

  it('cleanupHistoricalAnomalies deletes isolated 0% bounce glitches while preserving genuine saturation', () => {
    const h = createTempHarness();
    try {
      const insert = h.dbStore.db.prepare(`
        INSERT INTO parking_samples (
          sampled_at, day_key, weekday, hour, is_school_holiday, holiday_label,
          parking_key, parking_name, available, occupied, max_capacity, availability_percentage
        ) VALUES (?, '2026-11-20', 5, 10, 0, NULL, 'bonlieu', 'Parking Bonlieu', ?, ?, 652, ?)
      `);

      // Isolated glitch: 40% -> 0% (1m) -> 38% (2m)
      insert.run('2026-11-20T09:00:00.000Z', 260, 392, 40);
      insert.run('2026-11-20T09:01:00.000Z', 0, 652, 0);
      insert.run('2026-11-20T09:02:00.000Z', 248, 404, 38);

      // Genuine sustained saturation after gap: 0% -> 0% -> 0%
      insert.run('2026-11-20T12:00:00.000Z', 0, 652, 0);
      insert.run('2026-11-20T12:01:00.000Z', 0, 652, 0);

      const res = h.dbStore.cleanupHistoricalAnomalies();
      assert.equal(res.deletedCount, 1);

      const remaining = h.dbStore.db.prepare('SELECT sampled_at, availability_percentage FROM parking_samples ORDER BY sampled_at ASC').all();
      assert.equal(remaining.length, 4);
      assert.equal(remaining[1].sampled_at, '2026-11-20T09:02:00.000Z');
      assert.equal(remaining[2].availability_percentage, 0);
      assert.equal(remaining[3].availability_percentage, 0);
    } finally {
      h.cleanup();
    }
  });

  it('computes strictly non-negative future ETA and bounded tangent predictions', () => {
    const h = createTempHarness();
    try {
      const now = new Date('2026-11-23T10:00:00.000Z'); // 11:00 Paris
      const parisNow = getParisParts(now);
      const pastDay = shiftDayKey(parisNow.dayKey, -7);
      const pastParis = getParisParts(parisWallClockToIso(pastDay, 9, 0));

      const insert = h.dbStore.db.prepare(`
        INSERT INTO parking_samples (
          sampled_at, day_key, weekday, hour, is_school_holiday, holiday_label,
          parking_key, parking_name, available, occupied, max_capacity, availability_percentage
        ) VALUES (?, ?, ?, ?, 0, NULL, 'bonlieu', 'Parking Bonlieu', ?, ?, 652, ?)
      `);

      // Past saturation at 09:00 (must NOT produce negative ETA at 11:00!)
      insert.run(parisWallClockToIso(pastDay, 9, 0), pastDay, pastParis.weekday, 9, 30, 622, 5);
      // Future saturation at 12:30
      insert.run(parisWallClockToIso(pastDay, 12, 30), pastDay, pastParis.weekday, 12, 40, 612, 6);

      // Recent tangent samples dropping steadily (-2%/min -> reaches 10% in 10 min)
      insert.run('2026-11-23T09:50:00.000Z', parisNow.dayKey, parisNow.weekday, parisNow.hour, 326, 326, 50);
      insert.run('2026-11-23T09:55:00.000Z', parisNow.dayKey, parisNow.weekday, parisNow.hour, 261, 391, 40);
      insert.run('2026-11-23T10:00:00.000Z', parisNow.dayKey, parisNow.weekday, parisNow.hour, 196, 456, 30);

      const eta = h.analytics.getEtaFullForParking('bonlieu', now);
      assert.equal(eta.hasPrediction, true);
      assert.equal(eta.tangent.hasEstimate, true);
      assert.equal(eta.tangent.etaMinutes, 10);
      assert.equal(eta.nearestBelowThresholdStat.hasEstimate, true);
      assert.ok(eta.nearestBelowThresholdStat.minuteOfDay >= parisNow.minuteOfDay);
      assert.ok(eta.etaMinutes >= 0);
    } finally {
      h.cleanup();
    }
  });

  it('deduplicates concurrent upstream API fetches via single-flight TTL cache', async () => {
    const h = createTempHarness();
    let fetchCalls = 0;
    try {
      const collector = createCollector({
        config: h.config,
        dbStore: h.dbStore,
        fetcher: async () => {
          fetchCalls += 1;
          await new Promise((r) => setTimeout(r, 30));
          return {
            ok: true,
            text: async () => JSON.stringify({ available: 150, occupied_PRM: null })
          };
        }
      });

      // 3 simultaneous requests should result in only 5 upstream calls (1 per parking), not 15!
      await Promise.all([
        collector.getLiveSnapshot(),
        collector.getLiveSnapshot(),
        collector.getLiveSnapshot()
      ]);
      assert.equal(fetchCalls, 5);

      // Immediate 4th request hits TTL cache -> still 5
      await collector.getLiveSnapshot();
      assert.equal(fetchCalls, 5);
    } finally {
      h.cleanup();
    }
  });

  it('distinguishes 1-3 available spots (0% rounded) from full (0 spots) in anomaly guard and ETA summary', () => {
    const h = createTempHarness();
    try {
      const t0 = new Date('2026-11-23T10:00:00.000Z');
      h.dbStore.persistSnapshot({
        courier: { name: 'Parking Courier', available: 400, occupied: 357, maxCapacity: 757, percentage: 53, status: 'available', stale: false }
      }, t0);

      // 2 minutes later, genuine drop to 2 spots (rounds to 0% on 757 capacity)
      const t2m = new Date('2026-11-23T10:02:00.000Z');
      const rLow = h.dbStore.persistSnapshot({
        courier: { name: 'Parking Courier', available: 2, occupied: 755, maxCapacity: 757, percentage: 0, status: 'critical', stale: false }
      }, t2m);
      assert.equal(rLow.persistedCount, 1);

      const eta = h.analytics.getEtaFullForParking('courier', t2m);
      assert.equal(eta.summaryText, 'Presque complet (≤ 10 %)');
    } finally {
      h.cleanup();
    }
  });

  it('includes rolled-up parking_samples_15m (> 90 days) in ETA historical fallback and uses indexes', () => {
    const h = createTempHarness();
    try {
      const now = new Date('2026-11-23T10:00:00.000Z'); // Monday 11:00 Paris
      const parisNow = getParisParts(now);
      const oldDay = shiftDayKey(parisNow.dayKey, -154); // > 90 days, same weekday (Monday), non-holiday -> rolled up to 15m
      const oldParis = getParisParts(parisWallClockToIso(oldDay, 12, 30));

      h.dbStore.db.prepare(`
        INSERT INTO parking_samples (
          sampled_at, day_key, weekday, hour, is_school_holiday, holiday_label,
          parking_key, parking_name, available, occupied, max_capacity, availability_percentage
        ) VALUES (?, ?, ?, ?, 0, NULL, 'bonlieu', 'Parking Bonlieu', 30, 622, 652, 5)
      `).run(parisWallClockToIso(oldDay, 12, 30), oldDay, oldParis.weekday, 12);

      const rollup = h.dbStore.rollupAndPruneOldSamples(now);
      assert.equal(rollup.deletedRawRows, 1);
      assert.equal(rollup.rolledUpBuckets, 1);

      const eta = h.analytics.getEtaFullForParking('bonlieu', now);
      assert.equal(eta.sampleDays, 1);
      assert.equal(eta.nearestBelowThresholdStat.hasEstimate, true);
      assert.equal(eta.nearestBelowThresholdStat.predictedTimeLabel, '12h30');

      const maxPlan = h.dbStore.db.prepare('EXPLAIN QUERY PLAN SELECT MAX(sampled_at) FROM parking_samples').all();
      assert.ok(maxPlan.some((r) => /idx_samples_sampled_at/i.test(r.detail)));

      const etaCtxPlan = h.dbStore.db.prepare(`
        EXPLAIN QUERY PLAN
        SELECT parking_key, day_key, sampled_at, availability_percentage
        FROM parking_samples
        WHERE weekday = ? AND is_school_holiday = ? AND day_key <> ? AND availability_percentage <= ?
      `).all(1, 0, '2026-11-23', 10);
      assert.ok(etaCtxPlan.some((r) => /idx_samples_weekday_holiday/i.test(r.detail)));
    } finally {
      h.cleanup();
    }
  });

  it('preserves previous snapshot timestamp when all 5 upstream fetches fail', async () => {
    const h = createTempHarness();
    let shouldFail = false;
    try {
      const collector = createCollector({
        config: h.config,
        dbStore: h.dbStore,
        fetcher: async () => {
          if (shouldFail) {
            throw new Error('Upstream down');
          }
          return {
            ok: true,
            text: async () => JSON.stringify({ available: 210, occupied_PRM: null })
          };
        }
      });

      const first = await collector.getLiveSnapshot({ force: true });
      assert.equal(first.stale, false);
      assert.ok(first.timestamp);

      await new Promise((r) => setTimeout(r, 1100));
      shouldFail = true;
      const fallback = await collector.getLiveSnapshot({ force: true });
      assert.equal(fallback.stale, true);
      assert.equal(fallback.timestamp, first.timestamp);
      assert.equal(fallback.parisTime, first.parisTime);
    } finally {
      h.cleanup();
    }
  });
});
