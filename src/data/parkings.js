const STATUS_TEXT = Object.freeze({
  available: 'Disponible',
  moderate: 'Limité',
  critical: 'Presque complet',
  full: 'Complet',
  error: 'Indisponible'
});

const SHARED_MUNICIPAL_INFO = Object.freeze({
  operator: 'Annecy Parkings (Ville d’Annecy)',
  openingHoursLabel: 'Entrée 07h00 – 01h00 · Sortie 24h/24 (7j/7)',
  openingHoursSpec: 'Mo-Su 07:00-01:00',
  tariffsIndicative: Object.freeze({
    freeMinutes: 30,
    h1: '1,10 €',
    h2: '3,10 €',
    nightHour: '0,40 €/h (20h–07h)',
    note: 'Tarifs indicatifs grille Ville d’Annecy (facturation au quart d’heure ; 30 min gratuites en journée).',
    officialUrl: 'https://www.annecy.fr/'
  })
});

const PARKINGS_LIST = [
  {
    key: 'bonlieu',
    slug: 'bonlieu',
    apiId: 'poi:parking:02',
    name: 'Parking Bonlieu',
    shortName: 'Bonlieu',
    maxCapacity: 652,
    totalCapacityOfficial: 693,
    address: 'Rue de la Préfecture (accès Rue Guillaume Fichet), 74000 Annecy',
    streetAddress: 'Rue de la Préfecture',
    postalCode: '74000',
    city: 'Annecy',
    lat: 45.9022649,
    lng: 6.129977,
    maxHeightMeters: 1.95,
    maxHeightNote: '1,95 m en souterrain (2,40 m en partie extérieure)',
    pmrSpots: 18,
    evChargers: 11,
    evStationId: 'FR0NXPOOLHFX48',
    evNote: '11 points de charge (Type 2 jusqu’à 22 kW · réseau NEXTENEO)',
    zone: 'Lac & Bonlieu',
    zoneKey: 'lac',
    landmarks: ['Le Pâquier', 'Lac d’Annecy', 'Bonlieu Scène Nationale', 'Préfecture'],
    alternatives: ['hotel-de-ville', 'courier'],
    description: 'Grand parking central situé face au Pâquier et au lac d’Annecy, à proximité immédiate du centre culturel Bonlieu et de la rue Royale.',
    chartStyle: {
      lightColor: '#146C43',
      darkColor: '#4CD095',
      dashArray: '',
      markerShape: 'circle'
    }
  },
  {
    key: 'courier',
    slug: 'courier',
    apiId: 'poi:parking:04',
    name: 'Parking Courier',
    shortName: 'Courier',
    maxCapacity: 757,
    totalCapacityOfficial: 769,
    address: 'Boulevard Decouz, 74000 Annecy',
    streetAddress: 'Boulevard Decouz',
    postalCode: '74000',
    city: 'Annecy',
    lat: 45.9046685,
    lng: 6.1227733,
    maxHeightMeters: 1.95,
    maxHeightNote: '1,95 m',
    pmrSpots: 16,
    evChargers: 16,
    evStationId: null,
    evNote: 'Environ 16 points de charge dans le centre Courier',
    zone: 'Courier & Gare',
    zoneKey: 'gare',
    landmarks: ['Centre commercial Courier', 'Cinéma Pathé', 'Gare d’Annecy (5 min à pied)', 'Rue Carnot'],
    alternatives: ['poste', 'bonlieu'],
    description: 'Le plus grand parking couvert du centre-ville d’Annecy, directement relié au centre commercial Courier et à 5 minutes à pied de la gare SNCF.',
    chartStyle: {
      lightColor: '#C86400',
      darkColor: '#FFB74D',
      dashArray: '',
      markerShape: 'circle'
    }
  },
  {
    key: 'hotelDeVille',
    slug: 'hotel-de-ville',
    apiId: 'poi:parking:01',
    name: 'Parking Hôtel de Ville',
    shortName: 'Hôtel de Ville',
    maxCapacity: 408,
    totalCapacityOfficial: 432,
    address: "Esplanade de l'Hôtel de Ville (Quai Eustache Chappuis), 74000 Annecy",
    streetAddress: "Esplanade de l'Hôtel de Ville",
    postalCode: '74000',
    city: 'Annecy',
    lat: 45.8998664,
    lng: 6.1287844,
    maxHeightMeters: 1.90,
    maxHeightNote: '1,90 m',
    pmrSpots: 12,
    evChargers: 6,
    evStationId: 'FR0NXPOOLPJ9A3',
    evNote: '6 points de charge (Type 2 jusqu’à 22 kW · réseau NEXTENEO)',
    zone: 'Vieille Ville & Lac',
    zoneKey: 'vieille-ville',
    landmarks: ['Hôtel de Ville', 'Jardins de l’Europe', 'Pont des Amours', 'Vieille Ville', 'Château d’Annecy (8 min à pied)'],
    alternatives: ['bonlieu', 'sainte-claire'],
    description: 'Parking souterrain idéal pour rejoindre les Jardins de l’Europe, le Pont des Amours, le bord du lac et l’entrée est de la Vieille Ville.',
    chartStyle: {
      lightColor: '#1565C0',
      darkColor: '#64B5F6',
      dashArray: '',
      markerShape: 'circle'
    }
  },
  {
    key: 'poste',
    slug: 'poste',
    apiId: 'poi:parking:09',
    name: 'Parking de la Poste',
    shortName: 'De la Poste',
    maxCapacity: 303,
    totalCapacityOfficial: 317,
    address: 'Rue des Glières, 74000 Annecy',
    streetAddress: 'Rue des Glières',
    postalCode: '74000',
    city: 'Annecy',
    lat: 45.9005139,
    lng: 6.1215855,
    maxHeightMeters: 1.90,
    maxHeightNote: '1,90 m',
    pmrSpots: 7,
    evChargers: 8,
    evStationId: 'FR0NXPOOLTFNT9',
    evNote: '8 points de charge (Type 2 jusqu’à 22 kW · réseau NEXTENEO)',
    zone: 'Courier & Gare',
    zoneKey: 'gare',
    landmarks: ['Gare SNCF d’Annecy (3 min à pied)', 'Centre-ville', 'Vieille Ville (5 min à pied)'],
    alternatives: ['courier', 'sainte-claire'],
    description: 'Parking couvert le plus proche de la gare SNCF d’Annecy et des axes commerçants centraux (rue Carnot, rue Vaugelas).',
    chartStyle: {
      lightColor: '#C62828',
      darkColor: '#FF7070',
      dashArray: '',
      markerShape: 'circle'
    }
  },
  {
    key: 'sainteClaire',
    slug: 'sainte-claire',
    apiId: 'poi:parking:10',
    name: 'Parking Sainte-Claire',
    shortName: 'Sainte-Claire',
    maxCapacity: 336,
    totalCapacityOfficial: 344,
    address: 'Rue de la Gare (Quai des Clarisses), 74000 Annecy',
    streetAddress: 'Rue de la Gare',
    postalCode: '74000',
    city: 'Annecy',
    lat: 45.8978211,
    lng: 6.1229173,
    maxHeightMeters: 1.90,
    maxHeightNote: '1,90 m (rampes étroites)',
    pmrSpots: 8,
    evChargers: null,
    evStationId: null,
    evNote: 'Bornes EV non garanties sur place · 30 places vélo sécurisées',
    zone: 'Vieille Ville & Château',
    zoneKey: 'vieille-ville',
    landmarks: ['Vieille Ville d’Annecy', 'Château d’Annecy (5 min à pied)', 'Canaux & Palais de l’Isle', 'Gare SNCF (7 min à pied)'],
    alternatives: ['poste', 'hotel-de-ville'],
    description: 'Parking au pied de la Vieille Ville et du Château d’Annecy, pratique pour les canaux, le marché et les ruelles piétonnes.',
    chartStyle: {
      lightColor: '#6A359C',
      darkColor: '#C792EA',
      dashArray: '',
      markerShape: 'circle'
    }
  }
].map((parking) => Object.freeze({
  ...parking,
  ...SHARED_MUNICIPAL_INFO,
  navigation: Object.freeze(buildNavigationLinks(parking))
}));

