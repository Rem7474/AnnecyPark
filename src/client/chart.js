import { getParisTimeParts, isDarkThemeRendered } from './state.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined) {
      el.setAttribute(k, String(v));
    }
  }
  return el;
}

function drawColorDot(cx, cy, size, fill, stroke) {
  return svgEl('circle', { cx, cy, r: size, fill, stroke, 'stroke-width': 1.5 });
}

/**
 * Downsample dense 1-minute samples into clean ~10-minute anchors (keeping exact first & latest points)
 * so integer-rounded percentages form a smooth curve instead of a jagged staircase.
 */
function smoothSeriesPoints(points) {
  if (!Array.isArray(points) || points.length <= 28) {
    return points || [];
  }

  const bucketMinutes = 10;
  const buckets = new Map();
  for (let i = 1; i < points.length - 1; i += 1) {
    const pt = points[i];
    const bKey = Math.floor(pt.minuteOfDay / bucketMinutes);
    let bucket = buckets.get(bKey);
    if (!bucket) {
      bucket = { sumMin: 0, sumPct: 0, sumP25: 0, cntP25: 0, sumP75: 0, cntP75: 0, count: 0, sample: pt };
      buckets.set(bKey, bucket);
    }
    bucket.sumMin += pt.minuteOfDay;
    bucket.sumPct += pt.percentage;
    bucket.count += 1;
    if (Number.isFinite(pt.p25)) {
      bucket.sumP25 += pt.p25;
      bucket.cntP25 += 1;
    }
    if (Number.isFinite(pt.p75)) {
      bucket.sumP75 += pt.p75;
      bucket.cntP75 += 1;
    }
  }

  const first = points[0];
  const last = points[points.length - 1];
  const smoothed = [first];

  const sortedKeys = Array.from(buckets.keys()).sort((a, b) => a - b);
  for (const key of sortedKeys) {
    const b = buckets.get(key);
    const minuteOfDay = Math.round(b.sumMin / b.count);
    if (minuteOfDay <= first.minuteOfDay + 2 || minuteOfDay >= last.minuteOfDay - 2) {
      continue;
    }
    smoothed.push({
      ...b.sample,
      minuteOfDay,
      percentage: Math.round((b.sumPct / b.count) * 10) / 10,
      p25: b.cntP25 > 0 ? Math.round((b.sumP25 / b.cntP25) * 10) / 10 : b.sample.p25,
      p75: b.cntP75 > 0 ? Math.round((b.sumP75 / b.cntP75) * 10) / 10 : b.sample.p75
    });
  }

  if (last.minuteOfDay > first.minuteOfDay) {
    smoothed.push(last);
  }
  return smoothed;
}

/**
 * Build a Fritsch-Carlson monotone cubic Hermite spline SVG path (`M ... C ...`) from [{ x, y }]
 * so curves are smooth without ever overshooting [0%, 100%] or inventing false extrema.
 */
