const crypto = require('crypto');
const express = require('express');
const { getParkingByKey, getParkingBySlug } = require('../../data/parkings');
const { getParisParts, normalizeDayQuery } = require('../time');
const { cleanupRateLimiter } = require('../middleware');
const { attachEvLiveToParkings } = require('../ev-collector');

function safeTimingEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function normalizeEtagToken(token) {
  const trimmed = token.trim();
  if (trimmed.startsWith('W/') || trimmed.startsWith('w/')) {
    return trimmed.slice(2).trim();
  }
  return trimmed;
}

function matchesIfNoneMatch(headerValue, etag) {
  if (!headerValue) {
    return false;
  }
  const trimmed = headerValue.trim();
  if (trimmed === '*') {
    return true;
  }
  const target = normalizeEtagToken(etag);
  return trimmed
    .split(',')
    .map(normalizeEtagToken)
    .filter(Boolean)
    .includes(target);
}

function parseStrictInt(rawValue) {
  if (typeof rawValue !== 'string') {
    return Number.NaN;
  }
  const trimmed = rawValue.trim();
  if (!/^\d{1,2}$/.test(trimmed)) {
    return Number.NaN;
  }
  return Number.parseInt(trimmed, 10);
}

function sendJsonWithEtag(req, res, payload) {
  const body = JSON.stringify(payload);
  const etag = `"${crypto.createHash('sha1').update(body).digest('base64url')}"`;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('ETag', etag);

  const ifNoneMatch = req.get('If-None-Match');
  if (matchesIfNoneMatch(ifNoneMatch, etag)) {
    res.status(304).end();
    return;
  }

  res.type('application/json; charset=utf-8').send(body);
}

