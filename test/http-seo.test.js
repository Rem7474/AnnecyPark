const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getConfig } = require('../src/server/config');
const { HolidayService } = require('../src/server/holidays');
const { createDbStore } = require('../src/server/db');
const { createCollector } = require('../src/server/collector');
const { createEvCollector } = require('../src/server/ev-collector');
const { createAnalytics } = require('../src/server/analytics');
const { createApp } = require('../src/server/app');

describe('HTTP, SSR, SEO, Security & Static Code Hygiene', () => {
  let tmpDir;
  let dbStore;
  let server;
  let baseUrl;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'annecy-http-'));
    const sqlitePath = path.join(tmpDir, 'http.db');
    const config = getConfig({
      sqlitePath,
      port: 0,
      nodeEnv: 'production',
      publicBaseUrl: 'https://park.remcorp.fr',
      adminToken: 'super-secret-admin-token-test',
      evStaticUrl: 'https://mock.local/ev-static',
      evDynamicUrl: 'https://mock.local/ev-dynamic'
    });

    const holidayService = new HolidayService({ autoFetch: false });
    dbStore = createDbStore({ sqlitePath, config, holidayService });
    const collector = createCollector({
      config,
      dbStore,
      fetcher: async (url) => ({
        ok: true,
        text: async () => {
          const decoded = decodeURIComponent(url);
          if (decoded.includes('poi:parking:01')) {
            return JSON.stringify({ available: 31, occupied_PRM: 2 });
          }
          if (decoded.includes('poi:parking:10')) {
            return JSON.stringify({ available: 0, occupied_PRM: null });
          }
          return JSON.stringify({ available: 180, occupied_PRM: null });
        }
      })
    });

    const mockStaticEvCsv = [
      'id_station_itinerance,id_pdc_itinerance,puissance_nominale',
      ...Array.from({ length: 11 }, (_, i) => `FR0NXPOOLHFX48,FR0NXBON${i + 1},22.08`),
      ...Array.from({ length: 8 }, (_, i) => `FR0NXPOOLTFNT9,FR0NXPOS${i + 1},22.08`),
      ...Array.from({ length: 6 }, (_, i) => `FR0NXPOOLPJ9A3,FR0NXHDV${i + 1},22.08`)
    ].join('\n');
    const mockDynEvCsv = [
      'id_pdc_itinerance,etat_pdc,occupation_pdc,horodatage',
      ...Array.from({ length: 4 }, (_, i) => `FR0NXBON${i + 1},en_service,libre,2026-11-23T14:20:00Z`),
      'FR0NXBON5,hors_service,occupe,2026-11-23T14:28:00Z',
      ...Array.from({ length: 6 }, (_, i) => `FR0NXBON${i + 6},en_service,occupe,2026-11-23T14:15:00Z`),
      ...Array.from({ length: 7 }, (_, i) => `FR0NXPOS${i + 1},en_service,libre,2026-11-23T14:08:00Z`),
      'FR0NXPOS8,en_service,occupe,2026-11-23T14:00:00Z',
      ...Array.from({ length: 5 }, (_, i) => `FR0NXHDV${i + 1},en_service,libre,2026-11-23T14:21:00Z`),
      'FR0NXHDV6,en_service,occupe,2026-11-23T14:10:00Z'
    ].join('\n');

    const evCollector = createEvCollector({
      config,
      fetcher: async (url) => ({
        ok: true,
        text: async () => (url.includes('ev-static') ? mockStaticEvCsv : mockDynEvCsv)
      })
    });

    await Promise.all([
      collector.getLiveSnapshot({ force: true }),
      evCollector.getSnapshot({ force: true })
    ]);
    const analytics = createAnalytics({ dbStore, config, holidayService });
    const app = createApp({ config, dbStore, collector, evCollector, analytics, holidayService });

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (dbStore) {
      dbStore.close();
    }
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('serves full SSR home page with SEO metadata, JSON-LD, CSP nonce and Hotel de Ville Presque complet', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-security-policy')?.includes("object-src 'none'"));
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');

    const html = await res.text();
    assert.ok(html.includes('<html lang="fr">'));
    assert.ok(html.includes('Parkings d’Annecy en temps réel'));
    assert.ok(html.includes('Parking Hôtel de Ville'));
    assert.ok(html.includes('Presque complet'));
    assert.ok(html.includes('Complet'));
    assert.ok(!html.includes('Chargement des données...'));
    assert.ok(html.includes('<script type="application/ld+json">'));
    assert.ok(html.includes('FAQPage'));
    assert.ok(html.includes('/parking/bonlieu'));
    assert.ok(html.includes('/parking/sainte-claire'));
    assert.ok(html.includes('4 / 11 bornes EV libres · 1 hors service'));
    assert.ok(html.includes('7 / 8 bornes EV libres'));
    assert.ok(html.includes('5 / 6 bornes EV libres'));
    assert.ok(html.includes('16 bornes EV'));
    assert.ok(html.includes('30 vélos'));
    assert.ok(html.includes('NEXTENEO'));
    assert.ok(html.includes('11 bornes électriques'));
    assert.ok(!html.includes('12 bornes électriques'));
    assert.ok(html.includes('data-availability-tier="low"'));
    assert.ok(html.includes('data-availability-tier="high"'));
    assert.ok(html.includes('data-availability-tier="critical"'));
    assert.ok(html.includes('data-availability-tier="full"'));
  });

  it('renders all 5 /parking/:slug detail pages with ParkingFacility JSON-LD and concise meta descriptions', async () => {
    const slugs = ['bonlieu', 'courier', 'hotel-de-ville', 'poste', 'sainte-claire'];
    for (const slug of slugs) {
      const res = await fetch(`${baseUrl}/parking/${slug}`);
      assert.equal(res.status, 200, `Expected 200 for /parking/${slug}`);
      const html = await res.text();
      assert.ok(html.includes('ParkingFacility'), `Missing ParkingFacility JSON-LD on /parking/${slug}`);
      assert.ok(html.includes('BreadcrumbList'));
      assert.ok(html.includes('google.com/maps/dir'));
      assert.ok(html.includes('waze.com/ul'));
      assert.ok(html.includes('places réservées PMR'));
      assert.ok(html.includes('Vacances scolaires Zone A (disponibilité moyenne en %)'));
      if (slug === 'bonlieu') {
        assert.ok(html.includes('4 / 11 bornes EV libres · 1 hors service'));
        assert.ok(html.includes('4 / 11 bornes EV libres (6 occupées · 1 hors service) · Type 2 jusqu’à 22 kW · temps réel NEXTENEO'));
        assert.ok(html.includes('11 points de charge'));
        assert.ok(!html.includes('12 points de charge'));
        assert.ok(html.includes('data-heat-tier="'));
      }

      const descMatch = /<meta name="description" content="([^"]+)">/.exec(html);
      assert.ok(descMatch && descMatch[1].length <= 160, `Meta description > 160 chars on /parking/${slug}: ${descMatch?.[1]?.length}`);
    }
  });

  it('prevents open redirects on // paths, redirects /index.html and trailing slashes, and omits canonical on 404', async () => {
    const idxRes = await fetch(`${baseUrl}/index.html`, { redirect: 'manual' });
    assert.equal(idxRes.status, 301);
    assert.equal(idxRes.headers.get('location'), '/');

    const idxSlashRes = await fetch(`${baseUrl}/index.html/`, { redirect: 'manual' });
    assert.equal(idxSlashRes.status, 301);
    assert.equal(idxSlashRes.headers.get('location'), '/');

    const slashRes = await fetch(`${baseUrl}/parking/bonlieu/`, { redirect: 'manual' });
    assert.equal(slashRes.status, 301);
    assert.equal(slashRes.headers.get('location'), '/parking/bonlieu');

    const evilRes = await fetch(`${baseUrl}//evil.com/`, { redirect: 'manual' });
    assert.equal(evilRes.status, 301);
    assert.equal(evilRes.headers.get('location'), '/evil.com');

    const multiSlashRes = await fetch(`${baseUrl}///`, { redirect: 'manual' });
    assert.equal(multiSlashRes.status, 301);
    assert.equal(multiSlashRes.headers.get('location'), '/');

    const notFoundRes = await fetch(`${baseUrl}/parking/inconnu`);
    assert.equal(notFoundRes.status, 404);
    assert.equal(notFoundRes.headers.get('x-robots-tag'), 'noindex, follow');
    const html404 = await notFoundRes.text();
    assert.ok(html404.includes('noindex'));
    assert.ok(!html404.includes('rel="canonical"'));
    assert.ok(!html404.includes('property="og:url"'));

    const apiPrefixPageRes = await fetch(`${baseUrl}/apifoo`);
    assert.equal(apiPrefixPageRes.status, 404);
    assert.ok(apiPrefixPageRes.headers.get('content-type')?.includes('text/html'));
  });

  it('serves dynamic robots.txt, sitemap.xml, site.webmanifest and sw.js with precached Vite assets', async () => {
    const robots = await (await fetch(`${baseUrl}/robots.txt`)).text();
    assert.ok(robots.includes('Disallow: /api/'));
    assert.ok(robots.includes('https://park.remcorp.fr/sitemap.xml'));

    const sitemapRes = await fetch(`${baseUrl}/sitemap.xml`);
    assert.equal(sitemapRes.status, 200);
    const sitemap = await sitemapRes.text();
    assert.ok(sitemap.includes('https://park.remcorp.fr/'));
    assert.ok(sitemap.includes('https://park.remcorp.fr/parking/bonlieu'));
    assert.ok(sitemap.includes('<lastmod>'));

    const manifestRes = await fetch(`${baseUrl}/site.webmanifest`);
    assert.equal(manifestRes.status, 200);
    const manifest = await manifestRes.json();
    assert.equal(manifest.display, 'standalone');

    const swRes = await fetch(`${baseUrl}/sw.js`);
    assert.equal(swRes.status, 200);
    assert.equal(swRes.headers.get('service-worker-allowed'), '/');
    const swText = await swRes.text();
    assert.ok(swText.includes("url.pathname === '/site.webmanifest'"));

    const distManifestPath = path.resolve(__dirname, '..', 'public', 'dist', 'manifest.json');
    if (fs.existsSync(distManifestPath)) {
      const distManifest = JSON.parse(fs.readFileSync(distManifestPath, 'utf8'));
      const entry = distManifest['src/client/main.js'];
      assert.ok(swText.includes(`/dist/${entry.file}`));
      assert.ok(swText.includes(`/dist/${entry.css[0]}`));
    }
  });

  it('serves /api/dashboard with stable ETag 304 (including W/ tags), validates strict queries, and protects POST cleanup', async () => {
    const dashRes = await fetch(`${baseUrl}/api/dashboard`);
    assert.equal(dashRes.status, 200);
    const etag = dashRes.headers.get('etag');
    assert.ok(etag);
    const body = await dashRes.json();
    assert.ok(body.parkings.bonlieu);
    assert.equal(body.parkings.bonlieu.evLive.available, 4);
    assert.equal(body.parkings.bonlieu.evLive.total, 11);
    assert.equal(body.parkings.bonlieu.evLive.outOfService, 1);
    assert.equal(body.parkings.courier.evLive, null);
    assert.ok(body.eta.byParking.hotelDeVille);

    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.ev.enabled, true);
    assert.deepEqual(health.ev.trackedParkings, ['bonlieu', 'hotelDeVille', 'poste']);
    assert.ok(body.todayOverlay);

    const predRes = await fetch(`${baseUrl}/api/prediction/day?date=2026-11-24`);
    assert.equal(predRes.status, 200);
    const predBody = await predRes.json();
    assert.equal(predBody.resolution, '15m');
    assert.ok(predBody.confidence);

    const recRes = await fetch(`${baseUrl}/api/prediction/recommend?date=2026-11-24&time=14:00`);
    assert.equal(recRes.status, 200);
    const recBody = await recRes.json();
    assert.equal(recBody.rankings.length, 5);

    const badTimeRes = await fetch(`${baseUrl}/api/prediction/recommend?date=2026-11-24&time=29:00`);
    assert.equal(badTimeRes.status, 400);

    const insightsRes = await fetch(`${baseUrl}/api/insights`);
    assert.equal(insightsRes.status, 200);
    const insightsBody = await insightsRes.json();
    assert.ok(insightsBody.dataset);
    assert.ok(insightsBody.backtesting);
    assert.ok(insightsBody.turnoverByParking);
    assert.ok(insightsBody.spilloverByParking);

    await new Promise((r) => setTimeout(r, 1050));

    const notModRes = await fetch(`${baseUrl}/api/dashboard`, {
      headers: { 'If-None-Match': `W/${etag}` }
    });
    assert.equal(notModRes.status, 304);

    const multiTagNotMod = await fetch(`${baseUrl}/api/dashboard`, {
      headers: { 'If-None-Match': `"other-tag", ${etag}` }
    });
    assert.equal(multiTagNotMod.status, 304);

    const badHourRes = await fetch(`${baseUrl}/api/stats/typical?hour=12abc`);
    assert.equal(badHourRes.status, 400);

    const malformedJsonRes = await fetch(`${baseUrl}/api/history/cleanup-anomalies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad-json'
    });
    assert.equal(malformedJsonRes.status, 400);
    const malformedJson = await malformedJsonRes.json();
    assert.equal(malformedJson.error, 'Requête JSON invalide.');

    // Unauthenticated POST rejected
    const unauthRes = await fetch(`${baseUrl}/api/history/cleanup-anomalies`, { method: 'POST' });
    assert.equal(unauthRes.status, 401);

    // Wrong token rejected
    const badRes = await fetch(`${baseUrl}/api/history/cleanup-anomalies`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-token' }
    });
    assert.equal(badRes.status, 403);

    // Valid token accepted
    const okRes = await fetch(`${baseUrl}/api/history/cleanup-anomalies`, {
      method: 'POST',
      headers: { Authorization: 'Bearer super-secret-admin-token-test' }
    });
    assert.equal(okRes.status, 200);
    const okJson = await okRes.json();
    assert.equal(okJson.status, 'ok');
  });

  it('contains zero innerHTML in client JS, zero inline style= in Eta, and zero data: URLs in built CSS', () => {
    const rootDir = path.resolve(__dirname, '..');
    const clientDir = path.join(rootDir, 'src', 'client');
    for (const file of fs.readdirSync(clientDir)) {
      if (file.endsWith('.js')) {
        const src = fs.readFileSync(path.join(clientDir, file), 'utf8');
        assert.ok(!/\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML/.test(src), `Unsafe DOM sink in ${file}`);
      }
    }

    function walkEta(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkEta(full);
        } else if (entry.name.endsWith('.eta')) {
          const tpl = fs.readFileSync(full, 'utf8');
          assert.ok(!/\sstyle\s*=/i.test(tpl), `Inline style= attribute found in ${full}`);
        }
      }
    }
    walkEta(path.join(rootDir, 'src', 'views'));

    const assetsDir = path.join(rootDir, 'public', 'dist', 'assets');
    if (fs.existsSync(assetsDir)) {
      for (const file of fs.readdirSync(assetsDir)) {
        if (file.endsWith('.css')) {
          const css = fs.readFileSync(path.join(assetsDir, file), 'utf8');
          assert.ok(!/data:font\/|data:application\/font/i.test(css), `Inlined font data URI found in ${file}`);
          assert.ok(css.includes('Manrope Variable'), 'Manrope Variable missing from built CSS');
          assert.ok(!css.includes('JetBrains Mono'), 'JetBrains Mono must not be bundled in flat design');
          assert.ok(!css.includes('Newsreader'), 'Newsreader must not be bundled in flat design');
          assert.ok(!/box-shadow/i.test(css), 'box-shadow must not be present in flat design');
        }
      }
    }

    const mainCss = fs.readFileSync(path.join(clientDir, 'styles', 'main.css'), 'utf8');
    assert.ok(!/999px/.test(mainCss), 'Pill 999px border-radius must not be present');
    assert.ok(!/backdrop-filter/i.test(mainCss), 'backdrop-filter must not be present');
    assert.ok(!/linear-gradient|radial-gradient/i.test(mainCss), 'CSS gradients must not be present');
    assert.ok(!/box-shadow/i.test(mainCss), 'box-shadow must not be present');

    const ogPath = path.join(rootDir, 'public', 'og-image.png');
    assert.ok(fs.existsSync(ogPath), 'public/og-image.png must exist');
    assert.ok(fs.statSync(ogPath).size < 100 * 1024, 'public/og-image.png must be < 100 KB');
  });
});
