# Parking Dashboard Annecy

Dashboard web en temps reel pour suivre la disponibilite des parkings d'Annecy avec historique journalier persiste en SQLite.

## Fonctionnalites

- Disponibilite en temps reel des parkings.
- Actualisation automatique toutes les 10 secondes.
- Historique journalier stocke en base SQLite (persistant).
- Courbe de disponibilite de la journee dans l'interface.
- Mode prediction par date choisie (courbe estimee), avec retour rapide au mode temps reel.
- API de stats horaires segmentees vacances scolaires / hors vacances.
- Nettoyage retroactif des anomalies (rejette les echantillons avec 0% de disponibilite), applique au demarrage et via endpoint manuel.

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

### GET /api/prediction/day?date=YYYY-MM-DD

Retourne une courbe journaliere estimee selon le contexte du jour choisi (jour de semaine + vacances scolaires).

Strategie de prediction:

- pondération par recence sur les memes jours de semaine:
  - semaine -1: 25% (avec semaine equivalente N-1)
  - semaine -2: 25%
  - semaine -3: 25%
  - semaine -4: 10%
  - semaine -5: 15%
- pour chaque bucket semaine -1 a -5, la valeur est calculee a partir de la semaine courante du bucket + la semaine equivalente en annee N-1
- re-normalisation automatique des poids quand certaines semaines n'ont pas de donnees
- filtration sur le contexte vacances/hors vacances

### GET /api/stats/eta-full?parkingKey=bonlieu

Retourne une estimation d'atteinte du seuil `<10%` selon deux approches:

- `tangent`: projection depuis la valeur actuelle avec une regression lineaire sur les 15 dernieres minutes (uniquement si la pente est negative)
- `nearestBelowThresholdStat`: valeur statistique `<10%` la plus proche de l'heure courante (si des donnees existent)

Le champ `hasPrediction` est `true` si au moins une des deux approches fournit une estimation.

### POST /api/history/cleanup-anomalies

Relance manuellement le nettoyage retroactif des anomalies (rejette les echantillons a 0%).

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
