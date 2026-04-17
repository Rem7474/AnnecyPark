// Global variables
let autoRefreshInterval = null;
const REFRESH_INTERVAL = 10000; // 10 seconds
let dayHistoryPoints = [];
const FRENCH_WEEKDAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

const PARKING_COLORS = {
    bonlieu: '#2a7a51',
    courier: '#a37624',
    hotelDeVille: '#4a7188'
};

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    // Initial data fetch
    fetchParkingData();

    // Always keep data fresh without manual controls.
    startAutoRefresh();
});

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

        // Update last update time
        document.getElementById('lastUpdate').textContent = new Date().toLocaleTimeString('fr-FR');

        // Clear container
        container.innerHTML = '';

        // Render parking cards
        Object.keys(data.parkings).forEach(key => {
            const parking = data.parkings[key];
            const card = createParkingCard(key, parking);
            container.appendChild(card);
        });

        dayHistoryPoints = await fetchDayHistory();
        renderHistoryChart(data.parkings, dayHistoryPoints);
        renderHistoryInsight(data.parkings);
        renderTypicalComparison(data.parkings);
        renderEtaWarnings(data.parkings);

    } catch (error) {
        console.error('Error fetching parking data:', error);
        container.innerHTML = `
            <div class="error-message">
                ⚠️ Erreur lors du chargement des données: ${error.message}
            </div>
        `;
    } finally {
        container.classList.remove('refreshing');
    }
}

// Create a parking card element
function createParkingCard(parkingKey, parking) {
    const card = document.createElement('div');
    card.className = `parking-card ${parking.status}`;

    card.innerHTML = `
        <div class="parking-header">
            <div class="parking-name">${parking.name}</div>
            <span class="status-badge ${parking.status}">
                ${getStatusText(parking.status)}
            </span>
        </div>

        <div class="capacity-bar">
            <div class="capacity-label">
                <span>Taux de disponibilite</span>
                <strong>${parking.percentage}%</strong>
            </div>
            <div class="progress-bar">
                <div class="progress-fill" style="width: ${parking.percentage}%"></div>
            </div>
        </div>

        <div class="parking-stats">
            <div class="stat-item">
                <div class="stat-number">${parking.available}</div>
                <div class="stat-label">Places libres</div>
            </div>
            <div class="stat-item">
                <div class="stat-number">${parking.maxCapacity}</div>
                <div class="stat-label">Capacité totale</div>
            </div>
        </div>

        <div class="parking-footer">
            Mise a jour: ${parking.lastUpdate}
            ${parking.error ? `<br>Erreur: ${parking.error}` : ''}
            <p class="parking-warning" id="warning-${parkingKey}"></p>
        </div>
    `;

    return card;
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

async function fetchDayHistory() {
    const queryDate = getTodayKey();
    const response = await fetch(`/api/history/day?date=${queryDate}`);

    if (!response.ok) {
        throw new Error(`History API error: ${response.status}`);
    }

    const payload = await response.json();
    return Array.isArray(payload.points) ? payload.points : [];
}

function renderHistoryChart(latestParkings, historyPoints) {
    const chart = document.getElementById('historyChart');
    const legend = document.getElementById('historyLegend');
    const timeRange = document.getElementById('historyTimeRange');

    if (!chart || !legend || !timeRange) {
        return;
    }

    const width = 940;
    const height = 320;
    const margin = { top: 18, right: 18, bottom: 34, left: 44 };
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;

    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;

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

    const parkingKeys = Object.keys(latestParkings || {});
    const linePaths = parkingKeys.map((key) => {
        const color = PARKING_COLORS[key] || '#6a756b';
        const series = historyPoints
            .filter((point) => point.parkings && point.parkings[key] && Number.isFinite(point.parkings[key].percentage))
            .map((point) => ({
                x: margin.left + ((new Date(point.timestamp).getTime() - dayStart) / (dayEnd - dayStart)) * innerWidth,
                y: margin.top + innerHeight - (point.parkings[key].percentage / 100) * innerHeight
            }));

        if (!series.length) {
            return '';
        }

        const d = series.map((p, index) => `${index === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');
        return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />`;
    }).join('');

    const noDataLabel = historyPoints.length
        ? ''
        : `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" fill="#6a746b" font-size="13">Les points de la journee apparaitront ici apres les premiers releves.</text>`;

    chart.innerHTML = `
        <rect x="0" y="0" width="${width}" height="${height}" fill="transparent" />
        ${gridLines}
        ${xTicks}
        ${linePaths}
        ${noDataLabel}
    `;

    legend.innerHTML = parkingKeys.map((key) => {
        const parking = latestParkings[key];
        const value = parking && Number.isFinite(parking.percentage) ? `${parking.percentage}%` : '--';
        const color = PARKING_COLORS[key] || '#6a756b';
        return `
            <div class="legend-item">
                <span class="legend-swatch" style="background:${color}"></span>
                <span>${parking.name}</span>
                <span class="legend-value">${value}</span>
            </div>
        `;
    }).join('');
}

function renderHistoryInsight(latestParkings) {
    const insightNode = document.getElementById('historyInsight');
    if (!insightNode) {
        return;
    }

    const points = dayHistoryPoints;
    const parkingKeys = Object.keys(latestParkings || {});

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

                if (etaData.etaMinutes <= 0) {
                    warningNode.textContent = 'Habituellement complet a cette heure';
                    warningNode.classList.add('active');
                    return;
                }

                if (etaData.etaMinutes <= 120) {
                    warningNode.textContent = `Habituellement complet dans ${etaData.etaMinutes} min`;
                    warningNode.classList.add('active');
                    return;
                }

                warningNode.textContent = `Habituellement complet vers ${formatMinuteOfDay(etaData.predictedFullMinute)}`;
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
