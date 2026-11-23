const fs = require('fs');
const path = require('path');
const express = require('express');
const { Eta } = require('eta');
const {
  PARKINGS_LIST,
  getParkingBySlug,
  getTotalCapacity,
  getAvailabilityTier,
  formatEvLiveBadge,
  formatEvLiveDetail
} = require('../../data/parkings');
const { attachEvLiveToParkings } = require('../ev-collector');
const { getCurrentTimeSlotId } = require('../analytics');
const { HOME_FAQS, buildParkingFaqs } = require('../../data/faqs');
const {
  formatFrenchDate,
  getParisParts,
  shiftDayKey
} = require('../time');
const {
  buildHomeJsonLd,
  buildParkingJsonLd,
  buildRobotsTxt,
  buildSitemapXml,
  safeJsonLd
} = require('../seo');

function buildFallbackParkingState(meta) {
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
    lastUpdate: '--:--:--',
    stale: true,
    error: 'Chargement initial en cours',
    zone: meta.zone,
    zoneKey: meta.zoneKey,
    lat: meta.lat,
    lng: meta.lng,
    maxHeightMeters: meta.maxHeightMeters,
    pmrSpots: meta.pmrSpots,
    evChargers: meta.evChargers,
    evLive: null,
    address: meta.address,
    navigation: meta.navigation
  };
}

function buildClientBootstrapState({
  pageType,
  focusedParkingKey = null,
  paris,
  snapshot,
  holidayContext,
  weather = null,
  historyToday,
  todayOverlay = null,
  typical,
  eta
}) {
  const parkingsMeta = Object.fromEntries(
    PARKINGS_LIST.map((p) => [
      p.key,
      {
        key: p.key,
        slug: p.slug,
        name: p.name,
        shortName: p.shortName,
        maxCapacity: p.maxCapacity,
        lat: p.lat,
        lng: p.lng,
        zone: p.zone,
        zoneKey: p.zoneKey,
        chartStyle: p.chartStyle
      }
    ])
  );

  return {
    pageType,
    focusedParkingKey,
    parisDayKey: paris.dayKey,
    parisHour: paris.hour,
    parisWeekday: paris.weekday,
    parisTime: snapshot.parisTime || paris.timeLabel,
    timestamp: snapshot.timestamp,
    stale: Boolean(snapshot.stale),
    holidayContext,
    weather,
    parkingsMeta,
    parkings: snapshot.parkings,
    historyToday,
    todayOverlay,
    typical,
    eta
  };
}

