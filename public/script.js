// Global variables
let autoRefreshInterval = null;
const REFRESH_INTERVAL = 10000; // 10 seconds
let dayHistoryPoints = [];
let predictionHistoryPoints = [];
let predictionContext = null;
let chartMode = 'realtime';
let selectedPredictionDate = null;
let latestParkingsSnapshot = {};
const parkingCardsByKey = new Map();
const FRENCH_WEEKDAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

const PARKING_COLORS = {
    bonlieu: '#2a7a51',
    courier: '#a37624',
    hotelDeVille: '#4a7188',
    poste: '#8f4e37',
    sainteClaire: '#6b5a8d'
};

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    initializeHistoryControls();

    // Initial data fetch
    fetchParkingData();

    // Always keep data fresh without manual controls.
    startAutoRefresh();
});

function initializeHistoryControls() {
    const dateInput = document.getElementById('predictionDateInput');
    const applyButton = document.getElementById('predictionApplyButton');
    const resetButton = document.getElementById('predictionResetButton');

    if (!dateInput || !applyButton || !resetButton) {
        return;
    }

    const today = getTodayKey();
    dateInput.value = today;

    applyButton.addEventListener('click', async () => {
        if (!dateInput.value) {
            return;
        }

        await activatePredictionMode(dateInput.value);
    });

    resetButton.addEventListener('click', async () => {
        chartMode = 'realtime';
        selectedPredictionDate = null;
        predictionHistoryPoints = [];
        predictionContext = null;
        dateInput.value = getTodayKey();
        updateHistoryControlsState();

        await renderHistoryForCurrentMode();
    });

    dateInput.addEventListener('keydown', async (event) => {
        if (event.key !== 'Enter' || !dateInput.value) {
            return;
        }
        await activatePredictionMode(dateInput.value);
    });

    updateHistoryControlsState();
}

function updateHistoryControlsState() {
    const dateInput = document.getElementById('predictionDateInput');
    const resetButton = document.getElementById('predictionResetButton');

    if (!dateInput || !resetButton) {
        return;
    }

    const isPredictionMode = chartMode === 'prediction';
    resetButton.disabled = !isPredictionMode;
    dateInput.disabled = false;
}

// Fetch parking data from API
async function fetchParkingData() {
    const container = document.getElementById('parkingsContainer');

    // Show loading state
    container.classList.add('refreshing');

    try {
        const response = await fetch('/api/parkings');
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        latestParkingsSnapshot = data.parkings || {};

        // Update last update time
        document.getElementById('lastUpdate').textContent = new Date().toLocaleTimeString('fr-FR');

        renderParkingCards(container, data.parkings);
        await renderHistoryForCurrentMode();
        renderTypicalComparison(data.parkings);
        renderEtaWarnings(data.parkings);

    } catch (error) {
        console.error('Error fetching parking data:', error);
        parkingCardsByKey.clear();
        container.innerHTML = `
            <div class="error-message">
                ⚠️ Erreur lors du chargement des données: ${error.message}
            </div>
        `;
    } finally {
        container.classList.remove('refreshing');
    }
}

async function activatePredictionMode(dateKey) {
    selectedPredictionDate = dateKey;
    chartMode = 'prediction';
    updateHistoryControlsState();

    const predictionPayload = await fetchPredictionDay(dateKey);
    predictionHistoryPoints = Array.isArray(predictionPayload.points) ? predictionPayload.points : [];
    predictionContext = predictionPayload.context || null;

    renderHistoryChart(latestParkingsSnapshot, predictionHistoryPoints, {
        dayKey: dateKey,
        isPrediction: true
    });

    renderHistoryInsight(latestParkingsSnapshot, predictionHistoryPoints, {
        mode: 'prediction',
        dayKey: dateKey,
        context: predictionContext
    });
}

