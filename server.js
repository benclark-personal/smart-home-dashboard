const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const https = require('https');

const app = express();
const PORT = 3001;
const POLL_INTERVAL = 5 * 60 * 1000; // 5 minutes

// Ecowitt API configuration
const ECOWITT_CONFIG = {
  applicationKey: '314CCC848B60F2A73B9AB052F986295D',
  apiKey: 'f173d5a5-255c-42ec-b198-6e834019efab',
  mac: 'BC:FF:4D:11:3D:18'
};

// Room name mapping
const ROOM_NAMES = {
  indoor: 'Hallway (Console)',
  outdoor: 'Outside',
  ch1: 'Hallway',
  ch2: 'Living Room',
  ch3: 'Laundry Room',
  ch4: 'Dining Room',
  ch5: 'Kitchen',
  ch6: 'Bedroom 1',
  ch7: 'Bedroom 2',
  ch8: 'Bedroom 4'
};

// Initialise SQLite database
const db = new Database(path.join(__dirname, 'readings.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    channel TEXT NOT NULL,
    room_name TEXT NOT NULL,
    temperature_c REAL NOT NULL,
    humidity REAL,
    battery INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_timestamp ON readings(timestamp);
  CREATE INDEX IF NOT EXISTS idx_channel ON readings(channel);
`);

// Convert Fahrenheit to Celsius
function fahrenheitToCelsius(f) {
  return ((f - 32) * 5) / 9;
}

// Fetch data from Ecowitt API
function fetchEcowittData() {
  return new Promise((resolve, reject) => {
    const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${ECOWITT_CONFIG.applicationKey}&api_key=${ECOWITT_CONFIG.apiKey}&mac=${ECOWITT_CONFIG.mac}&call_back=all`;

    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

// Parse and store readings
function parseAndStoreReadings(data) {
  if (data.code !== 0 || !data.data) {
    console.error('API error:', data.msg || 'Unknown error');
    return null;
  }

  const readings = [];
  const sensorData = data.data;
  const timestamp = new Date().toISOString();

  // Indoor sensor (console)
  if (sensorData.indoor) {
    const indoor = sensorData.indoor;
    const tempC = fahrenheitToCelsius(parseFloat(indoor.temperature?.value || 0));
    const humidity = parseFloat(indoor.humidity?.value || 0);

    readings.push({
      channel: 'indoor',
      roomName: ROOM_NAMES.indoor,
      temperatureC: Math.round(tempC * 10) / 10,
      humidity: humidity,
      battery: null
    });
  }

  // Outdoor sensor
  if (sensorData.outdoor) {
    const outdoor = sensorData.outdoor;
    const tempC = fahrenheitToCelsius(parseFloat(outdoor.temperature?.value || 0));
    const humidity = parseFloat(outdoor.humidity?.value || 0);

    readings.push({
      channel: 'outdoor',
      roomName: ROOM_NAMES.outdoor,
      temperatureC: Math.round(tempC * 10) / 10,
      humidity: humidity,
      battery: null
    });
  }

  // WH31 multi-channel sensors (ch1-ch8)
  for (let i = 1; i <= 8; i++) {
    const channelKey = `temp_and_humidity_ch${i}`;
    const channel = sensorData[channelKey];

    if (channel) {
      const tempC = fahrenheitToCelsius(parseFloat(channel.temperature?.value || 0));
      const humidity = parseFloat(channel.humidity?.value || 0);
      const battery = parseInt(channel.battery?.value || 0);

      readings.push({
        channel: `ch${i}`,
        roomName: ROOM_NAMES[`ch${i}`] || `Channel ${i}`,
        temperatureC: Math.round(tempC * 10) / 10,
        humidity: humidity,
        battery: battery
      });
    }
  }

  // Store readings in database
  const insertStmt = db.prepare(`
    INSERT INTO readings (timestamp, channel, room_name, temperature_c, humidity, battery)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((readings) => {
    for (const r of readings) {
      insertStmt.run(timestamp, r.channel, r.roomName, r.temperatureC, r.humidity, r.battery);
    }
  });

  insertMany(readings);
  console.log(`[${timestamp}] Stored ${readings.length} readings`);

  return readings;
}

// Get latest readings from database
function getLatestReadings() {
  const rows = db.prepare(`
    SELECT r.*
    FROM readings r
    INNER JOIN (
      SELECT channel, MAX(timestamp) as max_ts
      FROM readings
      GROUP BY channel
    ) latest ON r.channel = latest.channel AND r.timestamp = latest.max_ts
    ORDER BY r.channel
  `).all();

  return rows;
}

// Get historical readings for charts
function getHistoricalReadings(hours = 24) {
  const rows = db.prepare(`
    SELECT channel, room_name, temperature_c, humidity, timestamp
    FROM readings
    WHERE timestamp > datetime('now', '-${hours} hours')
    ORDER BY timestamp ASC
  `).all();

  return rows;
}

// Calculate statistics
function calculateStats(readings) {
  // Filter to indoor rooms only (exclude outdoor)
  const indoorReadings = readings.filter(r => r.channel !== 'outdoor');

  if (indoorReadings.length === 0) {
    return { average: null, warmest: null, coldest: null };
  }

  const temps = indoorReadings.map(r => r.temperature_c);
  const average = temps.reduce((a, b) => a + b, 0) / temps.length;

  const warmest = indoorReadings.reduce((a, b) => a.temperature_c > b.temperature_c ? a : b);
  const coldest = indoorReadings.reduce((a, b) => a.temperature_c < b.temperature_c ? a : b);

  return {
    average: Math.round(average * 10) / 10,
    warmest: { room: warmest.room_name, temp: warmest.temperature_c },
    coldest: { room: coldest.room_name, temp: coldest.temperature_c }
  };
}

// Polling function
let lastPollTime = null;
let lastReadings = [];

async function pollEcowitt() {
  try {
    console.log('Polling Ecowitt API...');
    const data = await fetchEcowittData();
    const readings = parseAndStoreReadings(data);
    if (readings) {
      lastReadings = readings;
      lastPollTime = new Date();
    }
  } catch (error) {
    console.error('Poll error:', error.message);
  }
}

// API endpoints
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/current', (req, res) => {
  const readings = getLatestReadings();
  const stats = calculateStats(readings);

  res.json({
    readings,
    stats,
    lastPoll: lastPollTime,
    nextPoll: lastPollTime ? new Date(lastPollTime.getTime() + POLL_INTERVAL) : null
  });
});

app.get('/api/history', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const readings = getHistoricalReadings(hours);
  res.json(readings);
});

app.get('/api/poll', async (req, res) => {
  await pollEcowitt();
  const readings = getLatestReadings();
  const stats = calculateStats(readings);
  res.json({ success: true, readings, stats });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Smart Home Dashboard running on http://0.0.0.0:${PORT}`);

  // Initial poll
  pollEcowitt();

  // Schedule regular polling
  setInterval(pollEcowitt, POLL_INTERVAL);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nShutting down...');
  db.close();
  process.exit(0);
});
