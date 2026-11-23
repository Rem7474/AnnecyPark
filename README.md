<div align="center">

# 🅿️ AnnecyPark

**Ce parking sera-t-il plein quand vous arriverez ?**

Application web temps réel (SSR + PWA) de suivi de la disponibilité des parkings du centre-ville d’Annecy, avec fiches détaillées par parking, historique persistant en SQLite, itinéraires directs et prévisions d’affluence basées sur le calendrier scolaire officiel (Zone A).

### 👉 [**park.remcorp.fr**](https://park.remcorp.fr) 👈

</div>

## Fonctionnalités

- 🔄 **Disponibilité parkings & bornes EV en temps réel** via endpoint consolidé `GET /api/dashboard` (cache serveur TTL 10 s *single-flight* pour les places, flux IRVE NEXTENEO temps réel pour les bornes EV de Bonlieu, Hôtel de Ville et Poste, rafraîchissement client 20 s avec ETag & pause hors onglet)
- 🧭 **Fiches détaillées, Heatmaps 7×24 & itinéraires** : pages indexables `/parking/:slug` (`bonlieu`, `courier`, `hotel-de-ville`, `poste`, `sainte-claire`) avec gabarit maximal, places PMR, bornes EV en direct, heatmaps hebdomadaires colorées, rotation des places, report de saturation et liens directs Google Maps / Apple Plans / Waze
- 📶 **PWA & mode hors ligne** : Service Worker affichant les derniers relevés mémorisés lors des coupures réseau (tunnels, parkings souterrains)
- 📊 **Prévisions 15 min, *Nowcasting*, Météo & Assistant d’arrivée** : courbes SVG lisses (splines cubiques monotones), couloirs de confiance `P25–P75`, recalage temps réel (*nowcasting*), pondération météo horaire **Open-Meteo**, vacances Zone A (`data.education.gouv.fr`) + jours fériés & ponts (`calendrier.api.gouv.fr`), simulateur *« J’arrive vers… »* et auto-évaluation rétrospective (**MAE**)
- 🔒 **Sécurité & SEO** : SSR complet via `Eta`, design **Flat Utilitaire** (clair/sombre modulé par palier de disponibilité), CSP stricte par nonce (`helmet`), compression gzip/brotli, SQLite `WAL` (`better-sqlite3`), rétention 90 j avec agrégats 15 min, `Schema.org` JSON-LD, `/robots.txt` et `/sitemap.xml` dynamiques

## Lancer en local

### Prérequis

- Node.js 22+
- npm

### Commandes

```bash
npm install
npm run generate:assets
npm run build
npm start
```

Application disponible sur `http://localhost:3000`.

### Tests

```bash
npm test
```

### Avec Docker Compose

```bash
docker compose up --build
```

- Application sur `http://localhost:3000`
- Base SQLite persistante dans `./data`

## API principale

- `GET /api/health` : état du serveur, SQLite, calendrier Zone A / jours fériés, bornes EV NEXTENEO et météo Open-Meteo
- `GET /api/dashboard` : état complet temps réel (places + bornes EV + météo) + historique du jour + projection *nowcast* + stats typiques + ETA/vélocité (supporte `ETag`)
- `GET /api/parkings` : disponibilité courante des 5 parkings (places + bornes EV)
- `GET /api/parkings/:slug/profile` : profil heatmap 7×24, pics semaine/week-end, rotation et report de saturation
- `GET /api/history/day?date=YYYY-MM-DD` : courbe historique d’une journée
- `GET /api/prediction/day?date=YYYY-MM-DD` : prévision 15 min pondérée (`P25 / P50 / P75`, météo, vacances Zone A, jours fériés & *nowcasting*)
- `GET /api/prediction/recommend?date=YYYY-MM-DD&time=HH:MM` : classement des 5 parkings pour une heure d’arrivée cible
- `GET /api/insights` : couverture de la base historique, précision MAE (*backtesting*), vitesse de rotation et report de saturation
- `GET /api/stats/typical?hour=14&weekday=5` : stats typiques vacances vs hors vacances (global ou par `parkingKey`)
- `GET /api/stats/eta-full` : estimation de passage sous 10 %, probabilité de saturation, heure de libération et vélocité 15 min
- `POST /api/history/cleanup-anomalies` : nettoyage manuel protégé par `Authorization: Bearer <ADMIN_TOKEN>`

## Configuration

- `PORT` (défaut : `3000`)
- `SQLITE_PATH` (défaut : `./data/parking_history.db`)
- `HOLIDAY_CACHE_PATH` (défaut : `<dirname(SQLITE_PATH)>/holidays_zone_a_cache.json`)
- `PUBLIC_BASE_URL` (défaut : `https://park.remcorp.fr`)
- `ALLOWED_ORIGINS` (liste séparée par des virgules pour CORS `/api`)
- `ADMIN_TOKEN` (jeton Bearer requis pour `POST /api/history/cleanup-anomalies`)
- `TZ` (`Europe/Paris` recommandé ; tous les calculs horaires utilisent `Europe/Paris`)

## Structure

```text
.
├── Dockerfile
├── docker-compose.yml
├── server.js
├── vite.config.mjs
├── scripts/generate-assets.mjs
├── src/
│   ├── sw.js
│   ├── data/
│   │   ├── parkings.js
│   │   └── faqs.js
│   ├── server/
│   │   ├── app.js
│   │   ├── analytics.js
│   │   ├── assets.js
│   │   ├── collector.js
│   │   ├── ev-collector.js
│   │   ├── weather.js
│   │   ├── config.js
│   │   ├── db.js
│   │   ├── holidays.js
│   │   ├── middleware.js
│   │   ├── seo.js
│   │   ├── time.js
│   │   └── routes/
│   ├── views/
│   │   ├── layouts/base.eta
│   │   ├── partials/
│   │   ├── home.eta
│   │   ├── parking-detail.eta
│   │   └── 404.eta
│   └── client/
│       ├── main.js
│       ├── chart.js
│       ├── filters.js
│       ├── state.js
│       ├── tabs.js
│       ├── theme.js
│       └── styles/main.css
└── test/
```
