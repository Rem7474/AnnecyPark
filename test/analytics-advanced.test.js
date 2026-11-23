const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getConfig } = require('../src/server/config');
const { HolidayService } = require('../src/server/holidays');
const { createDbStore } = require('../src/server/db');
const {
  classifyWeatherBucket,
  computeWeatherSimilarityWeight,
  createWeatherService
} = require('../src/server/weather');
const {
  weightedQuantiles,
  createAnalytics
} = require('../src/server/analytics');
const { parisWallClockToIso, shiftDayKey } = require('../src/server/time');

function createAdvancedHarness() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'annecy-adv-'));
  const sqlitePath = path.join(tmpDir, 'adv.db');
  const config = getConfig({ sqlitePath, nodeEnv: 'test' });
  const holidayService = new HolidayService({ autoFetch: false });
  const dbStore = createDbStore({ sqlitePath, config, holidayService });
  const weatherService = createWeatherService({ config, dbStore, autoFetch: false });
  const analytics = createAnalytics({ dbStore, config, holidayService, weatherService });

  return {
    tmpDir,
    config,
    holidayService,
    dbStore,
    weatherService,
    analytics,
    cleanup() {
      dbStore.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

describe('Lots 1, 2 & 3 — Advanced Analytics, Weather, Holidays & Nowcasting', () => {
  it('detects French public holidays and bridge days accurately', () => {
    const service = new HolidayService({ autoFetch: false });

    const bastille = service.getHolidayInfo('2026-07-14');
    assert.equal(bastille.isPublicHoliday, true);
    assert.equal(bastille.publicHolidayLabel, '14 juillet');
    assert.equal(bastille.dayProfileType, 'public-holiday');
    assert.ok(bastille.contextLabel.includes('Jour férié'));

    // Thursday 2026-05-07 is regular, Friday 2026-05-08 is public holiday (8 mai)
    const may8 = service.getHolidayInfo('2026-05-08');
    assert.equal(may8.isPublicHoliday, true);

    // Thursday 2025-05-29 is Ascension -> Friday 2025-05-30 is a bridge day
    const bridgeFri = service.isBridgeDay('2025-05-30');
    assert.equal(bridgeFri, true);

    // Regular Monday
    const regularMon = service.getHolidayInfo('2026-11-23');
    assert.equal(regularMon.isPublicHoliday, false);
    assert.equal(regularMon.isBridgeDay, false);
    assert.equal(regularMon.dayProfileType, 'regular');
  });

  it('ingests Open-Meteo hourly weather and computes weather similarity weights', async () => {
    const h = createAdvancedHarness();
    try {
      assert.equal(classifyWeatherBucket(0, 0), 'sunny');
      assert.equal(classifyWeatherBucket(3, 0), 'cloudy');
      assert.equal(classifyWeatherBucket(61, 1.2), 'rain');
      assert.equal(classifyWeatherBucket(73, 0.5), 'snow');

      const mockTimes = [];
      const mockTemps = [];
      const mockPrecips = [];
      const mockCodes = [];

      // Sunny warm day (2026-11-16) vs Rainy cold day (2026-11-23)
      for (let hr = 0; hr < 24; hr += 1) {
        const hh = String(hr).padStart(2, '0');
        mockTimes.push(`2026-11-16T${hh}:00`);
        mockTemps.push(18);
        mockPrecips.push(0);
        mockCodes.push(1);

        mockTimes.push(`2026-11-23T${hh}:00`);
        mockTemps.push(7);
        mockPrecips.push(2.1);
        mockCodes.push(63);
      }

      const activeWeather = createWeatherService({
        config: h.config,
        dbStore: h.dbStore,
        autoFetch: true,
        fetcher: async () => ({
          ok: true,
          text: async () => JSON.stringify({
            hourly: {
              time: mockTimes,
              temperature_2m: mockTemps,
              precipitation: mockPrecips,
              weather_code: mockCodes
            }
          })
        })
      });

      const res = await activeWeather.refresh(new Date('2026-11-23T12:00:00Z'));
      assert.equal(res.updated, true);
      assert.equal(res.dayCount, 2);

      const sunnyDay = activeWeather.getDaySummary('2026-11-16');
      const rainyDay = activeWeather.getDaySummary('2026-11-23');
      assert.equal(sunnyDay.bucket, 'sunny');
      assert.equal(rainyDay.bucket, 'rain');

      const sameWeight = computeWeatherSimilarityWeight(sunnyDay, sunnyDay);
      const oppWeight = computeWeatherSimilarityWeight(sunnyDay, rainyDay);
      assert.ok(sameWeight > 1.3);
      assert.ok(oppWeight < 0.7);
    } finally {
      h.cleanup();
    }
  });

  it('rejects 1-in-10 freak saturation outliers while reporting median time, recovery, velocity & vsTypical', () => {
    const h = createAdvancedHarness();
    try {
      const insert = h.dbStore.db.prepare(`
        INSERT INTO parking_samples (
          sampled_at, day_key, weekday, hour, is_school_holiday, holiday_label,
          parking_key, parking_name, available, occupied, max_capacity, availability_percentage
        ) VALUES (?, ?, 1, ?, 0, NULL, 'bonlieu', 'Parking Bonlieu', ?, ?, 652, ?)
      `);

      const baseMonday = '2026-11-23';
      // Insert 8 past Mondays: all have normal 50% at 11h, and only 1 freak Monday saturated at 13h00
      for (let w = 1; w <= 8; w += 1) {
        const day = shiftDayKey(baseMonday, -(w * 7));
        insert.run(parisWallClockToIso(day, 11, 0), day, 11, 326, 326, 50);
        const pct13 = w === 1 ? 5 : 45;
        const avail13 = Math.round((pct13 / 100) * 652);
        insert.run(parisWallClockToIso(day, 13, 0), day, 13, avail13, 652 - avail13, pct13);
      }

      // Today at 11:15 Paris: availability dropped from 230 to 190 over 15 min (-40 pl./15m) and is 29% vs 50% typical (-21 pts)
      insert.run(parisWallClockToIso(baseMonday, 11, 0), baseMonday, 11, 230, 422, 35);
      insert.run(parisWallClockToIso(baseMonday, 11, 15), baseMonday, 11, 190, 462, 29);

      const now1115 = new Date(parisWallClockToIso(baseMonday, 11, 15));
      const etaOutlier = h.analytics.getEtaFullForParking('bonlieu', now1115);

      // 1 out of 8 Mondays = 13% (< 30% threshold) -> must NOT trigger habitual saturation alert!
      assert.equal(etaOutlier.nearestBelowThresholdStat.saturationProbability, 13);
      assert.equal(etaOutlier.nearestBelowThresholdStat.hasEstimate, false);
      assert.equal(etaOutlier.trend.direction, 'filling');
      assert.equal(etaOutlier.trend.deltaSpots15m, -40);
      assert.equal(etaOutlier.vsTypical.status, 'busier');
      assert.equal(etaOutlier.vsTypical.deltaPoints, -17);

      // Now add saturation on 3 more Mondays (total 4/8 = 50% >= 30%) + recovery at 16h30
      for (let w = 2; w <= 4; w += 1) {
        const day = shiftDayKey(baseMonday, -(w * 7));
        insert.run(parisWallClockToIso(day, 14, 0), day, 14, 30, 622, 5);
        insert.run(parisWallClockToIso(day, 16, 30), day, 16, 160, 492, 25);
      }

      // Simulate Bonlieu currently saturated at 14:10 today
      insert.run(parisWallClockToIso(baseMonday, 14, 10), baseMonday, 14, 0, 652, 0);
      const now1410 = new Date(parisWallClockToIso(baseMonday, 14, 10));
      const etaFull = h.analytics.getEtaFullForParking('bonlieu', now1410);
      assert.equal(etaFull.recoveryEstimate.hasEstimate, true);
      assert.equal(etaFull.recoveryEstimate.predictedTimeLabel, '16h30');
      assert.ok(etaFull.summaryText.includes('Se libère vers 16h30'));
    } finally {
      h.cleanup();
    }
  });

  it('computes 15m P25/P50/P75 predictions, weather boost, intraday nowcasting, arrival ranking & Lot 3 insights', () => {
    const h = createAdvancedHarness();
    try {
      const q = weightedQuantiles([
        { value: 20, weight: 1 },
        { value: 40, weight: 1 },
        { value: 60, weight: 1 },
        { value: 80, weight: 1 }
      ]);
      assert.ok(q[0] <= q[1] && q[1] <= q[2]);

      const insert = h.dbStore.db.prepare(`
        INSERT INTO parking_samples (
          sampled_at, day_key, weekday, hour, is_school_holiday, holiday_label,
          parking_key, parking_name, available, occupied, max_capacity, availability_percentage
        ) VALUES (?, ?, 1, ?, 0, NULL, ?, ?, ?, ?, ?, ?)
      `);

      // Seed 4 past Mondays with turnover & spillover (Bonlieu saturates at 14h00, Courier stays at 45% and saturates at 14h45)
      const baseMonday = '2026-11-23';
      for (let w = 1; w <= 4; w += 1) {
        const day = shiftDayKey(baseMonday, -(w * 7));
        const basePct = 30 + (w * 5); // 35, 40, 45, 50
        for (const hr of [10, 12, 14, 16]) {
          const bonPct = hr === 14 ? 6 : basePct;
          const bonAvail = Math.round((bonPct / 100) * 652);
          insert.run(parisWallClockToIso(day, hr, 0), day, hr, 'bonlieu', 'Parking Bonlieu', bonAvail, 652 - bonAvail, 652, bonPct);
          // 2 minutes later: move 6 cars for turnover
          insert.run(parisWallClockToIso(day, hr, 2), day, hr, 'bonlieu', 'Parking Bonlieu', bonAvail + 6, 652 - bonAvail - 6, 652, bonPct);

          const couPct = hr === 14 ? 44 : 60;
          const couAvail = Math.round((couPct / 100) * 757);
          insert.run(parisWallClockToIso(day, hr, 0), day, hr, 'courier', 'Parking Courier', couAvail, 757 - couAvail, 757, couPct);
          if (hr === 14) {
            insert.run(parisWallClockToIso(day, 14, 45), day, 14, 'courier', 'Parking Courier', 50, 707, 757, 7);
          }
        }
      }

      // 1. Test 15m prediction & arrival recommendation for next Monday (2026-11-30)
      const nextMon = '2026-11-30';
      const pred = h.analytics.getPredictionDay(nextMon);
      assert.equal(pred.resolution, '15m');
      assert.equal(pred.confidence.matchedDaysCount, 4);
      const pt10 = pred.points.find((p) => p.slot15m === 10 * 4);
      assert.ok(pt10);
      assert.ok(pt10.parkings.bonlieu.p25 <= pt10.parkings.bonlieu.percentage);
      assert.ok(pt10.parkings.bonlieu.percentage <= pt10.parkings.bonlieu.p75);

      const rec = h.analytics.getArrivalRecommendation(nextMon, '14:00');
      assert.equal(rec.hasData, true);
      assert.equal(rec.rankings[0].parkingKey, 'courier');

      // 2. Test Intraday Nowcasting on today (2026-11-23 at 10:00 when Bonlieu is +20 pts higher than typical)
      const now10 = new Date(parisWallClockToIso(baseMonday, 10, 0));
      const basePredToday = h.analytics.getPredictionDay(baseMonday, { now: now10 });
      const nowcastPredToday = h.analytics.getPredictionDay(baseMonday, {
        now: now10,
        liveParkings: {
          bonlieu: { status: 'available', percentage: 75 }
        }
      });
      const base12 = basePredToday.points.find((p) => p.slot15m === 12 * 4).parkings.bonlieu.percentage;
      const nowcast12 = nowcastPredToday.points.find((p) => p.slot15m === 12 * 4).parkings.bonlieu;
      assert.equal(nowcast12.isNowcast, true);
      assert.ok(nowcast12.percentage > base12);

      // 3. Test Insights (dataset, backtesting MAE, turnover, spillover) & 7x24 heatmap tiers
      const insights = h.analytics.getInsightsOverview(now10);
      assert.equal(insights.dataset.distinctDays, 4);
      assert.ok(insights.backtesting.evaluatedDays >= 2);
      assert.ok(insights.backtesting.maePct !== null);
      assert.ok(insights.turnoverByParking.bonlieu.avgMovesPerHour > 0);
      const couSpill = insights.spilloverByParking.bonlieu.find((s) => s.alternativeKey === 'courier');
      assert.ok(couSpill);
      assert.equal(couSpill.stillAvailableRate, 100);
      assert.equal(couSpill.medianLagMinutes, 45);

      const profile = h.analytics.getParkingProfile7x24('bonlieu');
      const monRow = profile.nonHolidayTable.find((r) => r.weekday === 1);
      const aftSlot = monRow.slots.find((s) => s.id === 'afternoon');
      assert.equal(aftSlot.tier, 'low');
      assert.ok(profile.weekdayPeaks.includes('14h'));
    } finally {
      h.cleanup();
    }
  });
});
