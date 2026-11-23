function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = (Math.sin(dLat / 2) ** 2)
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * (Math.sin(dLng / 2) ** 2);
  return Math.round(2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function formatDistanceLabel(meters) {
  if (!Number.isFinite(meters)) {
    return '';
  }
  if (meters < 1000) {
    return `à ${meters} m`;
  }
  return `à ${(meters / 1000).toFixed(1).replace('.', ',')} km`;
}

export function initFilters() {
  const container = document.getElementById('parkingsContainer');
  const filterButtons = Array.from(document.querySelectorAll('[data-zone-filter]'));
  const sortSelect = document.getElementById('sortSelect');
  const hideFullToggle = document.getElementById('hideFullToggle');
  const feedbackEl = document.getElementById('toolbarFeedback');
  const emptyNoteEl = document.getElementById('emptyGridNote');

  if (!container || !filterButtons.length || !sortSelect || !hideFullToggle) {
    return { reapply: () => {} };
  }

  const initialOrder = Array.from(container.querySelectorAll('.parking-card'))
    .map((card) => card.dataset.parkingKey);

  let activeZone = 'all';
  let userPosition = null;
  const distancesByKey = new Map();

  function setFeedback(text) {
    if (!feedbackEl) {
      return;
    }
    if (!text) {
      feedbackEl.hidden = true;
      feedbackEl.textContent = '';
    } else {
      feedbackEl.textContent = text;
      feedbackEl.hidden = false;
    }
  }

  function computeDistances() {
    if (!userPosition) {
      return;
    }
    container.querySelectorAll('.parking-card').forEach((card) => {
      const lat = Number.parseFloat(card.dataset.lat);
      const lng = Number.parseFloat(card.dataset.lng);
      const key = card.dataset.parkingKey;
      const distChip = card.querySelector('[data-field="distance"]');
      if (Number.isFinite(lat) && Number.isFinite(lng) && key) {
        const meters = haversineMeters(userPosition.lat, userPosition.lng, lat, lng);
        distancesByKey.set(key, meters);
        if (distChip) {
          distChip.textContent = formatDistanceLabel(meters);
          distChip.hidden = false;
        }
      }
    });
  }

  function applyFiltersAndSort() {
    const cards = Array.from(container.querySelectorAll('.parking-card'));
    const sortBy = sortSelect.value;
    const hideFull = hideFullToggle.checked;

    cards.sort((a, b) => {
      const keyA = a.dataset.parkingKey;
      const keyB = b.dataset.parkingKey;
      if (sortBy === 'available') {
        return Number(b.dataset.available || 0) - Number(a.dataset.available || 0);
      }
      if (sortBy === 'percentage') {
        return Number(b.dataset.percentage || 0) - Number(a.dataset.percentage || 0);
      }
      if (sortBy === 'distance' && distancesByKey.size > 0) {
        const dA = distancesByKey.get(keyA) ?? Infinity;
        const dB = distancesByKey.get(keyB) ?? Infinity;
        return dA - dB;
      }
      return initialOrder.indexOf(keyA) - initialOrder.indexOf(keyB);
    });

    let visibleCount = 0;
    for (const card of cards) {
      const zoneMatches = activeZone === 'all' || card.dataset.zoneKey === activeZone;
      const isFull = card.dataset.status === 'full';
      const visible = zoneMatches && !(hideFull && isFull);
      card.hidden = !visible;
      if (visible) {
        visibleCount += 1;
      }
    }

    const currentCards = Array.from(container.querySelectorAll('.parking-card'));
    const orderChanged = currentCards.length !== cards.length
      || cards.some((card, index) => currentCards[index] !== card);

    if (orderChanged) {
      for (const card of cards) {
        if (typeof container.moveBefore === 'function') {
          try {
            container.moveBefore(card, null);
          } catch {
            container.append(card);
          }
        } else {
          container.append(card);
        }
      }
    }
    if (emptyNoteEl) {
      emptyNoteEl.hidden = visibleCount > 0;
    }
  }

  filterButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      activeZone = btn.dataset.zoneFilter || 'all';
      filterButtons.forEach((other) => {
        other.setAttribute('aria-pressed', other === btn ? 'true' : 'false');
      });
      applyFiltersAndSort();
    });
  });

  hideFullToggle.addEventListener('change', applyFiltersAndSort);

  sortSelect.addEventListener('change', () => {
    if (sortSelect.value !== 'distance') {
      setFeedback('');
      applyFiltersAndSort();
      return;
    }

    if (userPosition) {
      setFeedback('');
      computeDistances();
      applyFiltersAndSort();
      return;
    }

    if (!('geolocation' in navigator)) {
      setFeedback('La géolocalisation n’est pas disponible sur ce navigateur.');
      sortSelect.value = 'recommended';
      applyFiltersAndSort();
      return;
    }

    setFeedback('Recherche de votre position pour trier par proximité...');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        userPosition = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setFeedback('');
        computeDistances();
        applyFiltersAndSort();
      },
      () => {
        setFeedback('Position non autorisée : tri rétabli sur l’ordre conseillé.');
        sortSelect.value = 'recommended';
        applyFiltersAndSort();
      },
      { enableHighAccuracy: false, timeout: 6000, maximumAge: 60000 }
    );
  });

  return {
    reapply: applyFiltersAndSort
  };
}
