const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseCsvRows,
  buildStationPdcIndex,
  aggregateNexteneoByParking,
  attachEvLiveToParkings,
  createEvCollector
} = require('../src/server/ev-collector');
const {
  formatEvLiveBadge,
  formatEvLiveDetail,
  getParkingByKey
} = require('../src/data/parkings');

function buildMockCsvs() {
  const staticLines = [
    '\uFEFFid_station_itinerance,nom_station,adresse_station,id_pdc_itinerance,puissance_nominale',
    'FR0NXPOOLHFX48,"Parking de Bonlieu","[Rue Guillaume Fichet, 74000 Annecy]",FR0NXBON1,22.08',
    'FR0NXPOOLHFX48,"Parking de Bonlieu","Rue ""Guillaume"" Fichet",FR0NXBON2,22.08',
    ...Array.from({ length: 9 }, (_, i) => `FR0NXPOOLHFX48,Parking de Bonlieu,Annecy,FR0NXBON${i + 3},22.08`),
    ...Array.from({ length: 8 }, (_, i) => `FR0NXPOOLTFNT9,Parking Poste,Rue des Glières,FR0NXPOS${i + 1},22.08`),
    ...Array.from({ length: 6 }, (_, i) => `FR0NXPOOLPJ9A3,Parking Hôtel de Ville,Esplanade,FR0NXHDV${i + 1},22.08`),
    'FR0NXPOOLOTHER,Autre Station,74000 Annecy,FR0NXOTH1,50'
  ];

  const dynLines = [
    'id_pdc_itinerance,etat_pdc,occupation_pdc,horodatage,etat_prise_type_2',
    'FR0NXBON1,en_service,libre,2026-11-23T14:20:00.000Z,fonctionnel',
    'FR0NXBON2,en_service,libre,2026-11-23T14:21:00.000Z,fonctionnel',
    'FR0NXBON3,en_service,libre,2026-11-23T14:22:00.000Z,fonctionnel',
    'FR0NXBON4,en_service,libre,2026-11-23T14:23:00.000Z,fonctionnel',
    // Must classify as hors_service only (never double-counted as occupied)
    'FR0NXBON5,hors_service,occupe,2026-11-23T14:28:49.000Z,fonctionnel',
    ...Array.from({ length: 6 }, (_, i) => `FR0NXBON${i + 6},en_service,occupe,2026-11-23T14:15:00.000Z,fonctionnel`),
    ...Array.from({ length: 7 }, (_, i) => `FR0NXPOS${i + 1},en_service,libre,2026-11-23T14:08:00.000Z,fonctionnel`),
    'FR0NXPOS8,en_service,occupe,2026-11-23T14:00:00.000Z,fonctionnel',
    ...Array.from({ length: 5 }, (_, i) => `FR0NXHDV${i + 1},en_service,libre,2026-11-23T14:21:44.000Z,fonctionnel`),
    'FR0NXHDV6,en_service,occupe,2026-11-23T14:10:00.000Z,fonctionnel',
    'FR0NXOTH1,en_service,libre,2026-11-23T14:25:00.000Z,fonctionnel'
  ];

  return {
    staticCsv: `${staticLines.join('\r\n')}\r\n`,
    dynCsv: `${dynLines.join('\n')}\n`
  };
}

