import './styles/main.css';
import { getParisTimeParts, readBootstrapState } from './state.js';
import { initThemeToggle } from './theme.js';
import { initFilters } from './filters.js';
import { initAnalyticsTabs } from './tabs.js';
import { createChartController } from './chart.js';

// Conditional polyfills per modern-web-guidance (only loaded if native support is missing)
if (!('commandForElement' in HTMLButtonElement.prototype)) {
  import('invokers-polyfill');
}
if (!Object.hasOwn(HTMLElement.prototype, 'popover')) {
  import('@oddbird/popover-polyfill');
}
if (!Object.hasOwn(HTMLElement.prototype, 'focusGroup')) {
  import('@microsoft/focusgroup-polyfill').then((m) => m.polyfill?.());
}

const POLL_INTERVAL_MS = 20000;
const VISIBILITY_COOLDOWN_MS = 10000;

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    return;
  }
  const register = () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  };
  if (document.readyState === 'complete') {
    register();
  } else {
    window.addEventListener('load', register, { once: true });
  }
}

function setupPopoverFocusReturn() {
  document.addEventListener('click', (event) => {
    const closeBtn = event.target.closest('[data-return-focus]');
    if (!closeBtn) {
      return;
    }
    const triggerId = closeBtn.getAttribute('data-return-focus');
    if (!triggerId) {
      return;
    }
    requestAnimationFrame(() => {
      document.getElementById(triggerId)?.focus();
    });
  });
}

function updateFreshnessHeader({ state, timeLabel, isoTimestamp, bannerText }) {
  const pill = document.getElementById('freshnessPill');
  const labelEl = document.getElementById('freshnessLabel');
  const timeEl = document.getElementById('lastUpdateTime');
  const banner = document.getElementById('connectionBanner');
  const bannerTextEl = document.getElementById('connectionBannerText');

  if (pill) {
    pill.dataset.state = state;
  }
  if (labelEl) {
    if (state === 'offline') {
      labelEl.textContent = 'Hors ligne';
    } else if (state === 'stale') {
      labelEl.textContent = 'Relevé mémorisé';
    } else {
      labelEl.textContent = 'En direct';
    }
  }
  if (timeEl && timeLabel) {
    timeEl.textContent = timeLabel;
    if (isoTimestamp) {
      timeEl.setAttribute('datetime', isoTimestamp);
    }
  }
  if (banner && bannerTextEl) {
    if (bannerText) {
      bannerTextEl.textContent = bannerText;
      banner.hidden = false;
    } else {
      banner.hidden = true;
      bannerTextEl.textContent = '';
    }
  }
}