const PARKINGS_BY_KEY = Object.freeze(
  Object.fromEntries(PARKINGS_LIST.map((parking) => [parking.key, parking]))
);

const PARKINGS_BY_SLUG = Object.freeze(
  Object.fromEntries(PARKINGS_LIST.map((parking) => [parking.slug, parking]))
);

function buildNavigationLinks(parking) {
  const coords = `${parking.lat},${parking.lng}`;
  return {
    googleMaps: `https://www.google.com/maps/dir/?api=1&destination=${coords}`,
    applePlans: `https://maps.apple.com/?daddr=${coords}&dirflg=d`,
    waze: `https://waze.com/ul?ll=${coords}&navigate=yes`
  };
}

function computeParkingStatus(available, maxCapacity) {
  if (available === null || available === undefined || !Number.isFinite(available) || !Number.isFinite(maxCapacity) || maxCapacity <= 0) {
    return {
      status: 'error',
      statusText: STATUS_TEXT.error,
      percentage: 0
    };
  }

  const safeAvailable = Math.max(0, Math.round(available));
  const percentage = Math.min(100, Math.max(0, Math.round((safeAvailable / maxCapacity) * 100)));

  let status = 'available';
  if (safeAvailable === 0) {
    status = 'full';
  } else if (percentage <= 10) {
    status = 'critical';
  } else if (percentage <= 50) {
    status = 'moderate';
  }

  return {
    status,
    statusText: STATUS_TEXT[status],
    percentage
  };
}

