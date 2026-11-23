function safeJsonLd(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/-->/g, '--\\>');
}

function buildFaqSchema(faqs) {
  return {
    '@type': 'FAQPage',
    mainEntity: faqs.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: item.answer
      }
    }))
  };
}

function buildParkingFacilityNode(baseUrl, parking) {
  const url = `${baseUrl}/parking/${parking.slug}`;
  const amenities = [
    {
      '@type': 'LocationFeatureSpecification',
      name: 'Hauteur maximale autorisée',
      value: `${parking.maxHeightMeters} m`
    },
    {
      '@type': 'LocationFeatureSpecification',
      name: 'Places PMR réservées',
      value: parking.pmrSpots
    },
    {
      '@type': 'LocationFeatureSpecification',
      name: '30 premières minutes gratuites',
      value: true
    }
  ];

  if (parking.evChargers) {
    amenities.push({
      '@type': 'LocationFeatureSpecification',
      name: 'Bornes de recharge véhicule électrique',
      value: parking.evChargers
    });
  }

  return {
    '@type': 'ParkingFacility',
    '@id': `${url}#parking`,
    name: parking.name,
    description: parking.description,
    url,
    isAccessibleForFree: false,
    publicAccess: true,
    address: {
      '@type': 'PostalAddress',
      streetAddress: parking.streetAddress,
      addressLocality: parking.city,
      postalCode: parking.postalCode,
      addressRegion: 'Auvergne-Rhône-Alpes',
      addressCountry: 'FR'
    },
    geo: {
      '@type': 'GeoCoordinates',
      latitude: parking.lat,
      longitude: parking.lng
    },
    openingHoursSpecification: [
      {
        '@type': 'OpeningHoursSpecification',
        dayOfWeek: [
          'Monday',
          'Tuesday',
          'Wednesday',
          'Thursday',
          'Friday',
          'Saturday',
          'Sunday'
        ],
        opens: '07:00',
        closes: '01:00'
      }
    ],
    amenityFeature: amenities
  };
}

function buildHomeJsonLd({ baseUrl, parkings, faqs }) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        '@id': `${baseUrl}/#website`,
        name: 'AnnecyPark',
        url: `${baseUrl}/`,
        inLanguage: 'fr-FR',
        description: 'Disponibilité en temps réel des parkings du centre-ville d’Annecy, prévisions d’affluence et itinéraires.'
      },
      {
        '@type': 'WebApplication',
        '@id': `${baseUrl}/#app`,
        name: 'AnnecyPark — Parkings d’Annecy en temps réel',
        url: `${baseUrl}/`,
        applicationCategory: 'TravelApplication',
        operatingSystem: 'All',
        inLanguage: 'fr-FR',
        isAccessibleForFree: true,
        offers: {
          '@type': 'Offer',
          price: '0',
          priceCurrency: 'EUR'
        }
      },
      {
        '@type': 'ItemList',
        name: 'Parkings suivis au centre-ville d’Annecy',
        itemListElement: parkings.map((parking, idx) => ({
          '@type': 'ListItem',
          position: idx + 1,
          url: `${baseUrl}/parking/${parking.slug}`,
          name: parking.name
        }))
      },
      buildFaqSchema(faqs)
    ]
  };
}

function buildParkingJsonLd({ baseUrl, parking, faqs }) {
  const url = `${baseUrl}/parking/${parking.slug}`;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      buildParkingFacilityNode(baseUrl, parking),
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          {
            '@type': 'ListItem',
            position: 1,
            name: 'Parkings Annecy',
            item: `${baseUrl}/`
          },
          {
            '@type': 'ListItem',
            position: 2,
            name: parking.name,
            item: url
          }
        ]
      },
      buildFaqSchema(faqs)
    ]
  };
}

function buildRobotsTxt(baseUrl) {
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    '',
    `Sitemap: ${baseUrl}/sitemap.xml`,
    ''
  ].join('\n');
}

function buildSitemapXml({ baseUrl, parkings, lastModIso }) {
  const safeLastMod = lastModIso || new Date().toISOString();
  const urls = [
    { loc: `${baseUrl}/`, lastmod: safeLastMod },
    ...parkings.map((p) => ({
      loc: `${baseUrl}/parking/${p.slug}`,
      lastmod: safeLastMod
    }))
  ];

  const itemsXml = urls
    .map((entry) => `  <url>\n    <loc>${entry.loc}</loc>\n    <lastmod>${entry.lastmod}</lastmod>\n  </url>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${itemsXml}\n</urlset>\n`;
}

module.exports = {
  safeJsonLd,
  buildHomeJsonLd,
  buildParkingJsonLd,
  buildRobotsTxt,
  buildSitemapXml
};
