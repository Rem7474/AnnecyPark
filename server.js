const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Parking locations data
const parkings = {
  bonlieu: {
    name: 'Parking Bonlieu',
    maxCapacity: 652,
    url: 'https://annecy-mobilites.latitude-cartagene.com/api/availability?type=parking&id=poi:parking:02'
  },
  courier: {
    name: 'Parking Courier',
    maxCapacity: 757,
    url: 'https://annecy-mobilites.latitude-cartagene.com/api/availability?type=parking&id=poi:parking:04'
  },
  hotelDeVille: {
    name: 'Parking Hotel de Ville',
    maxCapacity: 408,
    url: 'https://annecy-mobilites.latitude-cartagene.com/api/availability?type=parking&id=poi:parking:02'
  }
};

// Function to fetch parking data from API
async function fetchParkingData(parking) {
  try {
    const response = await fetchURL(parking.url);
    const data = JSON.parse(response);
    
    // Extract available spaces from API response
    const available = data.available || 0;
    const occupied = parking.maxCapacity - available;
    const percentage = Math.round((available / parking.maxCapacity) * 100);
    
    return {
      name: parking.name,
      available: available,
      occupied: occupied,
      maxCapacity: parking.maxCapacity,
      percentage: percentage,
      lastUpdate: new Date().toLocaleTimeString('fr-FR'),
      status: percentage > 50 ? 'available' : percentage > 20 ? 'moderate' : 'full'
    };
  } catch (error) {
    console.error(`Error fetching data for ${parking.name}:`, error);
    return {
      name: parking.name,
      available: 0,
      occupied: 0,
      maxCapacity: parking.maxCapacity,
      percentage: 0,
      lastUpdate: new Date().toLocaleTimeString('fr-FR'),
      status: 'error',
      error: error.message
    };
  }
}

// Helper function to fetch URL data
function fetchURL(url) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https');
    const protocol = isHttps ? require('https') : http;
    
    protocol.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        resolve(data);
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

// API endpoint to get all parking data
app.get('/api/parkings', async (req, res) => {
  try {
    const bonlieu = await fetchParkingData(parkings.bonlieu);
    const courier = await fetchParkingData(parkings.courier);
    const hotelDeVille = await fetchParkingData(parkings.hotelDeVille);
    
    res.json({
      timestamp: new Date().toISOString(),
      parkings: {
        bonlieu,
        courier,
        hotelDeVille
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch parking data', details: error.message });
  }
});

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`Parking Dashboard server is running at http://localhost:${PORT}`);
});