function getAvailabilityTier(status, percentage) {
  if (!status || status === 'error') {
    return 'error';
  }
  if (status === 'full') {
    return 'full';
  }
  if (status === 'critical') {
    return 'critical';
  }
  if (status === 'available') {
    return 'high';
  }
  return Number(percentage) >= 30 ? 'medium' : 'low';
}

function getAllParkings() {
  return PARKINGS_LIST;
}

function getParkingByKey(key) {
  if (!key || !Object.prototype.hasOwnProperty.call(PARKINGS_BY_KEY, key)) {
    return null;
  }
  return PARKINGS_BY_KEY[key];
}

function getParkingBySlug(slug) {
  if (!slug || !Object.prototype.hasOwnProperty.call(PARKINGS_BY_SLUG, slug)) {
    return null;
  }
  return PARKINGS_BY_SLUG[slug];
}

function getTotalCapacity() {
  return PARKINGS_LIST.reduce((acc, parking) => acc + parking.maxCapacity, 0);
}

function formatEvLiveBadge(evLive) {
  if (!evLive || !Number.isFinite(evLive.total) || evLive.total <= 0) {
    return '';
  }
  const avail = Math.max(0, Math.round(evLive.available));
  const base = `${avail} / ${evLive.total} ${avail === 1 ? 'borne EV libre' : 'bornes EV libres'}`;
  if (evLive.outOfService > 0) {
    return `${base} · ${evLive.outOfService} hors service`;
  }
  return base;
}

function formatEvLiveDetail(evLive, fallbackNote) {
  if (!evLive || !Number.isFinite(evLive.total) || evLive.total <= 0) {
    return fallbackNote || '';
  }
  const avail = Math.max(0, Math.round(evLive.available));
  const head = `${avail} / ${evLive.total} ${avail === 1 ? 'borne EV libre' : 'bornes EV libres'}`;
  const breakdown = [];
  if (evLive.occupied > 0) {
    breakdown.push(`${evLive.occupied} ${evLive.occupied > 1 ? 'occupées' : 'occupée'}`);
  }
  if (evLive.outOfService > 0) {
    breakdown.push(`${evLive.outOfService} hors service`);
  }
  const withBreakdown = breakdown.length ? `${head} (${breakdown.join(' · ')})` : head;
  const powerKw = evLive.maxPowerKw || 22;
  return `${withBreakdown} · Type 2 jusqu’à ${powerKw} kW · temps réel NEXTENEO`;
}

module.exports = {
  STATUS_TEXT,
  PARKINGS_LIST,
  PARKINGS_BY_KEY,
  PARKINGS_BY_SLUG,
  buildNavigationLinks,
  computeParkingStatus,
  getAvailabilityTier,
  getAllParkings,
  getParkingByKey,
  getParkingBySlug,
  getTotalCapacity,
  formatEvLiveBadge,
  formatEvLiveDetail
};