function formatEvLiveBadgeClient(evLive) {
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

function formatEvLiveDetailClient(evLive, fallbackNote) {
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

function getAvailabilityTierClient(status, percentage) {
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

function formatTrendLineClient(etaEntry) {
  if (!etaEntry) {
    return '';
  }
  const parts = [];
  if (
    etaEntry.trend
    && (etaEntry.trend.direction === 'filling' || etaEntry.trend.direction === 'emptying')
    && etaEntry.trend.label
  ) {
    parts.push(etaEntry.trend.label);
  }
  if (etaEntry.vsTypical && etaEntry.vsTypical.status !== 'normal' && etaEntry.vsTypical.label) {
    parts.push(etaEntry.vsTypical.label);
  }
  return parts.join(' · ');
}

function updateParkingDomNodes(payload) {
  const parkings = payload.parkings || {};
  const etaByParking = payload.eta?.byParking || {};
  let totalAvail = 0;

  document.querySelectorAll('.parking-card[data-parking-key], .detail-live-card[data-parking-key], .alt-parking-row[data-parking-key]').forEach((card) => {
    const key = card.dataset.parkingKey;
    const live = parkings[key];
    if (!live) {
      return;
    }

    const status = live.status || 'error';
    if (status !== 'error' && Number.isFinite(live.available)) {
      totalAvail += live.available;
    }

    card.dataset.available = String(live.available ?? 0);
    card.dataset.percentage = String(live.percentage ?? 0);
    card.dataset.status = status;
    card.dataset.availabilityTier = getAvailabilityTierClient(status, live.percentage);

    const availEl = card.querySelector('[data-field="available"]');
    if (availEl) {
      availEl.textContent = status === 'error' ? '—' : String(live.available);
    }

    const pctEl = card.querySelector('[data-field="percentage"]');
    if (pctEl) {
      pctEl.textContent = status === 'error' ? '—' : `${live.percentage} %`;
    }

    const progressEl = card.querySelector('[data-field="progress"]');
    if (progressEl) {
      const displayName = live.name || key;
      const availLabel = status === 'error' ? 'Indisponible' : `${live.percentage} %`;
      progressEl.dataset.status = status;
      progressEl.value = status === 'error' ? 0 : live.percentage;
      progressEl.textContent = availLabel;
      progressEl.setAttribute('aria-label', `Disponibilité ${displayName} : ${availLabel}`);
    }

    const badge = card.querySelector('.status-badge');
    if (badge) {
      badge.dataset.status = status;
      const txt = badge.querySelector('.status-text');
      if (txt) {
        txt.textContent = live.statusText || 'Indisponible';
      }
    }

    const forecastEl = card.querySelector('[data-field="forecast"]');
    const eta = etaByParking[key];
    if (forecastEl && eta) {
      forecastEl.textContent = eta.summaryText || 'Affluence normale';
    }

    const trendEl = card.querySelector('[data-field="trend"]');
    if (trendEl) {
      const trendText = formatTrendLineClient(eta);
      trendEl.textContent = trendText;
      trendEl.hidden = !trendText;
    }

    const evLive = live.evLive && Number.isFinite(live.evLive.total) && live.evLive.total > 0 ? live.evLive : null;
    const evLiveEl = card.querySelector('[data-field="ev-live"]');
    if (evLiveEl) {
      if (evLive) {
        evLiveEl.hidden = false;
        evLiveEl.dataset.evState = evLive.available > 0 ? 'available' : 'full';
        const evTextEl = evLiveEl.querySelector('[data-field="ev-live-text"]');
        if (evTextEl) {
          evTextEl.textContent = formatEvLiveBadgeClient(evLive);
        }
      } else {
        evLiveEl.hidden = true;
        evLiveEl.dataset.evState = 'none';
      }
    }

    const evStaticEl = card.querySelector('[data-field="ev-static"]');
    if (evStaticEl) {
      evStaticEl.hidden = Boolean(evLive);
    }
  });

  document.querySelectorAll('[data-field="detail-ev-spec"][data-parking-key]').forEach((specEl) => {
    const key = specEl.dataset.parkingKey;
    const evLive = parkings[key]?.evLive || null;
    specEl.textContent = formatEvLiveDetailClient(evLive, specEl.dataset.evFallback || '');
  });

  const weatherPill = document.getElementById('weatherPill');
  if (weatherPill) {
    if (payload.weather && payload.weather.label) {
      weatherPill.textContent = payload.weather.label;
      weatherPill.hidden = false;
    } else {
      weatherPill.hidden = true;
    }
  }

  // Update total hero KPI on home page (avoid double counting detail/alternative cards)
  const totalEl = document.getElementById('totalAvailableCount');
  if (totalEl) {
    let sum = 0;
    for (const p of Object.values(parkings)) {
      if (p && p.status !== 'error' && Number.isFinite(p.available)) {
        sum += p.available;
      }
    }
    totalEl.textContent = String(sum || totalAvail);
  }

  // Update typical comparison cards if present
  const compContainer = document.getElementById('comparisonContainer');
  if (compContainer && payload.typical?.byParking) {
    const isHoliday = Boolean(payload.holidayContext?.isHoliday);
    compContainer.querySelectorAll('.comparison-card[data-parking-key]').forEach((card) => {
      const stat = payload.typical.byParking[card.dataset.parkingKey];
      if (!stat) {
        return;
      }
      const vacEl = card.querySelector('[data-field="vac"]');
      const nonVacEl = card.querySelector('[data-field="nonvac"]');
      if (vacEl) {
        vacEl.textContent = stat.schoolHoliday
          ? `${stat.schoolHoliday.avgAvailability} % (${stat.schoolHoliday.sampleCount} ${stat.schoolHoliday.sampleCount > 1 ? 'relevés' : 'relevé'})`
          : 'Données en collecte';
      }
      if (nonVacEl) {
        nonVacEl.textContent = stat.nonHoliday
          ? `${stat.nonHoliday.avgAvailability} % (${stat.nonHoliday.sampleCount} ${stat.nonHoliday.sampleCount > 1 ? 'relevés' : 'relevé'})`
          : 'Données en collecte';
      }
      const rows = card.querySelectorAll('.comparison-row');
      if (rows.length >= 2) {
        rows[0].classList.toggle('is-active-context', isHoliday);
        rows[1].classList.toggle('is-active-context', !isHoliday);
      }
    });
  }
}

function initSectionNav() {
  const navLinks = Array.from(document.querySelectorAll('.main-nav a[data-nav-target]'));
  const sections = navLinks
    .map((link) => {
      const targetId = link.dataset.navTarget;
      const el = targetId ? document.getElementById(targetId) : null;
      return el ? { link, targetId, el } : null;
    })
    .filter(Boolean);

  if (!sections.length) {
    return;
  }

  let scrollSpyLockedUntil = 0;
  let scrollRafPending = false;

  function setActiveNav(targetId) {
    for (const link of navLinks) {
      if (link.dataset.navTarget === targetId) {
        link.setAttribute('aria-current', 'location');
      } else {
        link.removeAttribute('aria-current');
      }
    }
  }

  function activateFromHash() {
    const hashId = window.location.hash.replace(/^#/, '');
    if (sections.some((s) => s.targetId === hashId)) {
      setActiveNav(hashId);
      scrollSpyLockedUntil = Date.now() + 700;
      return true;
    }
    return false;
  }

  function updateFromScroll() {
    if (Date.now() < scrollSpyLockedUntil) {
      return;
    }
    const headerEl = document.querySelector('.site-header');
    const isStickyHeader = headerEl && ['sticky', 'fixed'].includes(getComputedStyle(headerEl).position);
    const headerHeight = isStickyHeader ? headerEl.getBoundingClientRect().height : 0;
    const headerOffset = headerHeight + 32;

    if ((window.innerHeight + window.scrollY) >= (document.documentElement.scrollHeight - 24)) {
      setActiveNav(sections[sections.length - 1].targetId);
      return;
    }

    let activeId = sections[0].targetId;
    for (const s of sections) {
      if (s.el.getBoundingClientRect().top <= headerOffset) {
        activeId = s.targetId;
      }
    }
    setActiveNav(activeId);
  }

  for (const { link, targetId } of sections) {
    link.addEventListener('click', () => {
      setActiveNav(targetId);
      scrollSpyLockedUntil = Date.now() + 700;
    });
  }

  window.addEventListener('hashchange', activateFromHash);

  const unlockScrollSpy = () => {
    scrollSpyLockedUntil = 0;
  };
  window.addEventListener('wheel', unlockScrollSpy, { passive: true });
  window.addEventListener('touchstart', unlockScrollSpy, { passive: true });
  window.addEventListener('keydown', (event) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
      unlockScrollSpy();
    }
  });

  window.addEventListener('scroll', () => {
    if (scrollRafPending) {
      return;
    }
    scrollRafPending = true;
    requestAnimationFrame(() => {
      scrollRafPending = false;
      updateFromScroll();
    });
  }, { passive: true });

  if (!activateFromHash()) {
    updateFromScroll();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  registerServiceWorker();
  initThemeToggle();
  setupPopoverFocusReturn();
  initSectionNav();

  const bootstrap = readBootstrapState();
  if (!bootstrap) {
    return;
  }

  let currentState = bootstrap;
  let currentChartMode = 'realtime';
  let selectedDateKey = null;
  let lastDashboardEtag = null;
  let lastFetchCompletedAt = Date.now();
  let pollTimer = null;
  let activeDashboardAbort = null;
  let activeChartAbort = null;

  const filters = initFilters();
  const chart = createChartController({
    parkingsMeta: bootstrap.parkingsMeta,
    focusedParkingKey: bootstrap.focusedParkingKey || null
  });

  const toggleNowcastEl = document.getElementById('toggleNowcastProjection');
  const toggleTypicalEl = document.getElementById('toggleTypicalBand');
  if (toggleTypicalEl && bootstrap.focusedParkingKey) {
    toggleTypicalEl.checked = true;
  }

  let latestPredictionPayload = null;

  function renderCurrentRealtimeChart() {
    const nowMin = getParisTimeParts(new Date()).minuteOfDay;
    const showNowcast = toggleNowcastEl ? toggleNowcastEl.checked : true;
    const showTypicalBand = toggleTypicalEl
      ? toggleTypicalEl.checked
      : Boolean(bootstrap.focusedParkingKey);

    chart.render({
      mode: 'realtime',
      dayKey: currentState.parisDayKey,
      points: currentState.historyToday?.points || [],
      todayOverlay: currentState.todayOverlay || null,
      showNowcast,
      showTypicalBand,
      parisNowMinute: nowMin
    });
  }

  toggleNowcastEl?.addEventListener('change', () => {
    if (currentChartMode === 'realtime') {
      renderCurrentRealtimeChart();
    }
  });
  toggleTypicalEl?.addEventListener('change', () => {
    if (currentChartMode === 'realtime') {
      renderCurrentRealtimeChart();
    }
  });

  function renderPredictionAdvisor(predData) {
    const metaStrip = document.getElementById('predictionMetaStrip');
    const advisorBox = document.getElementById('arrivalAdvisorBox');
    const arrivalSelect = document.getElementById('predictionArrivalTime');

    if (metaStrip) {
      const stripParts = [];
      if (predData?.context?.contextLabel) {
        stripParts.push(predData.context.contextLabel);
      }
      if (predData?.confidence?.label) {
        stripParts.push(predData.confidence.label);
      }
      if (predData?.weather?.label) {
        stripParts.push(`Météo : ${predData.weather.label}`);
      }
      metaStrip.textContent = stripParts.join(' · ');
      metaStrip.hidden = stripParts.length === 0;
    }

    if (!advisorBox) {
      return;
    }

    const points = Array.isArray(predData?.points) ? predData.points : [];
    if (!points.length) {
      advisorBox.hidden = true;
      advisorBox.replaceChildren();
      return;
    }

    const timeVal = arrivalSelect?.value || '14:00';
    const [hStr, mStr] = timeVal.split(':');
    const targetSlot = (Number.parseInt(hStr, 10) * 4) + Math.floor((Number.parseInt(mStr, 10) || 0) / 15);

    let bestPt = null;
    let bestDist = Infinity;
    for (const pt of points) {
      const slot = Number.isInteger(pt.slot15m) ? pt.slot15m : (pt.hour * 4);
      const dist = Math.abs(slot - targetSlot);
      if (dist <= 4 && dist < bestDist) {
        bestDist = dist;
        bestPt = pt;
      }
    }

    if (!bestPt || !bestPt.parkings) {
      advisorBox.hidden = true;
      advisorBox.replaceChildren();
      return;
    }

    const ranked = Object.values(bootstrap.parkingsMeta)
      .map((meta) => {
        const p = bestPt.parkings[meta.key];
        if (!p || !Number.isFinite(Number(p.percentage))) {
          return null;
        }
        const pct = Number(p.percentage);
        const avail = Number.isFinite(Number(p.available))
          ? Number(p.available)
          : Math.round((pct / 100) * meta.maxCapacity);
        const risk = Number.isFinite(Number(p.saturationRisk)) ? Number(p.saturationRisk) : 0;
        const status = avail === 0 ? 'full' : (pct <= 10 ? 'critical' : (pct <= 50 ? 'moderate' : 'available'));
        return {
          meta,
          pct,
          avail,
          p25: p.p25,
          p75: p.p75,
          risk,
          tier: getAvailabilityTierClient(status, pct)
        };
      })
      .filter(Boolean)
      .sort((a, b) => (b.avail !== a.avail ? b.avail - a.avail : b.pct - a.pct));

    if (!ranked.length) {
      advisorBox.hidden = true;
      advisorBox.replaceChildren();
      return;
    }

    const top = ranked[0];
    const timeLabel = timeVal.replace(':', 'h');
    const leadP = document.createElement('p');
    leadP.className = 'arrival-lead';
    const riskTxt = top.risk > 0 ? ` · risque saturation ${top.risk} %` : ' · risque saturation faible';
    leadP.textContent = `Conseil d’arrivée vers ${timeLabel} : privilégiez ${top.meta.name} (~${top.avail} places libres · ${top.pct} %${riskTxt}).`;

    const ul = document.createElement('ul');
    ul.className = 'arrival-rank-list';
    ranked.forEach((item, index) => {
      const li = document.createElement('li');
      li.className = 'arrival-rank-item';
      li.dataset.availabilityTier = item.tier;

      const link = document.createElement('a');
      link.href = `/parking/${item.meta.slug}`;
      link.textContent = `${index + 1}. ${item.meta.shortName}`;

      const metric = document.createElement('span');
      const bandTxt = (Number.isFinite(item.p25) && Number.isFinite(item.p75) && item.p75 > item.p25)
        ? ` [${Math.round(item.p25)}–${Math.round(item.p75)} %]`
        : '';
      metric.textContent = `~${item.avail} pl. (${item.pct} %${bandTxt})`;

      li.append(link, metric);
      ul.append(li);
    });

    advisorBox.replaceChildren(leadP, ul);
    advisorBox.hidden = false;
  }

  document.getElementById('predictionArrivalTime')?.addEventListener('change', () => {
    if (latestPredictionPayload) {
      renderPredictionAdvisor(latestPredictionPayload);
    }
  });

  async function loadChartMode(mode, dateKey) {
    if (activeChartAbort) {
      activeChartAbort.abort();
    }
    if (mode === 'realtime') {
      currentChartMode = 'realtime';
      selectedDateKey = null;
      const rangeEl = document.getElementById('analyticsTimeRange');
      if (rangeEl) {
        rangeEl.textContent = '00h00 – 23h59 (heure de Paris)';
      }
      renderCurrentRealtimeChart();
      return;
    }

    if (mode === 'comparison') {
      currentChartMode = 'comparison';
      selectedDateKey = null;
      const rangeEl = document.getElementById('analyticsTimeRange');
      if (rangeEl) {
        rangeEl.textContent = 'Comparatif créneau actuel (heure de Paris)';
      }
      return;
    }

    if (!dateKey) {
      return;
    }

    currentChartMode = mode;
    selectedDateKey = dateKey;
    const rangeEl = document.getElementById('analyticsTimeRange');
    if (rangeEl) {
      rangeEl.textContent = mode === 'prediction'
        ? `Prévision pour le ${dateKey}`
        : `Historique du ${dateKey}`;
    }

    const controller = new AbortController();
    activeChartAbort = controller;

    const endpoint = mode === 'prediction'
      ? `/api/prediction/day?date=${encodeURIComponent(dateKey)}`
      : `/api/history/day?date=${encodeURIComponent(dateKey)}`;

    try {
      const response = await fetch(endpoint, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();
      if (mode === 'prediction') {
        latestPredictionPayload = data;
        renderPredictionAdvisor(data);
      }
      chart.render({
        mode,
        dayKey: dateKey,
        points: data.points || [],
        context: data.context || null,
        confidence: data.confidence || null,
        weather: data.weather || null
      });
    } catch (error) {
      if (error.name !== 'AbortError') {
        chart.render({
          mode,
          dayKey: dateKey,
          points: [],
          errorMessage: 'Impossible de charger les données pour cette date (réseau indisponible).'
        });
      }
    }
  }

  initAnalyticsTabs({
    onModeChange(mode) {
      if (mode === 'realtime') {
        loadChartMode('realtime');
      } else if (mode === 'history') {
        const input = document.getElementById('historyDateInput');
        loadChartMode('history', input?.value);
      } else if (mode === 'prediction') {
        const input = document.getElementById('predictionDateInput');
        loadChartMode('prediction', input?.value);
      } else {
        loadChartMode('comparison');
      }
    }
  });

  // History & prediction mode controls
  const historyInput = document.getElementById('historyDateInput');
  const historyApply = document.getElementById('historyApplyBtn');
  historyApply?.addEventListener('click', () => loadChartMode('history', historyInput?.value));
  document.querySelectorAll('[data-history-date]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (historyInput && btn.dataset.historyDate) {
        historyInput.value = btn.dataset.historyDate;
        loadChartMode('history', historyInput.value);
      }
    });
  });

  const predInput = document.getElementById('predictionDateInput');
  const predApply = document.getElementById('predictionApplyBtn');
  predApply?.addEventListener('click', () => loadChartMode('prediction', predInput?.value));
  document.querySelectorAll('[data-prediction-date]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (predInput && btn.dataset.predictionDate) {
        predInput.value = btn.dataset.predictionDate;
        loadChartMode('prediction', predInput.value);
      }
    });
  });

  // Render initial SSR chart immediately
  renderCurrentRealtimeChart();

  async function refreshDashboard() {
    if (document.hidden) {
      return;
    }

    if (activeDashboardAbort) {
      activeDashboardAbort.abort();
    }
    const controller = new AbortController();
    activeDashboardAbort = controller;

    try {
      const headers = {};
      if (lastDashboardEtag) {
        headers['If-None-Match'] = lastDashboardEtag;
      }

      const response = await fetch('/api/dashboard', {
        headers,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])
      });

      const isSwOffline = response.headers.get('X-AnnecyPark-Offline') === '1';
      if (response.status === 304) {
        lastFetchCompletedAt = Date.now();
        updateFreshnessHeader({
          state: currentState.stale ? 'stale' : 'live',
          timeLabel: currentState.parisTime,
          isoTimestamp: currentState.timestamp,
          bannerText: ''
        });
        return;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const nextEtag = response.headers.get('ETag');
      if (nextEtag) {
        lastDashboardEtag = nextEtag;
      }

      const payload = await response.json();
      if (payload.offline) {
        throw new Error('Offline fallback');
      }

      if (
        isSwOffline
        && payload.timestamp
        && currentState.timestamp
        && payload.timestamp < currentState.timestamp
      ) {
        updateFreshnessHeader({
          state: 'offline',
          timeLabel: currentState.parisTime,
          isoTimestamp: currentState.timestamp,
          bannerText: `Hors ligne — relevé mémorisé de ${currentState.parisTime || '--:--:--'}`
        });
        return;
      }

      currentState = { ...currentState, ...payload };
      lastFetchCompletedAt = Date.now();

      updateParkingDomNodes(payload);
      filters.reapply();

      if (currentChartMode === 'realtime') {
        renderCurrentRealtimeChart();
      } else if (currentChartMode !== 'comparison' && selectedDateKey) {
        // Keep selected history/prediction chart untouched on background refresh
      }

      if (isSwOffline) {
        updateFreshnessHeader({
          state: 'offline',
          timeLabel: payload.parisTime,
          isoTimestamp: payload.timestamp,
          bannerText: `Hors ligne — relevé mémorisé de ${payload.parisTime || '--:--:--'}`
        });
      } else if (payload.stale) {
        updateFreshnessHeader({
          state: 'stale',
          timeLabel: payload.parisTime,
          isoTimestamp: payload.timestamp,
          bannerText: `Source Annecy Mobilités partiellement indisponible — relevé de ${payload.parisTime || '--:--:--'}`
        });
      } else {
        updateFreshnessHeader({
          state: 'live',
          timeLabel: payload.parisTime,
          isoTimestamp: payload.timestamp,
          bannerText: ''
        });
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        return;
      }
      const offlineMsg = !navigator.onLine
        ? `Hors ligne — dernier relevé connu de ${currentState.parisTime || '--:--:--'}`
        : `Connexion instable — relevé affiché de ${currentState.parisTime || '--:--:--'}`;
      updateFreshnessHeader({
        state: 'offline',
        timeLabel: currentState.parisTime,
        bannerText: offlineMsg
      });
    }
  }

  function scheduleNextPoll() {
    clearTimeout(pollTimer);
    if (!document.hidden) {
      pollTimer = setTimeout(async () => {
        await refreshDashboard();
        scheduleNextPoll();
      }, POLL_INTERVAL_MS);
    }
  }

  document.getElementById('retryFetchBtn')?.addEventListener('click', () => {
    refreshDashboard();
  });

  window.addEventListener('online', () => {
    refreshDashboard();
    scheduleNextPoll();
  });

  window.addEventListener('offline', () => {
    updateFreshnessHeader({
      state: 'offline',
      timeLabel: currentState.parisTime,
      bannerText: `Hors ligne — relevé mémorisé de ${currentState.parisTime || '--:--:--'}`
    });
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(pollTimer);
    } else {
      if ((Date.now() - lastFetchCompletedAt) >= VISIBILITY_COOLDOWN_MS) {
        refreshDashboard();
      }
      scheduleNextPoll();
    }
  });

  // Trigger one live refresh shortly after initial SSR render, then chained polling
  refreshDashboard().finally(() => {
    scheduleNextPoll();
  });
});