async function renderHistoryForCurrentMode() {
    if (chartMode === 'prediction' && selectedPredictionDate) {
        if (!predictionHistoryPoints.length) {
            const predictionPayload = await fetchPredictionDay(selectedPredictionDate);
            predictionHistoryPoints = Array.isArray(predictionPayload.points) ? predictionPayload.points : [];
            predictionContext = predictionPayload.context || null;
        }

        renderHistoryChart(latestParkingsSnapshot, predictionHistoryPoints, {
            dayKey: selectedPredictionDate,
            isPrediction: true
        });

        renderHistoryInsight(latestParkingsSnapshot, predictionHistoryPoints, {
            mode: 'prediction',
            dayKey: selectedPredictionDate,
            context: predictionContext
        });
        return;
    }

    const todayKey = getTodayKey();
    dayHistoryPoints = await fetchDayHistory(todayKey);
    renderHistoryChart(latestParkingsSnapshot, dayHistoryPoints, {
        dayKey: todayKey,
        isPrediction: false
    });
    renderHistoryInsight(latestParkingsSnapshot, dayHistoryPoints, {
        mode: 'realtime',
        dayKey: todayKey,
        context: null
    });
}

function renderParkingCards(container, parkings) {
    const parkingKeys = Object.keys(parkings || {});

    // Remove static loading placeholders once data is available.
    container.querySelectorAll('.loading').forEach((node) => {
        node.remove();
    });

    parkingKeys.forEach((parkingKey, index) => {
        const parking = parkings[parkingKey];
        let card = parkingCardsByKey.get(parkingKey);

        if (!card) {
            card = createParkingCard(parkingKey, parking);
            parkingCardsByKey.set(parkingKey, card);
            container.appendChild(card);
        } else {
            updateParkingCard(card, parkingKey, parking);
        }

        if (container.children[index] !== card) {
            container.insertBefore(card, container.children[index] || null);
        }
    });

    for (const [parkingKey, card] of parkingCardsByKey.entries()) {
        if (Object.prototype.hasOwnProperty.call(parkings, parkingKey)) {
            continue;
        }
        parkingCardsByKey.delete(parkingKey);
        if (card.parentElement === container) {
            container.removeChild(card);
        }
    }
}

// Create a parking card element
function createParkingCard(parkingKey, parking) {
    const card = document.createElement('div');
    card.innerHTML = `
        <div class="parking-header">
            <div class="parking-name"></div>
            <span class="status-badge"></span>
        </div>

        <div class="capacity-bar">
            <div class="capacity-label">
                <span>Taux de disponibilite</span>
                <strong class="availability-value"></strong>
            </div>
            <div class="progress-bar">
                <div class="progress-fill"></div>
            </div>
        </div>

        <div class="parking-stats">
            <div class="stat-item">
                <div class="stat-number available-spots"></div>
                <div class="stat-label">Places libres</div>
            </div>
            <div class="stat-item">
                <div class="stat-number capacity-total"></div>
                <div class="stat-label">Capacité totale</div>
            </div>
        </div>

        <div class="parking-footer">
            <span class="last-update"></span>
            <span class="error-line"></span>
            <p class="parking-warning" id="warning-${parkingKey}"></p>
        </div>
    `;

    updateParkingCard(card, parkingKey, parking);

    return card;
}

