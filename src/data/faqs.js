const HOME_FAQS = Object.freeze([
  {
    question: 'Quels parkings d’Annecy sont suivis en temps réel sur AnnecyPark ?',
    answer: 'AnnecyPark affiche en direct les places libres de 5 grands parkings couverts du centre-ville d’Annecy : Bonlieu (Pâquier & lac), Courier (centre commercial & gare), Hôtel de Ville (Vieille Ville & lac), de la Poste (gare SNCF) et Sainte-Claire (Vieille Ville & château).'
  },
  {
    question: 'Quel parking choisir pour la gare SNCF ou le château d’Annecy ?',
    answer: 'Pour la gare SNCF d’Annecy, le parking de la Poste (rue des Glières, 3 min à pied) et le parking Courier (boulevard Decouz, 5 min à pied) sont les plus directs. Pour la Vieille Ville et le château d’Annecy, privilégiez le parking Sainte-Claire (5 min à pied) ou le parking Hôtel de Ville (8 min à pied).'
  },
  {
    question: 'Les parkings du centre-ville d’Annecy sont-ils ouverts la nuit ?',
    answer: 'Les entrées des parkings couverts municipaux (Bonlieu, Hôtel de Ville, Poste, Sainte-Claire) ferment généralement entre 01h00 et 07h00, mais la sortie reste possible 24h/24 et 7j/7 avec votre ticket d’entrée.'
  },
  {
    question: 'Comment sont calculées les prévisions d’affluence et de saturation ?',
    answer: 'Les prévisions croisent les 5 dernières semaines du même jour de la semaine avec la même période de l’année précédente, en séparant strictement les périodes de vacances scolaires de la Zone A (Académie de Grenoble) et les périodes hors vacances.'
  }
]);

function buildParkingFaqs(parking) {
  const heightText = parking.maxHeightNote || `${String(parking.maxHeightMeters).replace('.', ',')} m`;
  const evText = parking.evChargers
    ? `Oui, ce parking dispose d’environ ${parking.evChargers} points de charge pour véhicules électriques (${parking.evNote}).`
    : 'Aucune borne de recharge électrique n’est garantie sur ce site ; les parkings voisins Bonlieu (11 points) et de la Poste (8 points) en sont équipés.';

  return [
    {
      question: `Quelle est la hauteur maximale autorisée au ${parking.name} ?`,
      answer: `Le gabarit maximal du ${parking.name} est de ${heightText}. Vérifiez la hauteur de votre véhicule (coffre de toit inclus) avant l’entrée en rampe.`
    },
    {
      question: `Quels sont les tarifs et horaires du ${parking.name} ?`,
      answer: `Selon la grille indicative de la Ville d’Annecy, les 30 premières minutes sont gratuites en journée, puis le tarif progresse au quart d’heure (environ ${parking.tariffsIndicative.h1} pour 1h et ${parking.tariffsIndicative.h2} pour 2h, tarif de nuit ${parking.tariffsIndicative.nightHour}). ${parking.openingHoursLabel}.`
    },
    {
      question: `Y a-t-il des places PMR et des bornes électriques au ${parking.name} ?`,
      answer: `Oui, le ${parking.name} propose ${parking.pmrSpots} places réservées aux personnes à mobilité réduite (PMR) avec cheminement adapté. Côté recharge électrique : ${evText}`
    },
    {
      question: `Que faire si le ${parking.name} est complet ?`,
      answer: `Si le ${parking.name} affiche complet ou moins de 10 % de places libres, consultez en temps réel les parkings alternatifs du même secteur listés sur cette fiche et lancez directement l’itinéraire vers le plus disponible.`
    }
  ];
}

module.exports = {
  HOME_FAQS,
  buildParkingFaqs
};