function createPagesRouter({
  config,
  dbStore,
  collector,
  evCollector = null,
  weatherService = null,
  analytics,
  holidayService,
  assetsResolver
}) {
  const router = express.Router();
  const viewsDir = path.join(config.rootDir, 'src', 'views');
  const etaEngine = new Eta({
    views: viewsDir,
    cache: config.isProduction,
    autoEscape: true
  });

  function renderView(res, templateName, model, statusCode = 200) {
    const assets = assetsResolver.resolve();
    const html = etaEngine.render(templateName, {
      ...model,
      nonce: res.locals.nonce,
      assets,
      baseUrl: config.publicBaseUrl,
      safeJsonLd,
      getAvailabilityTier,
      formatEvLiveBadge,
      formatEvLiveDetail
    });
    res.status(statusCode).type('text/html; charset=utf-8').send(html);
  }

  function getSnapshotSafe() {
    const evByParking = evCollector ? evCollector.getCachedSnapshot().byParking : null;
    const cached = collector.getCachedOrDbSnapshot();
    if (cached && cached.parkings && Object.keys(cached.parkings).length > 0) {
      return {
        ...cached,
        parkings: attachEvLiveToParkings(cached.parkings, evByParking)
      };
    }

    const fallbackParkings = Object.fromEntries(
      PARKINGS_LIST.map((p) => [p.key, buildFallbackParkingState(p)])
    );
    return {
      timestamp: null,
      parisTime: '--:--:--',
      stale: true,
      parkings: attachEvLiveToParkings(fallbackParkings, evByParking)
    };
  }

  router.get('/robots.txt', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.type('text/plain; charset=utf-8').send(buildRobotsTxt(config.publicBaseUrl));
  });

  router.get('/sitemap.xml', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    const lastModIso = dbStore.getLastSampledAtIso();
    res.type('application/xml; charset=utf-8').send(
      buildSitemapXml({
        baseUrl: config.publicBaseUrl,
        parkings: PARKINGS_LIST,
        lastModIso
      })
    );
  });

  router.get('/site.webmanifest', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.type('application/manifest+json; charset=utf-8').json({
      name: "AnnecyPark — Parkings d'Annecy en temps réel",
      short_name: 'AnnecyPark',
      description: "Places disponibles en direct, prévisions d'affluence et itinéraires pour les parkings du centre-ville d'Annecy.",
      lang: 'fr',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: '#FFFFFF',
      theme_color: '#146C43',
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
      ]
    });
  });

  const swTemplatePath = path.join(config.rootDir, 'src', 'sw.js');
  let cachedSwTemplate = null;

  router.get('/sw.js', (req, res) => {
    const assets = assetsResolver.resolve();
    if (!cachedSwTemplate || !config.isProduction) {
      cachedSwTemplate = fs.readFileSync(swTemplatePath, 'utf8');
    }
    const renderedSw = cachedSwTemplate
      .replace("/* __ANNECYPARK_CACHE_VERSION__ */ 'v2'", JSON.stringify(assets.swVersion || 'v2'))
      .replace('/* __ANNECYPARK_PRECACHE__ */ []', JSON.stringify(assets.swAssets || []));

    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Service-Worker-Allowed', '/');
    res.type('application/javascript; charset=utf-8').send(renderedSw);
  });

  router.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    const now = new Date();
    const paris = getParisParts(now);
    const snapshot = getSnapshotSafe();
    const holidayContext = holidayService.getHolidayInfo(paris.dayKey);
    const weather = weatherService ? weatherService.getCurrentWeather(now) : null;
    const historyToday = analytics.getDayHistory(paris.dayKey);
    const todayOverlay = analytics.getTodayOverlay(now, snapshot.parkings);
    const typical = analytics.getTypicalStatsAll(paris.hour, paris.weekday);
    const eta = analytics.getEtaFullAll(now);
    const insights = analytics.getInsightsOverview(now);

    const cards = PARKINGS_LIST.map((meta) => ({
      meta,
      live: snapshot.parkings[meta.key] || buildFallbackParkingState(meta),
      eta: eta.byParking[meta.key]
    }));

    const totalAvailable = cards.reduce((acc, c) => acc + (c.live.status !== 'error' ? c.live.available : 0), 0);
    const totalCapacity = getTotalCapacity();

    const yesterdayKey = shiftDayKey(paris.dayKey, -1);
    const tomorrowKey = shiftDayKey(paris.dayKey, 1);
    const daysUntilSaturday = (6 - paris.weekday + 7) % 7 || 7;
    const nextSaturdayKey = shiftDayKey(paris.dayKey, daysUntilSaturday);
    const nextSundayKey = shiftDayKey(nextSaturdayKey, 1);

    const canonicalUrl = `${config.publicBaseUrl}/`;
    const jsonLd = buildHomeJsonLd({
      baseUrl: config.publicBaseUrl,
      parkings: PARKINGS_LIST,
      faqs: HOME_FAQS
    });

    const bootstrapState = buildClientBootstrapState({
      pageType: 'home',
      paris,
      snapshot,
      holidayContext,
      weather,
      historyToday,
      todayOverlay,
      typical,
      eta
    });

    renderView(res, 'home', {
      title: "Parkings d'Annecy en temps réel : places disponibles et prévisions | AnnecyPark",
      metaDescription: "Consultez en temps réel les places libres dans les parkings d'Annecy (Bonlieu, Courier, Hôtel de Ville, Poste, Sainte-Claire), prévisions et itinéraires.",
      canonicalUrl,
      ogType: 'website',
      ogTitle: "Parkings d'Annecy en temps réel — AnnecyPark",
      ogImageAlt: "AnnecyPark : disponibilité en temps réel et prévisions des 5 parkings du centre-ville d'Annecy",
      robotsDirective: 'index, follow',
      pageType: 'home',
      paris,
      snapshot,
      holidayContext,
      weather,
      cards,
      totalAvailable,
      totalCapacity,
      typical,
      eta,
      insights,
      historyToday,
      todayOverlay,
      dateShortcuts: {
        todayKey: paris.dayKey,
        yesterdayKey,
        weekAgoKey: shiftDayKey(paris.dayKey, -7),
        tomorrowKey,
        nextSaturdayKey,
        nextSundayKey,
        maxPredictionKey: shiftDayKey(paris.dayKey, 90),
        formattedToday: formatFrenchDate(paris.dayKey)
      },
      allParkings: PARKINGS_LIST,
      faqs: HOME_FAQS,
      jsonLd,
      bootstrapStateJson: safeJsonLd(bootstrapState)
    });
  });

  router.get('/parking/:slug', (req, res, next) => {
    const parking = getParkingBySlug(req.params.slug);
    if (!parking) {
      next();
      return;
    }

    res.setHeader('Cache-Control', 'no-cache');
    const now = new Date();
    const paris = getParisParts(now);
    const snapshot = getSnapshotSafe();
    const holidayContext = holidayService.getHolidayInfo(paris.dayKey);
    const weather = weatherService ? weatherService.getCurrentWeather(now) : null;
    const historyToday = analytics.getDayHistory(paris.dayKey);
    const todayOverlay = analytics.getTodayOverlay(now, snapshot.parkings);
    const typical = analytics.getTypicalStatsAll(paris.hour, paris.weekday);
    const eta = analytics.getEtaFullAll(now);
    const profile = analytics.getParkingProfile7x24(parking.key);
    const currentSlotId = getCurrentTimeSlotId(paris.hour);

    const live = snapshot.parkings[parking.key] || buildFallbackParkingState(parking);
    const parkingEta = eta.byParking[parking.key];
    const parkingTypical = typical.byParking[parking.key];

    const alternativeCards = parking.alternatives
      .map((altSlug) => getParkingBySlug(altSlug))
      .filter(Boolean)
      .map((altMeta) => ({
        meta: altMeta,
        live: snapshot.parkings[altMeta.key] || buildFallbackParkingState(altMeta),
        eta: eta.byParking[altMeta.key]
      }));

    const faqs = buildParkingFaqs(parking);
    const canonicalUrl = `${config.publicBaseUrl}/parking/${parking.slug}`;
    const jsonLd = buildParkingJsonLd({
      baseUrl: config.publicBaseUrl,
      parking,
      faqs
    });

    const bootstrapState = buildClientBootstrapState({
      pageType: 'detail',
      focusedParkingKey: parking.key,
      paris,
      snapshot,
      holidayContext,
      weather,
      historyToday,
      todayOverlay,
      typical,
      eta
    });

    renderView(res, 'parking-detail', {
      title: `${parking.name} à Annecy : places libres en direct, tarifs et accès | AnnecyPark`,
      metaDescription: `Places libres en direct au ${parking.name} (${parking.streetAddress}, Annecy) : ${parking.maxCapacity} places, gabarit ${String(parking.maxHeightMeters).replace('.', ',')} m, tarifs et itinéraire.`,
      canonicalUrl,
      ogType: 'article',
      ogTitle: `${parking.name} (Annecy) — Places libres et infos pratiques`,
      ogImageAlt: `${parking.name} à Annecy : disponibilité en direct et prévisions sur AnnecyPark`,
      robotsDirective: 'index, follow',
      pageType: 'detail',
      paris,
      currentSlotId,
      snapshot,
      holidayContext,
      weather,
      parking,
      live,
      parkingEta,
      parkingTypical,
      profile,
      todayOverlay,
      alternativeCards,
      allParkings: PARKINGS_LIST,
      faqs,
      jsonLd,
      bootstrapStateJson: safeJsonLd(bootstrapState)
    });
  });

  // Custom 404 handler (noindex)
  router.use((req, res) => {
    if (req.path === '/api' || req.path.startsWith('/api/')) {
      res.status(404).json({ error: 'Ressource API introuvable.' });
      return;
    }

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, follow');

    renderView(
      res,
      '404',
      {
        title: 'Page introuvable (404) | AnnecyPark',
        metaDescription: 'La page demandée n’existe pas sur AnnecyPark.',
        canonicalUrl: null,
        ogType: 'website',
        ogTitle: 'Page introuvable | AnnecyPark',
        ogImageAlt: 'AnnecyPark',
        robotsDirective: 'noindex, follow',
        pageType: '404',
        allParkings: PARKINGS_LIST,
        paris: getParisParts(new Date()),
        snapshot: { stale: false, parisTime: '--:--:--' },
        jsonLd: null,
        bootstrapStateJson: null
      },
      404
    );
  });

  return router;
}

module.exports = {
  createPagesRouter
};