function updateParkingCard(card, parkingKey, parking) {
    card.className = `parking-card ${parking.status}`;
    card.dataset.parkingKey = parkingKey;

    const nameNode = card.querySelector('.parking-name');
    const statusBadgeNode = card.querySelector('.status-badge');
    const availabilityNode = card.querySelector('.availability-value');
    const progressFillNode = card.querySelector('.progress-fill');
    const availableNode = card.querySelector('.available-spots');
    const capacityNode = card.querySelector('.capacity-total');
    const lastUpdateNode = card.querySelector('.last-update');
    const errorLineNode = card.querySelector('.error-line');

    if (nameNode) {
        nameNode.textContent = parking.name;
    }

    if (statusBadgeNode) {
        statusBadgeNode.className = `status-badge ${parking.status}`;
        statusBadgeNode.textContent = getStatusText(parking.status);
    }

    if (availabilityNode) {
        availabilityNode.textContent = `${parking.percentage}%`;
    }

    if (progressFillNode) {
        progressFillNode.style.width = `${parking.percentage}%`;
    }

    if (availableNode) {
        availableNode.textContent = String(parking.available);
    }

    if (capacityNode) {
        capacityNode.textContent = String(parking.maxCapacity);
    }

    if (lastUpdateNode) {
        lastUpdateNode.textContent = `Mise a jour: ${parking.lastUpdate}`;
    }

    if (errorLineNode) {
        if (parking.error) {
            errorLineNode.textContent = `Erreur: ${parking.error}`;
            errorLineNode.style.display = 'block';
        } else {
            errorLineNode.textContent = '';
            errorLineNode.style.display = 'none';
        }
    }
}

// Get status text
function getStatusText(status) {
    const statusTexts = {
        'available': 'Disponible',
        'moderate': 'Limite',
        'full': 'Complet',
        'error': 'Indisponible'
    };
    return statusTexts[status] || 'Inconnu';
}

function getTodayKey() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

async function fetchDayHistory(queryDate) {
    const response = await fetch(`/api/history/day?date=${queryDate}`);

    if (!response.ok) {
        throw new Error(`History API error: ${response.status}`);
    }

    const payload = await response.json();
    return Array.isArray(payload.points) ? payload.points : [];
}

async function fetchPredictionDay(queryDate) {
    const response = await fetch(`/api/prediction/day?date=${queryDate}`);

    if (!response.ok) {
        throw new Error(`Prediction API error: ${response.status}`);
    }

    return response.json();
}

function getDayStartMs(dayKey) {
    const [year, month, day] = dayKey.split('-').map((part) => Number.parseInt(part, 10));
    return new Date(year, month - 1, day, 0, 0, 0, 0).getTime();
}

