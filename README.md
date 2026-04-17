# Parking Dashboard Annecy

Un dashboard web temps réel pour suivre la disponibilité des places de parking à Annecy.

## Features (Fonctionnalités)

✅ Affichage en temps réel de l'availability des parkings  
✅ Actualisation automatique toutes les 10 secondes  
✅ Interface responsive (mobile, tablet, desktop)  
✅ Indicateurs visuels clairs (disponible, modéré, complet)  
✅ Pourcentage d'occupation  
✅ Historical updates timestamp

## Parkings Suivis

1. **Parking Bonlieu** - Capacité max: 652 places
2. **Parking Courier** - Capacité max: 757 places
3. **Parking Hotel de Ville** - Capacité max: 408 places

## Installation

### Prérequis
- Node.js (version 14+)
- npm ou yarn

### Étapes d'installation

1. **Cloner/Accéder au projet**
```bash
cd c:\Code\APIparking
```

2. **Installer les dépendances**
```bash
npm install
```

3. **Démarrer le serveur**
```bash
npm start
```

4. **Ouvrir dans le navigateur**
```
http://localhost:3000
```

## Développement

Pour le développement avec rechargement automatique :
```bash
npm run dev
```

Cela utilisera `nodemon` pour relancer le serveur automatiquement lors des modifications.

## Architecture

### Backend (Node.js/Express)
- `server.js` - Serveur Express principal
  - Route `/api/parkings` - Endpoint API pour les données
  - Fetch automatique des données depuis les APIs Annecy Mobilités
  - CORS activé pour les requêtes frontend

### Frontend (HTML/CSS/JavaScript)
- `public/index.html` - Structure HTML
- `public/styles.css` - Styling moderne et responsive
- `public/script.js` - Logique frontend (fetch, autorefresh, UI)

## API

### GET /api/parkings

Retourne les données actuelles de tous les parkings en JSON.

**Response Example:**
```json
{
  "timestamp": "2026-04-17T10:30:45.123Z",
  "parkings": {
    "bonlieu": {
      "name": "Parking Bonlieu",
      "available": 245,
      "occupied": 407,
      "maxCapacity": 652,
      "percentage": 38,
      "lastUpdate": "10:30:45",
      "status": "available"
    },
    ...
  }
}
```

## Configuration

Les configurations des parkings sont dans `server.js` dans l'objet `parkings`:
- URLs des APIs
- Capacités maximales
- Noms d'affichage

## Dépannage

### Port déjà utilisé
Si le port 3000 est déjà utilisé, définissez PORT:
```bash
PORT=3001 npm start
```

### Erreurs CORS
Les erreurs CORS du frontend sont gérées. Le serveur inclut les headers CORS appropriés.

### Données non chargées
- Vérifiez que le serveur est en cours d'exécution (`localhost:3000`)
- Vérifiez les URLs des APIs dans `server.js`
- Consultez la console du navigateur pour les erreurs

## Structure des Dossiers

```
APIparking/
├── server.js           # Serveur Express
├── package.json        # Dépendances Node
├── README.md          # Ce fichier
├── .gitignore         # Git ignore
├── public/            # Fichiers statiques
│   ├── index.html     # Page principale
│   ├── styles.css     # Styles
│   └── script.js      # JavaScript frontend
└── .github/
    └── copilot-instructions.md  # Instructions de setup
```

## Améliorations Futures

- [ ] Graphiques historiques de l'occupation
- [ ] Notifications/alertes quand taux atteint limite
- [ ] Estimation temps avant complet
- [ ] API authentification
- [ ] Base de données pour stockage historique
- [ ] Export des données (CSV, PDF)

## License

MIT

## Support

Pour les problèmes ou suggestions, consultez la documentation originale:
- Annecy Mobilités: https://annecy-mobilites.latitude-cartagene.com/
