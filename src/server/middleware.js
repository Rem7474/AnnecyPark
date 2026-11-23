const crypto = require('crypto');
const path = require('path');
const express = require('express');
const compression = require('compression');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

function buildHelmetMiddleware(isHttps) {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", (_req, res) => `'nonce-${res.locals.nonce}'`, "'strict-dynamic'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        workerSrc: ["'self'"],
        manifestSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        ...(isHttps ? { upgradeInsecureRequests: [] } : {})
      }
    },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    strictTransportSecurity: isHttps
      ? { maxAge: 31536000, includeSubDomains: true }
      : false
  });
}

function applySecurityAndCoreMiddleware(app, config) {
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(compression());
  app.use(express.json({ limit: '16kb' }));

  const helmetHttp = buildHelmetMiddleware(false);
  const helmetHttps = buildHelmetMiddleware(true);

  // Generate per-request CSP nonce before Helmet runs
  app.use((req, res, next) => {
    res.locals.nonce = crypto.randomBytes(16).toString('base64');
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(self)'
    );

    const isHttps = req.secure || req.get('x-forwarded-proto') === 'https';
    (isHttps ? helmetHttps : helmetHttp)(req, res, next);
  });

  // Canonical URL normalization: collapse repeated slashes, /index.html -> /, strip trailing slashes on GET/HEAD
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }

    const querySuffix = req.originalUrl.includes('?')
      ? req.originalUrl.slice(req.originalUrl.indexOf('?'))
      : '';

    let normalized = req.path.replace(/\/+/g, '/');
    if (normalized.length > 1) {
      normalized = normalized.replace(/\/+$/, '') || '/';
    }
    if (normalized === '/index.html') {
      normalized = '/';
    }

    if (normalized !== req.path) {
      const safeTarget = normalized.startsWith('//')
        ? `/${normalized.replace(/^\/+/, '')}`
        : normalized;
      res.redirect(301, `${safeTarget}${querySuffix}`);
      return;
    }

    next();
  });

  // Immutable long cache for hashed Vite build assets
  app.use(
    '/dist',
    express.static(path.join(config.rootDir, 'public', 'dist'), {
      immutable: true,
      maxAge: '1y',
      index: false
    })
  );

  // Static files for icons & og-image (sw.js, robots.txt, sitemap.xml, site.webmanifest are handled explicitly)
  app.use(
    express.static(path.join(config.rootDir, 'public'), {
      index: false,
      maxAge: '1d'
    })
  );

  // Restricted CORS only for /api/*
  const corsOptions = {
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }
      const normalized = origin.replace(/\/+$/, '');
      if (config.allowedOrigins.includes(normalized)) {
        callback(null, true);
        return;
      }
      const err = new Error('Origin not allowed by CORS');
      err.status = 403;
      callback(err);
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'If-None-Match']
  };

  app.use('/api', cors(corsOptions));

  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: (req) => req.path === '/health'
  });

  app.use('/api', apiLimiter);
}

const cleanupRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many cleanup requests. Try again later.' }
});

module.exports = {
  applySecurityAndCoreMiddleware,
  cleanupRateLimiter
};