function formatDateKeyFrench(dayKey) {
    const [year, month, day] = dayKey.split('-').map((part) => Number.parseInt(part, 10));
    return new Date(year, month - 1, day, 12, 0, 0, 0).toLocaleDateString('fr-FR', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
}

function renderHistoryChart(latestParkings, historyPoints, options = {}) {
    const chart = document.getElementById('historyChart');
    const legend = document.getElementById('historyLegend');
    const timeRange = document.getElementById('historyTimeRange');
    const tooltip = document.getElementById('historyHoverTooltip');
    const historyTitle = document.getElementById('historyTitle');

    if (!chart || !legend || !timeRange) {
        return;
    }

    const width = 940;
    const height = 320;
    const margin = { top: 18, right: 18, bottom: 34, left: 44 };
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;

    const dayKey = options.dayKey || getTodayKey();
    const isPrediction = Boolean(options.isPrediction);

    const dayStart = getDayStartMs(dayKey);
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;

    if (historyTitle) {
        historyTitle.textContent = isPrediction
            ? `Prediction de disponibilite (${formatDateKeyFrench(dayKey)})`
            : 'Historique de disponibilite (journee)';
    }

    timeRange.textContent = `${formatHour(dayStart)} - ${formatHour(dayEnd - 60000)}`;

    const yTicks = [0, 25, 50, 75, 100];
    const hourTicks = [0, 6, 12, 18, 24];

    const gridLines = yTicks.map((tick) => {
        const y = margin.top + innerHeight - (tick / 100) * innerHeight;
        return `
            <line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="#dde5d8" stroke-width="1" />
            <text x="${margin.left - 8}" y="${y + 4}" text-anchor="end" fill="#6a746b" font-size="11">${tick}%</text>
        `;
    }).join('');

    const xTicks = hourTicks.map((hour) => {
        const ratio = hour / 24;
        const x = margin.left + ratio * innerWidth;
        return `
            <line x1="${x}" y1="${margin.top}" x2="${x}" y2="${height - margin.bottom}" stroke="#edf1ea" stroke-width="1" />
            <text x="${x}" y="${height - 10}" text-anchor="middle" fill="#6a746b" font-size="11">${String(hour).padStart(2, '0')}h</text>
        `;
    }).join('');

    const parkingKeysSet = new Set(Object.keys(latestParkings || {}));
    historyPoints.forEach((point) => {
        Object.keys(point.parkings || {}).forEach((key) => parkingKeysSet.add(key));
    });
    const parkingKeys = Array.from(parkingKeysSet);

    const chartPoints = historyPoints.map((point) => {
        const timestampMs = new Date(point.timestamp).getTime();
        const values = {};

        parkingKeys.forEach((key) => {
            const sample = point.parkings && point.parkings[key];
            if (sample && Number.isFinite(sample.percentage)) {
                values[key] = sample.percentage;
            }
        });

        return {
            timestamp: point.timestamp,
            x: margin.left + ((timestampMs - dayStart) / (dayEnd - dayStart)) * innerWidth,
            values
        };
    }).filter((point) => Number.isFinite(point.x) && point.x >= margin.left && point.x <= (width - margin.right));

    const linePaths = parkingKeys.map((key) => {
        const color = PARKING_COLORS[key] || '#6a756b';
        const series = chartPoints
            .filter((point) => Number.isFinite(point.values[key]))
            .map((point) => ({
                x: point.x,
                y: margin.top + innerHeight - (point.values[key] / 100) * innerHeight
            }));

        if (!series.length) {
            return '';
        }

        const d = series.map((p, index) => `${index === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');
        return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />`;
    }).join('');

    const noDataLabel = historyPoints.length
        ? ''
        : `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" fill="#6a746b" font-size="13">${isPrediction ? 'Donnees insuffisantes pour estimer cette journee.' : 'Les points de la journee apparaitront ici apres les premiers releves.'}</text>`;

    chart.innerHTML = `
        <rect x="0" y="0" width="${width}" height="${height}" fill="transparent" />
        ${gridLines}
        ${xTicks}
        ${linePaths}
        ${noDataLabel}
        <g id="historyCursor" class="history-cursor" visibility="hidden">
            <line id="historyCursorLine" y1="${margin.top}" y2="${height - margin.bottom}"></line>
            <g id="historyCursorPoints"></g>
        </g>
        <rect id="historyCursorHitbox" x="${margin.left}" y="${margin.top}" width="${innerWidth}" height="${innerHeight}" fill="transparent" />
    `;

    bindHistoryCursor(chart, tooltip, chartPoints, parkingKeys, latestParkings, {
        width,
        margin,
        innerHeight
    });

    const legendLatest = {};
    chartPoints.forEach((point) => {
        parkingKeys.forEach((key) => {
            if (Number.isFinite(point.values[key])) {
                legendLatest[key] = point.values[key];
            }
        });
    });

    legend.innerHTML = parkingKeys.map((key) => {
        const parking = latestParkings[key] || {};
        const fallbackName = historyPoints.find((point) => point.parkings && point.parkings[key])?.parkings?.[key]?.name;
        const value = Number.isFinite(legendLatest[key])
            ? `${legendLatest[key]}%`
            : parking && Number.isFinite(parking.percentage)
                ? `${parking.percentage}%`
                : '--';
        const color = PARKING_COLORS[key] || '#6a756b';
        return `
            <div class="legend-item">
                <span class="legend-swatch" style="background:${color}"></span>
                <span>${parking.name || fallbackName || key}</span>
                <span class="legend-value">${value}</span>
            </div>
        `;
    }).join('');
}

function bindHistoryCursor(chart, tooltip, chartPoints, parkingKeys, latestParkings, dimensions) {
    const cursorGroup = document.getElementById('historyCursor');
    const cursorLine = document.getElementById('historyCursorLine');
    const cursorPoints = document.getElementById('historyCursorPoints');
    const hitbox = document.getElementById('historyCursorHitbox');
    const chartCard = chart.closest('.chart-card');

    if (!cursorGroup || !cursorLine || !cursorPoints || !hitbox || !tooltip || !chartCard) {
        return;
    }

    const hideCursor = () => {
        cursorGroup.setAttribute('visibility', 'hidden');
        tooltip.classList.remove('visible');
    };

    if (!chartPoints.length) {
        hideCursor();
        hitbox.onmousemove = null;
        hitbox.onmouseleave = null;
        hitbox.ontouchstart = null;
        hitbox.ontouchmove = null;
        hitbox.ontouchend = null;
        return;
    }

    const drawAtClientX = (clientX) => {
        const svgRect = chart.getBoundingClientRect();
        if (!svgRect.width) {
            hideCursor();
            return;
        }

        const rawX = ((clientX - svgRect.left) / svgRect.width) * dimensions.width;
        const minX = dimensions.margin.left;
        const maxX = dimensions.width - dimensions.margin.right;
        const targetX = Math.min(Math.max(rawX, minX), maxX);

        let closest = chartPoints[0];
        for (let i = 1; i < chartPoints.length; i += 1) {
            const point = chartPoints[i];
            if (Math.abs(point.x - targetX) < Math.abs(closest.x - targetX)) {
                closest = point;
            }
        }

        cursorGroup.setAttribute('visibility', 'visible');
        cursorLine.setAttribute('x1', closest.x.toFixed(2));
        cursorLine.setAttribute('x2', closest.x.toFixed(2));

        const pointsMarkup = parkingKeys.map((key) => {
            if (!Number.isFinite(closest.values[key])) {
                return '';
            }
            const y = dimensions.margin.top + dimensions.innerHeight - (closest.values[key] / 100) * dimensions.innerHeight;
            const color = PARKING_COLORS[key] || '#6a756b';
            return `<circle cx="${closest.x.toFixed(2)}" cy="${y.toFixed(2)}" r="4" fill="${color}" stroke="#ffffff" stroke-width="1.4" />`;
        }).join('');

        cursorPoints.innerHTML = pointsMarkup;

        const rows = parkingKeys.map((key) => {
            if (!Number.isFinite(closest.values[key])) {
                return '';
            }
            const color = PARKING_COLORS[key] || '#6a756b';
            const parkingName = latestParkings[key] ? latestParkings[key].name : key;
            return `
                <div class="history-tooltip-row">
                    <span class="history-tooltip-dot" style="background:${color}"></span>
                    <span>${parkingName}</span>
                    <strong>${closest.values[key]}%</strong>
                </div>
            `;
        }).join('');

        tooltip.innerHTML = `
            <div class="history-tooltip-time">${formatHour(closest.timestamp)}</div>
            ${rows}
        `;

        const xPx = ((closest.x / dimensions.width) * svgRect.width);
        const chartCardRect = chartCard.getBoundingClientRect();

        tooltip.classList.add('visible');

        const preferredLeft = xPx + 12;
        const maxLeft = chartCardRect.width - tooltip.offsetWidth - 8;
        const left = Math.min(Math.max(preferredLeft, 8), Math.max(maxLeft, 8));
        tooltip.style.left = `${left}px`;
        tooltip.style.top = '8px';
    };

    hitbox.onmousemove = (event) => {
        drawAtClientX(event.clientX);
    };

    hitbox.onmouseleave = () => {
        hideCursor();
    };

    hitbox.ontouchstart = (event) => {
        if (!event.touches.length) {
            return;
        }
        drawAtClientX(event.touches[0].clientX);
    };

    hitbox.ontouchmove = (event) => {
        if (!event.touches.length) {
            return;
        }
        drawAtClientX(event.touches[0].clientX);
    };

    hitbox.ontouchend = () => {
        hideCursor();
    };
}

function renderHistoryInsight(latestParkings, points, options = {}) {
    const insightNode = document.getElementById('historyInsight');
    if (!insightNode) {
        return;
    }

    const parkingKeys = Object.keys(latestParkings || {});
    const isPrediction = options.mode === 'prediction';

    if (!points.length || !parkingKeys.length) {
        insightNode.textContent = '';
        return;
    }

    const minima = parkingKeys.map((key) => {
        let minValue = 101;
        let minTimestamp = null;

        points.forEach((point) => {
            const sample = point.parkings[key];
            if (!sample || !Number.isFinite(sample.percentage)) {
                return;
            }
            if (sample.percentage < minValue) {
                minValue = sample.percentage;
                minTimestamp = point.timestamp;
            }
        });

        return {
            key,
            name: latestParkings[key].name,
            minValue,
            minTimestamp
        };
    }).filter((entry) => Number.isFinite(entry.minValue) && entry.minValue <= 100);

    minima.sort((a, b) => a.minValue - b.minValue);

    const mostConstrained = minima[0];

    if (!mostConstrained || !mostConstrained.minTimestamp) {
        insightNode.textContent = '';
        return;
    }

    if (isPrediction) {
        const contextLabel = options.context && options.context.isSchoolHoliday
            ? 'contexte vacances scolaires'
            : 'contexte hors vacances scolaires';
        insightNode.textContent = `${mostConstrained.name} est estime a un minimum de ${mostConstrained.minValue}% vers ${formatHour(mostConstrained.minTimestamp)} (${contextLabel}).`;
        return;
    }

    insightNode.textContent = `${mostConstrained.name} a atteint un minimum de ${mostConstrained.minValue}% de disponibilite a ${formatHour(mostConstrained.minTimestamp)} aujourd'hui.`;
}

async function fetchTypicalStats(parkingKey, hour, weekday) {
    const response = await fetch(`/api/stats/typical?parkingKey=${encodeURIComponent(parkingKey)}&hour=${hour}&weekday=${weekday}`);

    if (!response.ok) {
        throw new Error(`Stats API error: ${response.status}`);
    }

    return response.json();
}

function formatTypicalValue(contextData) {
    if (!contextData || !Number.isFinite(contextData.avgAvailability)) {
        return {
            value: '--',
            sub: 'Pas assez de donnees'
        };
    }

    return {
        value: `${contextData.avgAvailability}%`,
        sub: `Min ${contextData.minAvailability}% · Max ${contextData.maxAvailability}% · n=${contextData.sampleCount}`
    };
}

async function renderTypicalComparison(latestParkings) {
    const container = document.getElementById('comparisonContainer');
    const meta = document.getElementById('comparisonMeta');

    if (!container || !meta) {
        return;
    }

    container.querySelectorAll('.loading').forEach((node) => {
        node.remove();
    });

    const now = new Date();
    const hour = now.getHours();
    const weekday = now.getDay();

    const endHour = (hour + 1) % 24;
    meta.textContent = `${FRENCH_WEEKDAYS[weekday]} · ${String(hour).padStart(2, '0')}h-${String(endHour).padStart(2, '0')}h`;

    const parkingKeys = Object.keys(latestParkings || {});
    if (!parkingKeys.length) {
        container.innerHTML = '<p class="comparison-empty">Aucune donnee disponible.</p>';
        return;
    }

    const statsResults = await Promise.all(
        parkingKeys.map(async (parkingKey) => {
            try {
                return await fetchTypicalStats(parkingKey, hour, weekday);
            } catch (error) {
                return {
                    parkingKey,
                    context: {
                        schoolHoliday: null,
                        nonHoliday: null
                    },
                    error: error.message
                };
            }
        })
    );

    container.innerHTML = statsResults.map((result) => {
        const currentParking = latestParkings[result.parkingKey];
        const school = formatTypicalValue(result.context.schoolHoliday);
        const nonHoliday = formatTypicalValue(result.context.nonHoliday);

        return `
            <article class="comparison-card">
                <h3>${currentParking ? currentParking.name : result.parkingKey}</h3>
                <div class="comparison-rows">
                    <div class="comparison-row">
                        <strong>Vacances scolaires</strong>
                        <p class="comparison-value">${school.value}</p>
                        <p class="comparison-sub">${school.sub}</p>
                    </div>
                    <div class="comparison-row">
                        <strong>Hors vacances</strong>
                        <p class="comparison-value">${nonHoliday.value}</p>
                        <p class="comparison-sub">${nonHoliday.sub}</p>
                    </div>
                </div>
            </article>
        `;
    }).join('');
}

async function fetchEtaToFull(parkingKey) {
    const response = await fetch(`/api/stats/eta-full?parkingKey=${encodeURIComponent(parkingKey)}`);

    if (!response.ok) {
        throw new Error(`ETA API error: ${response.status}`);
    }

    return response.json();
}

function formatMinuteOfDay(minuteOfDay) {
    if (!Number.isInteger(minuteOfDay)) {
        return '--:--';
    }

    const h = Math.floor(minuteOfDay / 60);
    const m = minuteOfDay % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

async function renderEtaWarnings(latestParkings) {
    const parkingKeys = Object.keys(latestParkings || {});

    await Promise.all(
        parkingKeys.map(async (parkingKey) => {
            const warningNode = document.getElementById(`warning-${parkingKey}`);
            if (!warningNode) {
                return;
            }

            try {
                const etaData = await fetchEtaToFull(parkingKey);
                if (!etaData.hasPrediction) {
                    warningNode.textContent = '';
                    warningNode.classList.remove('active');
                    return;
                }

                const thresholdLabel = `<${etaData.thresholdPercent || 10}%`;
                const messageParts = [];

                if (etaData.tangent && etaData.tangent.hasEstimate) {
                    if (etaData.tangent.etaMinutes <= 0) {
                        messageParts.push(`Tangente: ${thresholdLabel} deja atteint`);
                    } else if (etaData.tangent.etaMinutes <= 120) {
                        messageParts.push(`Tangente: ${thresholdLabel} dans ${etaData.tangent.etaMinutes} min`);
                    } else {
                        messageParts.push(`Tangente: ${thresholdLabel} vers ${formatMinuteOfDay(etaData.tangent.predictedMinute)}`);
                    }
                }

                if (etaData.nearestBelowThresholdStat && etaData.nearestBelowThresholdStat.hasEstimate) {
                    const statsTime = formatMinuteOfDay(etaData.nearestBelowThresholdStat.minuteOfDay);
                    const statsValue = etaData.nearestBelowThresholdStat.availabilityPercentage;
                    messageParts.push(`Stats proches: ${statsValue}% vers ${statsTime}`);
                }

                if (!messageParts.length) {
                    warningNode.textContent = '';
                    warningNode.classList.remove('active');
                    return;
                }

                warningNode.textContent = messageParts.join(' · ');
                warningNode.classList.add('active');
            } catch (error) {
                warningNode.textContent = '';
                warningNode.classList.remove('active');
            }
        })
    );
}

function formatHour(timestamp) {
    return new Date(timestamp).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

// Start auto-refresh
function startAutoRefresh() {
    if (autoRefreshInterval) {
        clearInterval(autoRefreshInterval);
    }
    autoRefreshInterval = setInterval(fetchParkingData, REFRESH_INTERVAL);
    console.log(`Auto-refresh started (interval: ${REFRESH_INTERVAL}ms)`);
}

// Stop auto-refresh
function stopAutoRefresh() {
    if (autoRefreshInterval) {
        clearInterval(autoRefreshInterval);
        autoRefreshInterval = null;
        console.log('Auto-refresh stopped');
    }
}

// Handle visibility change (pause refresh when tab is not visible)
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        stopAutoRefresh();
    } else {
        startAutoRefresh();
        fetchParkingData();
    }
});