describe('NEXTENEO IRVE EV Collector', () => {
  it('parses BOM/RFC-4180 CSV rows and aggregates mutually exclusive EV states', () => {
    const { staticCsv, dynCsv } = buildMockCsvs();
    const staticRows = parseCsvRows(staticCsv);
    const dynRows = parseCsvRows(dynCsv);

    assert.equal(staticRows[0].id_station_itinerance, 'FR0NXPOOLHFX48');
    assert.equal(staticRows[0].adresse_station, '[Rue Guillaume Fichet, 74000 Annecy]');
    assert.equal(staticRows[1].adresse_station, 'Rue "Guillaume" Fichet');

    const index = buildStationPdcIndex(staticRows);
    assert.equal(index.trackedCount, 3);
    assert.equal(index.byParking.bonlieu.pdcIds.length, 11);
    assert.equal(index.byParking.bonlieu.maxPowerKw, 22);

    const byParking = aggregateNexteneoByParking(index, dynRows);
    assert.deepEqual(byParking.bonlieu, {
      available: 4,
      occupied: 6,
      outOfService: 1,
      unknown: 0,
      total: 11,
      maxPowerKw: 22,
      latestEventAt: '2026-11-23T14:28:49.000Z',
      provider: 'NEXTENEO',
      stationId: 'FR0NXPOOLHFX48',
      stale: false
    });
    assert.equal(byParking.poste.available, 7);
    assert.equal(byParking.poste.occupied, 1);
    assert.equal(byParking.hotelDeVille.available, 5);
    assert.equal(byParking.courier, undefined);
    assert.equal(byParking.sainteClaire, undefined);

    assert.equal(formatEvLiveBadge(byParking.bonlieu), '4 / 11 bornes EV libres · 1 hors service');
    assert.equal(formatEvLiveBadge(byParking.poste), '7 / 8 bornes EV libres');
    assert.equal(
      formatEvLiveDetail(byParking.bonlieu, 'fallback'),
      '4 / 11 bornes EV libres (6 occupées · 1 hors service) · Type 2 jusqu’à 22 kW · temps réel NEXTENEO'
    );
    assert.equal(getParkingByKey('bonlieu').evChargers, 11);
  });

  it('deduplicates concurrent fetches, enforces 45s/24h TTLs, and falls back silently', async () => {
    const { staticCsv, dynCsv } = buildMockCsvs();
    let nowMs = Date.parse('2026-11-23T14:30:00.000Z');
    let staticCalls = 0;
    let dynCalls = 0;
    let dynShouldFail = false;

    const evCollector = createEvCollector({
      config: {
        evStaticUrl: 'https://mock.local/statique',
        evDynamicUrl: 'https://mock.local/dynamique',
        evStaticCacheTtlMs: 24 * 60 * 60 * 1000,
        evDynamicCacheTtlMs: 45 * 1000,
        evStaleMaxAgeMs: 15 * 60 * 1000
      },
      nowFn: () => nowMs,
      fetcher: async (url) => {
        await new Promise((r) => setTimeout(r, 15));
        if (url.endsWith('/statique')) {
          staticCalls += 1;
          return { ok: true, text: async () => staticCsv };
        }
        dynCalls += 1;
        if (dynShouldFail) {
          return { ok: false, status: 503, body: { cancel: async () => {} } };
        }
        return { ok: true, text: async () => dynCsv };
      }
    });

    // 3 simultaneous initial requests -> 1 static + 1 dynamic upstream fetch
    const [s1, s2, s3] = await Promise.all([
      evCollector.getSnapshot(),
      evCollector.getSnapshot(),
      evCollector.getSnapshot()
    ]);
    assert.equal(staticCalls, 1);
    assert.equal(dynCalls, 1);
    assert.equal(s1.stale, false);
    assert.equal(s2.byParking.bonlieu.available, 4);
    assert.equal(s3.byParking.poste.total, 8);

    // Within 45s TTL -> hits cache cleanly
    nowMs += 30 * 1000;
    await evCollector.getSnapshot();
    assert.equal(staticCalls, 1);
    assert.equal(dynCalls, 1);

    // Past 45s dynamic TTL -> refreshes dynamic ONLY (24h static stays cached)
    nowMs += 30 * 1000;
    await evCollector.getSnapshot();
    assert.equal(staticCalls, 1);
    assert.equal(dynCalls, 2);

    // Upstream failure within 15m stale window -> silent stale fallback
    nowMs += 60 * 1000;
    dynShouldFail = true;
    const staleSnap = await evCollector.getSnapshot();
    assert.equal(staleSnap.stale, true);
    assert.equal(staleSnap.byParking.bonlieu.available, 4);
    assert.equal(staleSnap.byParking.bonlieu.stale, true);

    // Beyond 15m stale window -> silently empties evLive so UI falls back to static text
    nowMs += 16 * 60 * 1000;
    const expiredSnap = await evCollector.getSnapshot();
    assert.equal(expiredSnap.stale, true);
    assert.deepEqual(expiredSnap.byParking, {});

    // attachEvLiveToParkings must never mutate base snapshot objects
    const baseParkings = { bonlieu: { key: 'bonlieu', available: 100 } };
    const enriched = attachEvLiveToParkings(baseParkings, s1.byParking);
    assert.equal(baseParkings.bonlieu.evLive, undefined);
    assert.equal(enriched.bonlieu.evLive.available, 4);
  });

  it('never throws if NEXTENEO is unreachable from startup', async () => {
    const evCollector = createEvCollector({
      config: {
        evStaticUrl: 'https://mock.local/statique',
        evDynamicUrl: 'https://mock.local/dynamique'
      },
      fetcher: async () => {
        throw new Error('ECONNREFUSED');
      }
    });

    const snap = await evCollector.getSnapshot({ force: true });
    assert.equal(snap.stale, true);
    assert.deepEqual(snap.byParking, {});
    const cached = evCollector.getCachedSnapshot();
    assert.deepEqual(cached.byParking, {});
  });
});
