const express = require('express');
const { applySecurityAndCoreMiddleware } = require('./middleware');
const { createAssetsResolver } = require('./assets');
const { createApiRouter } = require('./routes/api');
const { createPagesRouter } = require('./routes/pages');

function createApp({
  config,
  dbStore,
  collector,
  evCollector = null,
  weatherService = null,
  analytics,
  holidayService
}) {
  const app = express();
  const assetsResolver = createAssetsResolver(config.rootDir);

  applySecurityAndCoreMiddleware(app, config);

  app.use('/api', createApiRouter({
    config,
    dbStore,
    collector,
    evCollector,
    weatherService,
    analytics,
    holidayService
  }));

  app.use('/', createPagesRouter({
    config,
    dbStore,
    collector,
    evCollector,
    weatherService,
    analytics,
    holidayService,
    assetsResolver
  }));

  // Global error handler (no stack/error message leakage)
  app.use((err, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }

    const rawStatus = err && Number.isInteger(err.status)
      ? err.status
      : (err && Number.isInteger(err.statusCode) ? err.statusCode : 500);
    const status = rawStatus >= 400 && rawStatus < 600 ? rawStatus : 500;

    if (status >= 500) {
      console.error('Unhandled Express error:', err);
    }

    const isApiRequest = req.path === '/api' || req.path.startsWith('/api/');
    if (isApiRequest) {
      let apiError = 'Erreur interne du serveur.';
      if (status === 400) {
        apiError = 'Requête JSON invalide.';
      } else if (status === 403) {
        apiError = 'Origine non autorisée.';
      } else if (status === 413) {
        apiError = 'Corps de requête trop volumineux.';
      }
      res.status(status).json({ error: apiError });
      return;
    }

    let pageError = 'Une erreur interne est survenue.';
    if (status === 400) {
      pageError = 'Requête invalide.';
    } else if (status === 403) {
      pageError = 'Accès refusé.';
    } else if (status === 413) {
      pageError = 'Requête trop volumineuse.';
    }
    res.status(status).type('text/plain; charset=utf-8').send(pageError);
  });

  return app;
}

module.exports = {
  createApp
};
