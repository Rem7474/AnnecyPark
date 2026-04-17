// Global variables
let autoRefreshInterval = null;
const REFRESH_INTERVAL = 10000; // 10 seconds

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    // Initial data fetch
    fetchParkingData();

    // Setup event listeners
    document.getElementById('refreshBtn').addEventListener('click', fetchParkingData);
    document.getElementById('autoRefresh').addEventListener('change', toggleAutoRefresh);

    // Start auto-refresh if checked
    if (document.getElementById('autoRefresh').checked) {
        startAutoRefresh();
    }
});

// Fetch parking data from API
async function fetchParkingData() {
    const container = document.getElementById('parkingsContainer');
    const refreshBtn = document.getElementById('refreshBtn');

    // Show loading state
    refreshBtn.classList.add('refreshing');

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
            const card = createParkingCard(parking);
            container.appendChild(card);
        });

    } catch (error) {
        console.error('Error fetching parking data:', error);
        container.innerHTML = `
            <div class="error-message">
                ⚠️ Erreur lors du chargement des données: ${error.message}
            </div>
        `;
    } finally {
        refreshBtn.classList.remove('refreshing');
    }
}

// Create a parking card element
function createParkingCard(parking) {
    const card = document.createElement('div');
    card.className = `parking-card ${parking.status}`;

    const percentageColor = getPercentageColor(parking.percentage);

    card.innerHTML = `
        <div class="parking-header">
            <div class="parking-name">${parking.name}</div>
            <span class="status-badge ${parking.status}">
                ${getStatusText(parking.status)}
            </span>
        </div>

        <div class="capacity-bar">
            <div class="capacity-label">
                <span>Taux d'occupation</span>
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
            📡 Mise à jour: ${parking.lastUpdate}
            ${parking.error ? `<br>❌ Erreur: ${parking.error}` : ''}
        </div>
    `;

    return card;
}

// Get status text
function getStatusText(status) {
    const statusTexts = {
        'available': '✓ Disponible',
        'moderate': '⚠ Modéré',
        'full': '✗ Complet',
        'error': '❌ Erreur'
    };
    return statusTexts[status] || 'Inconnu';
}

// Get color based on percentage
function getPercentageColor(percentage) {
    if (percentage > 80) return '#e74c3c'; // Red - Full
    if (percentage > 50) return '#f39c12'; // Orange - Moderate
    return '#27ae60'; // Green - Available
}

// Toggle auto-refresh
function toggleAutoRefresh(e) {
    if (e.target.checked) {
        startAutoRefresh();
    } else {
        stopAutoRefresh();
    }
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
        if (document.getElementById('autoRefresh').checked) {
            startAutoRefresh();
        }
    }
});