function buildSmoothCurvePath(coords, { moveCommand = true } = {}) {
  if (!Array.isArray(coords) || coords.length === 0) {
    return '';
  }
  const headCmd = moveCommand ? 'M' : 'L';
  if (coords.length === 1) {
    return `${headCmd} ${coords[0].x.toFixed(1)} ${coords[0].y.toFixed(1)}`;
  }
  if (coords.length === 2) {
    return `${headCmd} ${coords[0].x.toFixed(1)} ${coords[0].y.toFixed(1)} L ${coords[1].x.toFixed(1)} ${coords[1].y.toFixed(1)}`;
  }

  const n = coords.length;
  const dx = new Array(n - 1);
  const d = new Array(n - 1);
  for (let i = 0; i < n - 1; i += 1) {
    const span = coords[i + 1].x - coords[i].x;
    dx[i] = Math.abs(span) < 0.001 ? (span < 0 ? -0.001 : 0.001) : span;
    d[i] = (coords[i + 1].y - coords[i].y) / dx[i];
  }

  const m = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i += 1) {
    if (d[i - 1] * d[i] <= 0) {
      m[i] = 0;
    } else {
      m[i] = (d[i - 1] + d[i]) / 2;
    }
  }

  for (let i = 0; i < n - 1; i += 1) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
    } else {
      const alpha = m[i] / d[i];
      const beta = m[i + 1] / d[i];
      const hypot = Math.hypot(alpha, beta);
      if (hypot > 3) {
        const tau = 3 / hypot;
        m[i] = tau * alpha * d[i];
        m[i + 1] = tau * beta * d[i];
      }
    }
  }

  const parts = [`${headCmd} ${coords[0].x.toFixed(1)} ${coords[0].y.toFixed(1)}`];
  for (let i = 0; i < n - 1; i += 1) {
    const p0 = coords[i];
    const p1 = coords[i + 1];
    const step = dx[i] / 3;
    const cp1x = p0.x + step;
    const cp1y = p0.y + (m[i] * step);
    const cp2x = p1.x - step;
    const cp2y = p1.y - (m[i + 1] * step);
    parts.push(`C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`);
  }
  return parts.join(' ');
}

