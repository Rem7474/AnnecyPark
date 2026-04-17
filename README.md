# Parking Dashboard Annecy

Dashboard web en temps reel pour suivre la disponibilite des parkings d'Annecy avec historique journalier persiste en SQLite.

## Fonctionnalites

- Disponibilite en temps reel des parkings.
- Actualisation automatique toutes les 10 secondes.
- Historique journalier stocke en base SQLite (persistant).
- Courbe de disponibilite de la journee dans l'interface.
- API de stats horaires segmentees vacances scolaires / hors vacances.

## Lancer en local

### Prerequis

- Node.js 20+
- npm

### Commandes

```bash
npm install
npm start
```

Application disponible sur http://localhost:3000

## Lancer avec Docker Compose

```bash
docker compose up --build
```

- Application sur http://localhost:3000
- Base SQLite persistante dans le dossier `./data`

## API

### GET /api/parkings

Retourne l'etat courant des parkings et enregistre un echantillon en SQLite (max 1 echantillon/minute).

### GET /api/history/day?date=YYYY-MM-DD

Retourne l'historique de la journee:

```json
{
  "date": "2026-04-17",
  "points": [
    {
      "timestamp": "2026-04-17T10:31:00.000Z",
      "parkings": {
        "bonlieu": {
          "name": "Parking Bonlieu",
          "available": 245,
          "occupied": 407,
          "maxCapacity": 652,
          "percentage": 38
        }
      }
    }
  ]
}
```

### GET /api/stats/typical?parkingKey=bonlieu&hour=14&weekday=5

Retourne des stats horaires historiques pour un parking, avec segmentation:

- `schoolHoliday`
- `nonHoliday`

## Configuration

- `PORT` (defaut: `3000`)
- `SQLITE_PATH` (defaut: `./data/parking_history.db`)
- `TZ` (recommande: `Europe/Paris`)

## Structure

```
.
├── Dockerfile
├── docker-compose.yml
├── server.js
├── package.json
├── public/
│   ├── index.html
│   ├── styles.css
│   └── script.js
└── data/
    └── parking_history.db (cree automatiquement)
```
