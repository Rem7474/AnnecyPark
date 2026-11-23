const { getConfig } = require('./src/server/config');
const { HolidayService } = require('./src/server/holidays');
const { createDbStore } = require('./src/server/db');
const { createCollector } = require('./src/server/collector');
const { createEvCollector } = require('./src/server/ev-collector');
const { createWeatherService } = require('./src/server/weather');
const { createAnalytics } = require('./src/server/analytics');
const { createApp } = require('./src/server/app');

async function startServer() {
  const config = getConfig();
  const holidayService = new HolidayService({
    cachePath: config.holidayCachePath
  });

  const dbStore = createDbStore({
    sqlitePath: config.sqlitePath,
    config,
    holidayService
  });

  // Startup maintenance before listening
  const rollupResult = dbStore.rollupAndPruneOldSamples(new Date());
  if (rollupResult.deletedRawRows > 0) {
    console.log(`SQLite rollup archived ${rollupResult.deletedRawRows} old sample(s) into ${rollupResult.rolledUpBuckets} 15-min bucket(s).`);
  }

  const cleanupResult = dbStore.cleanupHistoricalAnomalies();
  if (cleanupResult.deletedCount > 0) {
    console.log(`Historical anomaly cleanup removed ${cleanupResult.deletedCount} isolated drop(s).`);
  }

  await holidayService.init();
  console.log(`Zone A holidays initialized (${holidayService.getStatus().source}, ${holidayService.getStatus().periodCount} periods).`);

  const collector = createCollector({ config, dbStore });
  collector.hydrateFromDb();
  const evCollector = createEvCollector({ config });
  const weatherService = createWeatherService({ config, dbStore });

  // Prime live parking, EV, and weather snapshots before opening HTTP port
  const [livePrime] = await Promise.allSettled([
    collector.getLiveSnapshot({ force: true }),
    evCollector.getSnapshot({ force: true }),
    weatherService.refresh()
  ]);
  if (livePrime.status === 'rejected') {
    console.warn('Initial live prime failed, continuing with persisted cache:', livePrime.reason?.message || livePrime.reason);
  }

  const analytics = createAnalytics({ dbStore, config, holidayService, weatherService });
  const app = createApp({ config, dbStore, collector, evCollector, weatherService, analytics, holidayService });

  const server = app.listen(config.port, () => {
    console.log(`AnnecyPark server listening on http://localhost:${config.port}`);
    console.log(`Public base URL: ${config.publicBaseUrl}`);
    console.log(`SQLite database: ${config.sqlitePath}`);
  });

  collector.start();
  evCollector.start();
  weatherService.start();

  // Refresh holidays and run DB rollup once every 24h
  const maintenanceInterval = setInterval(() => {
    holidayService.refresh().catch((err) => console.warn('Holiday refresh error:', err.message));
    try {
      dbStore.rollupAndPruneOldSamples(new Date());
      analytics.clearProfileCache();
    } catch (err) {
      console.error('Daily rollup maintenance error:', err.message);
    }
  }, 24 * 60 * 60 * 1000);
  if (typeof maintenanceInterval.unref === 'function') {
    maintenanceInterval.unref();
  }

  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down gracefully...`);
    collector.stop();
    evCollector.stop();
    weatherService.stop();
    clearInterval(maintenanceInterval);

    server.close(() => {
      try {
        dbStore.close();
      } catch (err) {
        console.error('Error closing SQLite database:', err.message);
      }
      process.exit(0);
    });

    setTimeout(() => {
      try {
        dbStore.close();
      } catch {
        // ignore
      }
      process.exit(1);
    }, 5000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return { server, app, dbStore, collector, evCollector, weatherService, holidayService };
}

if (require.main === module) {
  startServer().catch((err) => {
    console.error('Fatal startup error:', err);
    process.exit(1);
  });
}

module.exports = {
  startServer
};