export function createChartController({ parkingsMeta, focusedParkingKey = null }) {
  const chartCard = document.getElementById('chartCard');
  const svg = document.getElementById('historyChart');
  const legendEl = document.getElementById('chartLegend');
  const insightEl = document.getElementById('chartInsight');
  const tooltipEl = document.getElementById('chartTooltip');
  const tooltipTimeEl = document.getElementById('tooltipTime');
  const tooltipListEl = document.getElementById('tooltipList');
  const tableBodyEl = document.getElementById('chartDataTableBody');
  const keyboardReadoutEl = document.getElementById('chartKeyboardReadout');

  const allKeys = focusedParkingKey
    ? [focusedParkingKey]
    : Object.keys(parkingsMeta);

  const visibleKeys = new Set(allKeys);
  const legendItemsByKey = new Map();
  let lastLegendDark = null;
  let lastRenderPayload = { points: [], mode: 'realtime', dayKey: null, context: null, parisNowMinute: null };
  let activeCursorIdx = -1;
  let renderedSeries = [];
  let chartGeom = null;

  function getCurveColor(key, dark) {
    const style = parkingsMeta[key]?.chartStyle;
    if (!style) {
      return dark ? '#4FD19B' : '#0E5A3D';
    }
    return dark ? style.darkColor : style.lightColor;
  }

  function hideTooltip() {
    activeCursorIdx = -1;
    if (tooltipEl) {
      tooltipEl.hidden = true;
    }
    const cursorLine = svg?.querySelector('[data-role="cursor-line"]');
    if (cursorLine) {
      cursorLine.setAttribute('visibility', 'hidden');
    }
    svg?.querySelectorAll('[data-role="cursor-dot"]').forEach((d) => d.setAttribute('visibility', 'hidden'));
  }

  function showPointAtMinute(targetMinute, { announce = false } = {}) {
    if (!renderedSeries.length || !chartGeom || !svg || !tooltipEl) {
      return;
    }

    // Snap to closest point across active series
    let closestMinute = null;
    let minDiff = Infinity;
    for (const serie of renderedSeries) {
      for (const pt of serie.points) {
        const diff = Math.abs(pt.minuteOfDay - targetMinute);
        if (diff < minDiff) {
          minDiff = diff;
          closestMinute = pt.minuteOfDay;
        }
      }
    }
    if (closestMinute === null) {
      return;
    }

    const xPos = chartGeom.xForMinute(closestMinute);
    const cursorLine = svg.querySelector('[data-role="cursor-line"]');
    if (cursorLine) {
      cursorLine.setAttribute('x1', xPos.toFixed(1));
      cursorLine.setAttribute('x2', xPos.toFixed(1));
      cursorLine.setAttribute('visibility', 'visible');
    }

    const dark = isDarkThemeRendered();
    const listItems = [];
    const speechParts = [];
    let bestLabel = null;

    renderedSeries.forEach((serie, idx) => {
      let bestPt = null;
      let bestPtDiff = Infinity;
      for (const pt of serie.points) {
        const d = Math.abs(pt.minuteOfDay - closestMinute);
        if (d < bestPtDiff) {
          bestPtDiff = d;
          bestPt = pt;
        }
      }

      const dot = svg.querySelector(`[data-role="cursor-dot"][data-key="${serie.key}"]`);
      if (bestPt && bestPtDiff <= 30) {
        bestLabel = bestLabel || bestPt.timeLabel;
        if (dot) {
          dot.setAttribute('cx', chartGeom.xForMinute(bestPt.minuteOfDay).toFixed(1));
          dot.setAttribute('cy', chartGeom.yForPct(bestPt.percentage).toFixed(1));
          dot.setAttribute('visibility', 'visible');
        }

        const li = document.createElement('li');
        const labelGroup = document.createElement('span');
        labelGroup.className = 'tooltip-label-group';
        const color = getCurveColor(serie.key, dark);
        const dotSvg = svgEl('svg', { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': 'true' });
        dotSvg.append(drawColorDot(6, 6, 4, color, dark ? '#14171A' : '#FFFFFF'));

        const labelSpan = document.createElement('span');
        labelSpan.textContent = parkingsMeta[serie.key]?.shortName || serie.key;
        labelGroup.append(dotSvg, labelSpan);

        const valSpan = document.createElement('strong');
        const availSuffix = Number.isFinite(bestPt.available) ? ` (${bestPt.available} pl.)` : '';
        const bandSuffix = (Number.isFinite(bestPt.p25) && Number.isFinite(bestPt.p75) && bestPt.p75 > bestPt.p25)
          ? ` [${Math.round(bestPt.p25)}–${Math.round(bestPt.p75)} %]`
          : '';
        valSpan.textContent = `${bestPt.percentage} %${availSuffix}${bandSuffix}`;
        li.append(labelGroup, valSpan);
        listItems.push(li);
        speechParts.push(`${labelSpan.textContent} ${valSpan.textContent}`);
      } else if (dot) {
        dot.setAttribute('visibility', 'hidden');
      }

      if (idx === 0 && bestPt) {
        activeCursorIdx = serie.points.indexOf(bestPt);
      }
    });

    if (listItems.length > 0) {
      const h = String(Math.floor(closestMinute / 60)).padStart(2, '0');
      const m = String(closestMinute % 60).padStart(2, '0');
      const timeLabel = bestLabel || `${h}h${m}`;
      tooltipTimeEl.textContent = timeLabel;
      tooltipListEl.replaceChildren(...listItems);
      tooltipEl.hidden = false;

      if (announce && keyboardReadoutEl) {
        keyboardReadoutEl.textContent = `${timeLabel} : ${speechParts.join(', ')}`;
      }
    }
  }

  function updateLegendSwatch(swatchSvg, color) {
    swatchSvg.replaceChildren(
      svgEl('line', {
        x1: 2,
        y1: 6,
        x2: 22,
        y2: 6,
        stroke: color,
        'stroke-width': 3,
        'stroke-linecap': 'round'
      })
    );
  }

  function renderLegend(seriesData) {
    if (!legendEl) {
      return;
    }
    const dark = isDarkThemeRendered();
    const themeChanged = lastLegendDark !== dark;

    if (legendItemsByKey.size === 0) {
      const initialButtons = allKeys.map((key) => {
        const meta = parkingsMeta[key];
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'legend-chip';
        btn.dataset.legendKey = key;

        const swatchSvg = svgEl('svg', { width: 24, height: 12, viewBox: '0 0 24 12', 'aria-hidden': 'true' });
        const nameSpan = document.createElement('span');
        nameSpan.textContent = meta ? meta.shortName : key;
        const valSpan = document.createElement('strong');

        btn.append(swatchSvg, nameSpan, valSpan);

        btn.addEventListener('click', () => {
          if (visibleKeys.has(key) && visibleKeys.size > 1) {
            visibleKeys.delete(key);
          } else {
            visibleKeys.add(key);
          }
          render(lastRenderPayload);
        });

        legendItemsByKey.set(key, { btn, swatchSvg, valSpan });
        return btn;
      });
      legendEl.replaceChildren(...initialButtons);
    }

    for (const key of allKeys) {
      const entry = legendItemsByKey.get(key);
      if (!entry) {
        continue;
      }
      const isActive = visibleKeys.has(key);
      const serie = seriesData.find((s) => s.key === key);
      const lastPt = serie && serie.points.length ? serie.points[serie.points.length - 1] : null;

      entry.btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      entry.valSpan.textContent = lastPt ? ` ${lastPt.percentage} %` : '';
      if (themeChanged) {
        updateLegendSwatch(entry.swatchSvg, getCurveColor(key, dark));
      }
    }

    lastLegendDark = dark;
  }

  function renderInsight(seriesData, { mode, dayKey, context, errorMessage }) {
    if (!insightEl) {
      return;
    }

    if (errorMessage) {
      insightEl.textContent = errorMessage;
      return;
    }

    const validSeries = seriesData.filter((s) => s.points.length > 0);
    if (!validSeries.length) {
      insightEl.textContent = mode === 'prediction'
        ? `Pas encore assez d’historique comparable pour estimer le ${dayKey}.`
        : 'Aucun relevé disponible pour cette journée.';
      return;
    }

    const summaries = validSeries.map((s) => {
      const avg = Math.round(s.points.reduce((a, p) => a + p.percentage, 0) / s.points.length);
      const minPt = s.points.reduce((best, p) => (p.percentage < best.percentage ? p : best), s.points[0]);
      return {
        name: parkingsMeta[s.key]?.shortName || s.key,
        avg,
        minPct: minPt.percentage,
        minTime: minPt.timeLabel
      };
    });

    summaries.sort((a, b) => a.avg - b.avg);
    const busiest = summaries[0];
    const quietest = summaries[summaries.length - 1];

    const prefixParts = [];
    if (mode === 'prediction') {
      prefixParts.push(`Prévision (${context?.contextLabel || 'Zone A'})`);
      if (lastRenderPayload.weather?.label) {
        prefixParts.push(lastRenderPayload.weather.label);
      }
      if (lastRenderPayload.confidence?.label) {
        prefixParts.push(lastRenderPayload.confidence.label);
      }
    } else if (mode === 'history') {
      prefixParts.push(`Historique du ${dayKey}`);
    } else {
      prefixParts.push('Aujourd’hui');
    }
    const prefix = prefixParts.join(' · ');

    if (summaries.length === 1) {
      insightEl.textContent = `${prefix} — ${busiest.name} : moyenne de ${busiest.avg} % de places libres, point bas à ${busiest.minPct} % vers ${busiest.minTime}.`;
    } else {
      insightEl.textContent = `${prefix} — Le plus chargé : ${busiest.name} (moy. ${busiest.avg} %, min ${busiest.minPct} % à ${busiest.minTime}). Le plus fluide : ${quietest.name} (moy. ${quietest.avg} %).`;
    }
  }

  function renderDataTable(points, errorMessage) {
    if (!tableBodyEl) {
      return;
    }
    if (!points || !points.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = allKeys.length + 1;
      td.textContent = errorMessage || 'Aucune donnée disponible pour cette période.';
      tr.append(td);
      tableBodyEl.replaceChildren(tr);
      return;
    }

    // Group 1-min points into up to 24 hourly rows so screen readers & tables stay concise
    const byHour = new Map();
    for (const pt of points) {
      const parisPt = getParisTimeParts(pt.timestamp);
      const bucketKey = pt.hour !== undefined ? pt.hour : parisPt.hour;
      byHour.set(bucketKey, { label: `${String(bucketKey).padStart(2, '0')}h00`, parkings: pt.parkings || {} });
    }

    const rows = Array.from(byHour.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, entry]) => {
        const tr = document.createElement('tr');
        const th = document.createElement('th');
        th.scope = 'row';
        th.textContent = entry.label;
        tr.append(th);

        for (const key of allKeys) {
          const td = document.createElement('td');
          const pData = entry.parkings[key];
          if (pData && Number.isFinite(pData.percentage)) {
            const availTxt = Number.isFinite(pData.available) ? ` (${pData.available})` : '';
            td.textContent = `${pData.percentage} %${availTxt}`;
          } else {
            td.textContent = '—';
          }
          tr.append(td);
        }
        return tr;
      });

    tableBodyEl.replaceChildren(...rows);
  }

  function render(payload) {
    lastRenderPayload = payload;
    if (!svg || !chartCard) {
      return;
    }

    const points = Array.isArray(payload.points) ? payload.points : [];
    const dark = isDarkThemeRendered();
    const cardWidth = chartCard.getBoundingClientRect().width || 720;
    const width = Math.max(320, Math.min(920, Math.round(cardWidth - 20)));
    const height = width < 480 ? 270 : 320;
    const isCompact = width < 480;

    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

    const pad = { top: 18, right: 16, bottom: 32, left: isCompact ? 38 : 44 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    const xForMinute = (min) => pad.left + ((Math.max(0, Math.min(1439, min)) / 1439) * plotW);
    const yForPct = (pct) => pad.top + ((1 - (Math.max(0, Math.min(100, pct)) / 100)) * plotH);
    chartGeom = { width, height, pad, xForMinute, yForPct };

    const gridStroke = dark ? '#2D353C' : '#DCE1E6';
    const textFill = dark ? '#AAB4BE' : '#4C5560';
    const warnStroke = dark ? '#F0736B' : '#C22F28';
    const bgPointStroke = dark ? '#14171A' : '#FFFFFF';

    const nodes = [];

    // Horizontal percentage grid
    for (const pct of [0, 25, 50, 75, 100]) {
      const y = yForPct(pct);
      nodes.push(svgEl('line', {
        x1: pad.left, y1: y, x2: width - pad.right, y2: y,
        stroke: gridStroke, 'stroke-width': 1
      }));
      const label = svgEl('text', {
        x: pad.left - 8, y: y + 4,
        fill: textFill, 'font-size': 12,
        'text-anchor': 'end'
      });
      label.textContent = `${pct}%`;
      nodes.push(label);
    }

    // 10% critical threshold line
    const y10 = yForPct(10);
    nodes.push(svgEl('line', {
      x1: pad.left, y1: y10, x2: width - pad.right, y2: y10,
      stroke: warnStroke, 'stroke-width': 1.5, 'stroke-dasharray': '5 4'
    }));
    const warnLbl = svgEl('text', {
      x: width - pad.right - 4, y: y10 - 5,
      fill: warnStroke, 'font-size': 12, 'font-weight': 700,
      'text-anchor': 'end'
    });
    warnLbl.textContent = 'Seuil 10 %';
    nodes.push(warnLbl);

    // X-axis hour ticks
    const hourTicks = isCompact ? [0, 6, 12, 18, 23] : [0, 4, 8, 12, 16, 20, 23];
    for (const hr of hourTicks) {
      const min = hr === 23 ? 1439 : hr * 60;
      const x = xForMinute(min);
      nodes.push(svgEl('line', {
        x1: x, y1: pad.top, x2: x, y2: height - pad.bottom,
        stroke: gridStroke, 'stroke-width': 0.75, 'stroke-dasharray': '2 3'
      }));
      const txt = svgEl('text', {
        x, y: height - 10,
        fill: textFill, 'font-size': 12,
        'text-anchor': hr === 0 ? 'start' : (hr === 23 ? 'end' : 'middle')
      });
      txt.textContent = hr === 23 ? (isCompact ? '24h' : '23h59') : `${String(hr).padStart(2, '0')}h`;
      nodes.push(txt);
    }

    // Current Paris time marker in realtime mode
    if (payload.mode === 'realtime' && Number.isFinite(payload.parisNowMinute)) {
      const xNow = xForMinute(payload.parisNowMinute);
      nodes.push(svgEl('line', {
        x1: xNow, y1: pad.top, x2: xNow, y2: height - pad.bottom,
        stroke: dark ? '#4CD095' : '#146C43',
        'stroke-width': 1.5, 'stroke-dasharray': '3 3'
      }));
    }

    // Prepare series
    const fullSeries = allKeys.map((key) => {
      const seriesPoints = [];
      for (const pt of points) {
        const pData = pt.parkings?.[key];
        if (!pData || !Number.isFinite(pData.percentage)) {
          continue;
        }
        const parisPt = getParisTimeParts(pt.timestamp);
        seriesPoints.push({
          minuteOfDay: parisPt.minuteOfDay,
          timeLabel: parisPt.label,
          percentage: Number(pData.percentage),
          p25: Number.isFinite(Number(pData.p25)) ? Number(pData.p25) : null,
          p75: Number.isFinite(Number(pData.p75)) ? Number(pData.p75) : null,
          saturationRisk: Number.isFinite(Number(pData.saturationRisk)) ? Number(pData.saturationRisk) : null,
          isNowcast: Boolean(pData.isNowcast),
          available: Number.isFinite(pData.available) ? Number(pData.available) : null
        });
      }
      seriesPoints.sort((a, b) => a.minuteOfDay - b.minuteOfDay);
      return { key, points: seriesPoints };
    });

    renderedSeries = fullSeries.filter((s) => visibleKeys.has(s.key));

    function buildBandPath(bandPoints) {
      const withBounds = smoothSeriesPoints(bandPoints).filter((pt) => Number.isFinite(pt.p25) && Number.isFinite(pt.p75));
      if (withBounds.length < 2) {
        return null;
      }
      const upperCoords = withBounds.map((pt) => ({ x: xForMinute(pt.minuteOfDay), y: yForPct(pt.p75) }));
      const lowerCoords = [...withBounds].reverse().map((pt) => ({ x: xForMinute(pt.minuteOfDay), y: yForPct(pt.p25) }));
      return `${buildSmoothCurvePath(upperCoords, { moveCommand: true })} ${buildSmoothCurvePath(lowerCoords, { moveCommand: false })} Z`;
    }

    if (!points.length) {
      const msg = payload.errorMessage || 'Aucune donnée enregistrée pour cette date.';
      const centerX = pad.left + (plotW / 2);
      const centerY = yForPct(62.5);
      const emptyTxt = svgEl('text', {
        x: centerX,
        y: centerY,
        fill: textFill,
        'font-size': isCompact ? 12 : 13,
        'font-weight': 600,
        'text-anchor': 'middle'
      });

      if (isCompact && msg.length > 26) {
        const words = msg.split(/\s+/);
        const half = Math.ceil(words.length / 2);
        const lines = [words.slice(0, half).join(' '), words.slice(half).join(' ')].filter(Boolean);
        lines.forEach((lineText, idx) => {
          const tspan = svgEl('tspan', {
            x: centerX,
            dy: idx === 0 ? '-0.35em' : '1.35em'
          });
          tspan.textContent = lineText;
          emptyTxt.append(tspan);
        });
      } else {
        emptyTxt.textContent = msg;
      }
      nodes.push(emptyTxt);
    } else {
      // Optional realtime overlays: typical P25-P75 band/baseline & intraday nowcast projection to 23h59
      const overlayPts = Array.isArray(payload.todayOverlay?.points) ? payload.todayOverlay.points : [];
      if (payload.mode === 'realtime' && overlayPts.length > 0) {
        for (const serie of renderedSeries) {
          const color = getCurveColor(serie.key, dark);
          const ovSeries = [];
          for (const opt of overlayPts) {
            const pData = opt.parkings?.[serie.key];
            if (!pData || !Number.isFinite(Number(pData.percentage))) {
              continue;
            }
            const minuteOfDay = Number.isInteger(opt.slot15m)
              ? opt.slot15m * 15
              : getParisTimeParts(opt.timestamp).minuteOfDay;
            ovSeries.push({
              minuteOfDay,
              percentage: Number(pData.percentage),
              p25: Number.isFinite(Number(pData.p25)) ? Number(pData.p25) : null,
              p75: Number.isFinite(Number(pData.p75)) ? Number(pData.p75) : null
            });
          }
          ovSeries.sort((a, b) => a.minuteOfDay - b.minuteOfDay);

          if (payload.showTypicalBand && ovSeries.length >= 2) {
            if (renderedSeries.length === 1) {
              const bandD = buildBandPath(ovSeries);
              if (bandD) {
                nodes.push(svgEl('path', {
                  d: bandD,
                  fill: color,
                  'fill-opacity': dark ? 0.18 : 0.14,
                  stroke: 'none'
                }));
              }
            }
            const typCoords = smoothSeriesPoints(ovSeries).map((pt) => ({
              x: xForMinute(pt.minuteOfDay),
              y: yForPct(pt.percentage)
            }));
            nodes.push(svgEl('path', {
              d: buildSmoothCurvePath(typCoords),
              fill: 'none',
              stroke: color,
              'stroke-opacity': 0.38,
              'stroke-width': 1.5,
              'stroke-dasharray': '3 4',
              'stroke-linecap': 'round'
            }));
          }

          if (payload.showNowcast !== false && serie.points.length > 0 && ovSeries.length > 0) {
            const lastReal = serie.points[serie.points.length - 1];
            const futureOv = ovSeries.filter((pt) => pt.minuteOfDay > lastReal.minuteOfDay + 5);
            if (futureOv.length > 0) {
              const projPts = smoothSeriesPoints([lastReal, ...futureOv]);
              const projCoords = projPts.map((pt) => ({
                x: xForMinute(pt.minuteOfDay),
                y: yForPct(pt.percentage)
              }));
              nodes.push(svgEl('path', {
                d: buildSmoothCurvePath(projCoords),
                fill: 'none',
                stroke: color,
                'stroke-opacity': 0.72,
                'stroke-width': 2.1,
                'stroke-dasharray': '4 4',
                'stroke-linecap': 'round'
              }));
            }
          }
        }
      }

      // Prediction mode P25-P75 confidence band when a single parking curve is focused/isolated
      if (payload.mode === 'prediction' && renderedSeries.length === 1 && renderedSeries[0].points.length >= 2) {
        const onlySerie = renderedSeries[0];
        const bandD = buildBandPath(onlySerie.points);
        if (bandD) {
          nodes.push(svgEl('path', {
            d: bandD,
            fill: getCurveColor(onlySerie.key, dark),
            'fill-opacity': dark ? 0.2 : 0.15,
            stroke: 'none'
          }));
        }
      }

      for (const serie of renderedSeries) {
        if (!serie.points.length) {
          continue;
        }
        const color = getCurveColor(serie.key, dark);
        const smoothPts = smoothSeriesPoints(serie.points);
        const coords = smoothPts.map((pt) => ({
          x: xForMinute(pt.minuteOfDay),
          y: yForPct(pt.percentage)
        }));
        nodes.push(svgEl('path', {
          d: buildSmoothCurvePath(coords),
          fill: 'none',
          stroke: color,
          'stroke-width': 2.6,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round'
        }));
      }
    }

    // Cursor line & focus dots
    nodes.push(svgEl('line', {
      'data-role': 'cursor-line',
      x1: pad.left, y1: pad.top, x2: pad.left, y2: height - pad.bottom,
      stroke: textFill, 'stroke-width': 1.2, visibility: 'hidden'
    }));

    for (const serie of renderedSeries) {
      const color = getCurveColor(serie.key, dark);
      nodes.push(svgEl('circle', {
        'data-role': 'cursor-dot',
        'data-key': serie.key,
        cx: 0, cy: 0, r: 5,
        fill: color, stroke: bgPointStroke, 'stroke-width': 2,
        visibility: 'hidden'
      }));
    }

    svg.replaceChildren(...nodes);
    renderLegend(fullSeries);
    renderInsight(fullSeries, payload);
    renderDataTable(points, payload.errorMessage);
    hideTooltip();
  }

  if (svg && chartCard) {
    svg.addEventListener('pointermove', (event) => {
      if (event.pointerType === 'touch' || !chartGeom) {
        return;
      }
      const rect = svg.getBoundingClientRect();
      const relX = ((event.clientX - rect.left) / rect.width) * chartGeom.width;
      const ratio = (relX - chartGeom.pad.left) / (chartGeom.width - chartGeom.pad.left - chartGeom.pad.right);
      if (ratio < 0 || ratio > 1) {
        hideTooltip();
        return;
      }
      showPointAtMinute(Math.round(ratio * 1439));
    });

    svg.addEventListener('pointerdown', (event) => {
      if (!chartGeom) {
        return;
      }
      const rect = svg.getBoundingClientRect();
      const relX = ((event.clientX - rect.left) / rect.width) * chartGeom.width;
      const ratio = Math.max(0, Math.min(1, (relX - chartGeom.pad.left) / (chartGeom.width - chartGeom.pad.left - chartGeom.pad.right)));
      showPointAtMinute(Math.round(ratio * 1439));
    });

    svg.addEventListener('mouseleave', () => {
      hideTooltip();
    });

    svg.addEventListener('keydown', (event) => {
      const baseSerie = renderedSeries.find((s) => s.points.length > 0);
      if (!baseSerie) {
        return;
      }
      if (event.key === 'Escape') {
        hideTooltip();
        return;
      }
      let nextIdx = activeCursorIdx;
      if (event.key === 'ArrowRight') {
        nextIdx = activeCursorIdx < 0 ? 0 : Math.min(baseSerie.points.length - 1, activeCursorIdx + 1);
      } else if (event.key === 'ArrowLeft') {
        nextIdx = activeCursorIdx < 0 ? baseSerie.points.length - 1 : Math.max(0, activeCursorIdx - 1);
      } else if (event.key === 'Home') {
        nextIdx = 0;
      } else if (event.key === 'End') {
        nextIdx = baseSerie.points.length - 1;
      } else {
        return;
      }
      event.preventDefault();
      activeCursorIdx = nextIdx;
      showPointAtMinute(baseSerie.points[nextIdx].minuteOfDay, { announce: true });
    });

    document.addEventListener('pointerdown', (event) => {
      if (!chartCard.contains(event.target)) {
        hideTooltip();
      }
    });

    if ('ResizeObserver' in window) {
      let lastWidth = 0;
      const ro = new ResizeObserver(() => {
        const w = Math.round(chartCard.getBoundingClientRect().width);
        if (Math.abs(w - lastWidth) > 12) {
          lastWidth = w;
          render(lastRenderPayload);
        }
      });
      ro.observe(chartCard);
    }

    window.addEventListener('annecypark:themechange', () => {
      render(lastRenderPayload);
    });
  }

  return { render };
}