function createApiRouter({
  config,
  dbStore,
  collector,
  evCollector = null,
  weatherService = null,
  analytics,
  holidayService
}) {
  const router = express.Router();

  router.use((req, res, next) => {
    if (req.path !== '/parkings' && req.path !== '/insights' && !req.path.endsWith('/profile')) {
      res.setHeader('Cache-Control', 'no-store');
    }
    next();
  });

  router.get('/health', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    let dbOk = false;
    let latestSnapshotAt = null;
    try {
      dbOk = dbStore.healthCheck();
      latestSnapshotAt = dbStore.getLastSampledAtIso();
    } catch {
      dbOk = false;
    }

    const status = dbOk ? 200 : 503;
    res.status(status).json({
      status: dbOk ? 'ok' : 'degraded',
      uptimeSec: Math.round(process.uptime()),
      dbOk,
      latestSnapshotAt,
      holidays: holidayService.getStatus(),
      ev: evCollector ? evCollector.getStatus() : { enabled: false },
      weather: weatherService ? weatherService.getStatus() : { enabled: false }
    });
  });

  router.get('/dashboard', async (req, res) => {
    try {
      const now = new Date();
      const paris = getParisParts(now);
      const [snapshot, evSnapshot] = await Promise.all([
        collector.getLiveSnapshot(),
        evCollector ? evCollector.getSnapshot() : Promise.resolve(null)
      ]);
      const enrichedParkings = attachEvLiveToParkings(snapshot.parkings, evSnapshot?.byParking);
      const holidayContext = holidayService.getHolidayInfo(paris.dayKey);
      const historyToday = analytics.getDayHistory(paris.dayKey);
      const typical = analytics.getTypicalStatsAll(paris.hour, paris.weekday);
      const eta = analytics.getEtaFullAll(now, { timestamp: snapshot.timestamp });
      const weather = weatherService ? weatherService.getCurrentWeather(now) : null;
      const todayOverlay = analytics.getTodayOverlay(now, enrichedParkings);

      sendJsonWithEtag(req, res, {
        timestamp: snapshot.timestamp,
        parisTime: snapshot.parisTime,
        parisDayKey: paris.dayKey,
        holidayContext,
        weather,
        stale: snapshot.stale,
        parkings: enrichedParkings,
        historyToday,
        todayOverlay,
        typical,
        eta
      });
    } catch (error) {
      console.error('Failed to serve /api/dashboard:', error);
      res.status(500).json({ error: 'Impossible de charger le tableau de bord.' });
    }
  });

  router.get('/parkings', async (req, res) => {
    try {
      const [snapshot, evSnapshot] = await Promise.all([
        collector.getLiveSnapshot(),
        evCollector ? evCollector.getSnapshot() : Promise.resolve(null)
      ]);
      sendJsonWithEtag(req, res, {
        timestamp: snapshot.timestamp,
        parisTime: snapshot.parisTime,
        stale: snapshot.stale,
        parkings: attachEvLiveToParkings(snapshot.parkings, evSnapshot?.byParking)
      });
    } catch (error) {
      console.error('Failed to fetch parking data:', error);
      res.status(500).json({ error: 'Impossible de récupérer les données des parkings.' });
    }
  });

  router.get('/parkings/:slug/profile', (req, res) => {
    const parking = getParkingBySlug(req.params.slug);
    if (!parking) {
      res.status(404).json({ error: 'Parking introuvable.' });
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=300');
    const profile = analytics.getParkingProfile7x24(parking.key);
    res.json({
      parking: {
        key: parking.key,
        slug: parking.slug,
        name: parking.name,
        address: parking.address,
        lat: parking.lat,
        lng: parking.lng,
        maxCapacity: parking.maxCapacity,
        maxHeightMeters: parking.maxHeightMeters,
        pmrSpots: parking.pmrSpots,
        evChargers: parking.evChargers,
        zone: parking.zone
      },
      profile
    });
  });

  router.get('/history/day', (req, res) => {
    try {
      const dayKey = normalizeDayQuery(req.query.date);
      if (!dayKey) {
        res.status(400).json({ error: 'Format de date invalide. Utilisez AAAA-MM-JJ.' });
        return;
      }

      const history = analytics.getDayHistory(dayKey);
      res.setHeader('Cache-Control', 'no-store');
      res.json(history);
    } catch (error) {
      console.error('Failed to fetch day history:', error);
      res.status(500).json({ error: 'Impossible de récupérer l’historique.' });
    }
  });

  router.get('/stats/typical', (req, res) => {
    try {
      const parisNow = getParisParts(new Date());
      const hour = req.query.hour !== undefined ? parseStrictInt(req.query.hour) : parisNow.hour;
      const weekday = req.query.weekday !== undefined ? parseStrictInt(req.query.weekday) : parisNow.weekday;

      if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
        res.status(400).json({ error: 'Heure invalide (0..23).' });
        return;
      }

      if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
        res.status(400).json({ error: 'Jour invalide (0..6).' });
        return;
      }

      const parkingKey = req.query.parkingKey;
      if (parkingKey) {
        if (!getParkingByKey(parkingKey)) {
          res.status(400).json({ error: 'Identifiant de parking invalide.' });
          return;
        }
        res.json(analytics.getTypicalStatsForParking(parkingKey, hour, weekday));
        return;
      }

      res.json(analytics.getTypicalStatsAll(hour, weekday));
    } catch (error) {
      console.error('Failed to compute typical stats:', error);
      res.status(500).json({ error: 'Impossible de calculer les statistiques.' });
    }
  });

  router.get('/stats/eta-full', (req, res) => {
    try {
      const parkingKey = req.query.parkingKey;
      const now = new Date();

      if (parkingKey) {
        if (!getParkingByKey(parkingKey)) {
          res.status(400).json({ error: 'Identifiant de parking invalide.' });
          return;
        }
        res.json(analytics.getEtaFullForParking(parkingKey, now));
        return;
      }

      res.json(analytics.getEtaFullAll(now));
    } catch (error) {
      console.error('Failed to compute ETA:', error);
      res.status(500).json({ error: 'Impossible d’estimer la saturation.' });
    }
  });

  router.get('/prediction/day', (req, res) => {
    try {
      const dayKey = normalizeDayQuery(req.query.date);
      if (!dayKey) {
        res.status(400).json({ error: 'Format de date invalide. Utilisez AAAA-MM-JJ.' });
        return;
      }

      const now = new Date();
      const cachedSnap = collector.getCachedOrDbSnapshot();
      res.json(analytics.getPredictionDay(dayKey, {
        now,
        liveParkings: cachedSnap?.parkings || null
      }));
    } catch (error) {
      console.error('Failed to compute day prediction:', error);
      res.status(500).json({ error: 'Impossible de calculer les prévisions.' });
    }
  });

  router.get('/prediction/recommend', (req, res) => {
    try {
      const dayKey = normalizeDayQuery(req.query.date);
      if (!dayKey) {
        res.status(400).json({ error: 'Format de date invalide. Utilisez AAAA-MM-JJ.' });
        return;
      }

      const rawTime = req.query.time !== undefined ? String(req.query.time).trim() : '14:00';
      if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(rawTime)) {
        res.status(400).json({ error: 'Format d’heure invalide. Utilisez HH:MM.' });
        return;
      }

      res.json(analytics.getArrivalRecommendation(dayKey, rawTime, new Date()));
    } catch (error) {
      console.error('Failed to compute arrival recommendation:', error);
      res.status(500).json({ error: 'Impossible de calculer la recommandation d’arrivée.' });
    }
  });

  router.get('/insights', (req, res) => {
    try {
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json(analytics.getInsightsOverview(new Date()));
    } catch (error) {
      console.error('Failed to compute historical insights:', error);
      res.status(500).json({ error: 'Impossible de charger les indicateurs historiques.' });
    }
  });

  router.post('/history/cleanup-anomalies', cleanupRateLimiter, (req, res) => {
    if (!config.adminToken) {
      res.status(503).json({ error: 'Endpoint d’administration désactivé (ADMIN_TOKEN non configuré).' });
      return;
    }

    const authHeader = req.get('Authorization') || '';
    const match = /^Bearer\s+(.+)$/i.exec(authHeader);
    if (!match) {
      res.status(401).json({ error: 'Authentification requise.' });
      return;
    }

    if (!safeTimingEqual(match[1].trim(), config.adminToken)) {
      res.status(403).json({ error: 'Jeton d’administration invalide.' });
      return;
    }

    try {
      const result = dbStore.cleanupHistoricalAnomalies();
      analytics.clearProfileCache();
      res.json({
        status: 'ok',
        deletedCount: result.deletedCount,
        rule: `Supprime les chutes isolées à 0 % (précédent > ${config.suspiciousZeroDropThresholdPoints} % sous 5 min)`
      });
    } catch (error) {
      console.error('Failed to cleanup anomalies:', error);
      res.status(500).json({ error: 'Échec du nettoyage des anomalies.' });
    }
  });

  return router;
}

module.exports = {
  createApiRouter
};
