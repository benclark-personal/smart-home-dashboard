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

// Supabase configuration for cloud backup
const SUPABASE_CONFIG = {
  url: 'https://mtrjhzrzmqbahzipjisa.supabase.co',
  serviceKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im10cmpoenJ6bXFiYWh6aXBqaXNhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjQ5NjQ5NSwiZXhwIjoyMDgyMDcyNDk1fQ.mRjXNMVJBF4uq-H4_KvxEmNuO98L8jaQ3JVYJM4J9BE'
};

// Hildebrand Bright API configuration (smart meter data)
const BRIGHT_CONFIG = {
  username: 'benclark.mail@gmail.com',
  password: 'Hello99&1',
  applicationId: 'b0f1b774-a586-4f72-9edd-27ead8aa7a8d',
  baseUrl: 'https://api.glowmarkt.com/api/v0-1',
  resources: {
    electricityConsumption: 'd32d26bc-b8f8-4f43-b098-49aa174f6df7',
    electricityCost: '2ee42fba-980f-426d-835e-ab1604491bb0',
    gasConsumption: '695a8307-7f36-4a47-985d-761136c79028',
    gasCost: '35d0e593-dada-4a2c-9fe7-d7321ac2fdf4'
  }
};

let brightToken = null;
let brightTokenExpiry = null;

// Room name mapping
const ROOM_NAMES = {
  indoor: 'Dining Room (Console)',
  outdoor: 'Outside',
  ch1: 'Living Room',
  ch2: 'Entrance Hall',
  ch3: 'Laundry',
  ch4: 'Master Bedroom',
  ch5: 'Layla Room',
  ch6: 'Channel 6',
  ch7: 'Channel 7',
  ch8: 'Channel 8'
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

  CREATE TABLE IF NOT EXISTS energy_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME NOT NULL,
    type TEXT NOT NULL,
    kwh REAL NOT NULL,
    cost_pence REAL
  );

  CREATE INDEX IF NOT EXISTS idx_energy_timestamp ON energy_readings(timestamp);
  CREATE INDEX IF NOT EXISTS idx_energy_type ON energy_readings(type);
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

// Bright API authentication
function authenticateBright() {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      username: BRIGHT_CONFIG.username,
      password: BRIGHT_CONFIG.password
    });

    const options = {
      hostname: 'api.glowmarkt.com',
      port: 443,
      path: '/api/v0-1/auth',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'applicationId': BRIGHT_CONFIG.applicationId,
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.valid && result.token) {
            brightToken = result.token;
            brightTokenExpiry = result.exp * 1000; // Convert to ms
            console.log('[Bright] Authenticated successfully');
            resolve(result.token);
          } else {
            reject(new Error('Bright authentication failed'));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// Get valid Bright token (refresh if needed)
async function getBrightToken() {
  if (brightToken && brightTokenExpiry && Date.now() < brightTokenExpiry - 3600000) {
    return brightToken;
  }
  return await authenticateBright();
}

// Fetch energy readings from Bright API
function fetchBrightReadings(resourceId, type, fromDate, toDate) {
  return new Promise(async (resolve, reject) => {
    try {
      const token = await getBrightToken();
      const fromStr = fromDate.toISOString().slice(0, 19);
      const toStr = toDate.toISOString().slice(0, 19);

      const path = `/api/v0-1/resource/${resourceId}/readings?from=${fromStr}&to=${toStr}&period=PT30M&function=sum`;

      const options = {
        hostname: 'api.glowmarkt.com',
        port: 443,
        path: path,
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'applicationId': BRIGHT_CONFIG.applicationId,
          'token': token
        }
      };

      console.log(`[Bright] Fetching ${type}: ${path}`);

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            console.log(`[Bright] ${type} response status: ${result.status}, data count: ${result.data ? result.data.length : 0}`);
            if (result.data) {
              resolve(result.data.map(r => ({
                timestamp: new Date(r[0] * 1000).toISOString(),
                type: type,
                kwh: r[1]
              })));
            } else {
              console.log(`[Bright] ${type} no data in response:`, JSON.stringify(result).slice(0, 200));
              resolve([]);
            }
          } catch (e) {
            console.error(`[Bright] ${type} parse error:`, e.message, data.slice(0, 200));
            reject(e);
          }
        });
      });

      req.on('error', (e) => {
        console.error(`[Bright] ${type} request error:`, e.message);
        reject(e);
      });
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

// Poll Bright API for energy data
async function pollBright() {
  try {
    console.log('[Bright] Polling energy data...');

    // Get yesterday's data (DCC data is delayed)
    const toDate = new Date();
    toDate.setHours(0, 0, 0, 0); // Start of today
    const fromDate = new Date(toDate);
    fromDate.setDate(fromDate.getDate() - 1); // Yesterday

    // Fetch sequentially - Bright API doesn't handle concurrent requests well
    const elecData = await fetchBrightReadings(BRIGHT_CONFIG.resources.electricityConsumption, 'electricity', fromDate, toDate);
    const gasData = await fetchBrightReadings(BRIGHT_CONFIG.resources.gasConsumption, 'gas', fromDate, toDate);

    // Store in database (avoid duplicates)
    const insertStmt = db.prepare(`
      INSERT OR REPLACE INTO energy_readings (timestamp, type, kwh, cost_pence)
      VALUES (?, ?, ?, NULL)
    `);

    let count = 0;
    const insertMany = db.transaction((readings) => {
      for (const r of readings) {
        if (r.kwh > 0) {
          insertStmt.run(r.timestamp, r.type, r.kwh);
          count++;
        }
      }
    });

    const allReadings = [...elecData, ...gasData];
    insertMany(allReadings);
    console.log(`[Bright] Stored ${count} energy readings locally`);

    // Sync to Supabase cloud
    const validReadings = allReadings.filter(r => r.kwh > 0);
    if (validReadings.length > 0) {
      await syncEnergyToSupabase(validReadings);
    }
  } catch (error) {
    console.error('[Bright] Poll error:', error.message);
  }
}

// Sync readings to Supabase cloud
function syncToSupabase(readings, timestamp) {
  return new Promise((resolve, reject) => {
    const supabaseReadings = readings.map(r => ({
      timestamp: timestamp,
      channel: r.channel,
      room_name: r.roomName,
      temperature_c: r.temperatureC,
      humidity: r.humidity,
      battery: r.battery
    }));

    const postData = JSON.stringify(supabaseReadings);
    const url = new URL(`${SUPABASE_CONFIG.url}/rest/v1/readings`);

    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_CONFIG.serviceKey,
        'Authorization': `Bearer ${SUPABASE_CONFIG.serviceKey}`,
        'Prefer': 'return=minimal',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[Supabase] Synced ${readings.length} readings to cloud`);
          resolve(true);
        } else {
          console.error(`[Supabase] Sync failed (${res.statusCode}):`, data);
          resolve(false); // Don't reject - local storage still works
        }
      });
    });

    req.on('error', (e) => {
      console.error('[Supabase] Sync error:', e.message);
      resolve(false); // Don't reject - local storage still works
    });

    req.write(postData);
    req.end();
  });
}

// Sync energy readings to Supabase cloud
function syncEnergyToSupabase(readings) {
  return new Promise((resolve, reject) => {
    if (!readings || readings.length === 0) {
      resolve(true);
      return;
    }

    const supabaseReadings = readings.map(r => ({
      timestamp: r.timestamp,
      type: r.type,
      kwh: r.kwh,
      cost_pence: null
    }));

    const postData = JSON.stringify(supabaseReadings);
    const url = new URL(`${SUPABASE_CONFIG.url}/rest/v1/energy_readings`);

    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_CONFIG.serviceKey,
        'Authorization': `Bearer ${SUPABASE_CONFIG.serviceKey}`,
        'Prefer': 'resolution=merge-duplicates',  // Upsert on conflict
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[Supabase] Synced ${readings.length} energy readings to cloud`);
          resolve(true);
        } else {
          console.error(`[Supabase] Energy sync failed (${res.statusCode}):`, data);
          resolve(false); // Don't reject - local storage still works
        }
      });
    });

    req.on('error', (e) => {
      console.error('[Supabase] Energy sync error:', e.message);
      resolve(false); // Don't reject - local storage still works
    });

    req.write(postData);
    req.end();
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
  console.log(`[${timestamp}] Stored ${readings.length} readings locally`);

  return { readings, timestamp };
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

// Get daily statistics per room
function getDailyStats(days = 7) {
  const rows = db.prepare(`
    SELECT
      date(timestamp) as date,
      channel,
      room_name,
      MIN(temperature_c) as min_temp,
      MAX(temperature_c) as max_temp,
      ROUND(AVG(temperature_c), 1) as avg_temp,
      ROUND(AVG(humidity), 1) as avg_humidity,
      COUNT(*) as reading_count
    FROM readings
    WHERE timestamp > datetime('now', '-${days} days')
    GROUP BY date(timestamp), channel
    ORDER BY date DESC, channel
  `).all();

  return rows;
}

// Calculate temperature change rates (heat-up/cool-down)
function getTemperatureRates(hours = 24) {
  const rows = db.prepare(`
    SELECT channel, room_name, temperature_c, timestamp
    FROM readings
    WHERE timestamp > datetime('now', '-${hours} hours')
    ORDER BY channel, timestamp ASC
  `).all();

  // Group by channel and calculate rates
  const byChannel = {};
  for (const row of rows) {
    if (!byChannel[row.channel]) {
      byChannel[row.channel] = {
        channel: row.channel,
        roomName: row.room_name,
        readings: []
      };
    }
    byChannel[row.channel].readings.push({
      temp: row.temperature_c,
      time: new Date(row.timestamp)
    });
  }

  // Calculate rates for each channel
  const rates = [];
  for (const channel of Object.values(byChannel)) {
    if (channel.readings.length < 2) continue;

    const changes = [];
    for (let i = 1; i < channel.readings.length; i++) {
      const prev = channel.readings[i - 1];
      const curr = channel.readings[i];
      const timeDiffHours = (curr.time - prev.time) / (1000 * 60 * 60);
      const tempDiff = curr.temp - prev.temp;
      const ratePerHour = timeDiffHours > 0 ? tempDiff / timeDiffHours : 0;
      changes.push({ tempDiff, ratePerHour, heating: tempDiff > 0 });
    }

    const heatingChanges = changes.filter(c => c.heating && c.ratePerHour > 0.1);
    const coolingChanges = changes.filter(c => !c.heating && c.ratePerHour < -0.1);

    rates.push({
      channel: channel.channel,
      roomName: channel.roomName,
      avgHeatRate: heatingChanges.length > 0
        ? Math.round(heatingChanges.reduce((a, b) => a + b.ratePerHour, 0) / heatingChanges.length * 10) / 10
        : 0,
      avgCoolRate: coolingChanges.length > 0
        ? Math.round(coolingChanges.reduce((a, b) => a + b.ratePerHour, 0) / coolingChanges.length * 10) / 10
        : 0,
      maxTemp: Math.max(...channel.readings.map(r => r.temp)),
      minTemp: Math.min(...channel.readings.map(r => r.temp)),
      tempSwing: Math.round((Math.max(...channel.readings.map(r => r.temp)) - Math.min(...channel.readings.map(r => r.temp))) * 10) / 10
    });
  }

  return rates;
}

// Get temperature differentials between rooms
function getTemperatureDifferentials() {
  const latest = getLatestReadings();
  const indoor = latest.filter(r => r.channel !== 'outdoor');

  if (indoor.length === 0) return { differentials: [], baseline: null };

  // Use entrance hall as baseline (thermostat location) or house average
  const entranceHall = indoor.find(r => r.channel === 'ch2');
  const baseline = entranceHall ? entranceHall.temperature_c :
    indoor.reduce((a, b) => a + b.temperature_c, 0) / indoor.length;

  const differentials = indoor.map(r => ({
    channel: r.channel,
    roomName: r.room_name,
    temperature: r.temperature_c,
    differential: Math.round((r.temperature_c - baseline) * 10) / 10,
    humidity: r.humidity
  }));

  return {
    baseline: Math.round(baseline * 10) / 10,
    baselineSource: entranceHall ? 'Entrance Hall' : 'House Average',
    differentials: differentials.sort((a, b) => b.differential - a.differential)
  };
}

// Export data as CSV
function exportCSV(hours = 24) {
  const rows = db.prepare(`
    SELECT timestamp, channel, room_name, temperature_c, humidity, battery
    FROM readings
    WHERE timestamp > datetime('now', '-${hours} hours')
    ORDER BY timestamp DESC
  `).all();

  const header = 'timestamp,channel,room_name,temperature_c,humidity,battery\n';
  const csv = rows.map(r =>
    `${r.timestamp},${r.channel},${r.room_name},${r.temperature_c},${r.humidity || ''},${r.battery || ''}`
  ).join('\n');

  return header + csv;
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
    const result = parseAndStoreReadings(data);
    if (result) {
      lastReadings = result.readings;
      lastPollTime = new Date();
      // Sync to Supabase cloud (non-blocking)
      syncToSupabase(result.readings, result.timestamp);
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

// Daily statistics endpoint
app.get('/api/stats/daily', (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const stats = getDailyStats(days);
  res.json(stats);
});

// Temperature rates endpoint (heat-up/cool-down analysis)
app.get('/api/stats/rates', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const rates = getTemperatureRates(hours);
  res.json(rates);
});

// Temperature differentials endpoint
app.get('/api/stats/differentials', (req, res) => {
  const differentials = getTemperatureDifferentials();
  res.json(differentials);
});

// CSV export endpoint
app.get('/api/export/csv', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const csv = exportCSV(hours);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=temperature-data-${hours}h.csv`);
  res.send(csv);
});

// Database info endpoint
app.get('/api/info', (req, res) => {
  const info = db.prepare(`
    SELECT
      COUNT(*) as total_readings,
      MIN(timestamp) as first_reading,
      MAX(timestamp) as last_reading,
      COUNT(DISTINCT channel) as sensor_count,
      COUNT(DISTINCT date(timestamp)) as days_of_data
    FROM readings
  `).get();
  res.json(info);
});

// Heating schedule for analysis
const HEATING_SCHEDULE = {
  morning: { start: '06:50', end: '09:30' },
  evening: { start: '15:30', end: '22:00' }
};
const THERMOSTAT_SETTING = 25;

// Warm-up rate analysis - how quickly rooms heat up when heating starts
app.get('/api/analysis/warmup', (req, res) => {
  const period = req.query.period || 'morning'; // morning or evening
  const days = parseInt(req.query.days) || 7;
  const schedule = HEATING_SCHEDULE[period];

  const results = db.prepare(`
    WITH heating_start AS (
      SELECT
        date(timestamp) as day,
        room_name,
        temperature_c as start_temp,
        timestamp as start_time
      FROM readings
      WHERE time(timestamp) BETWEEN time(?, '-10 minutes') AND time(?, '+10 minutes')
        AND timestamp >= datetime('now', '-' || ? || ' days')
        AND room_name != 'Outside'
    ),
    heating_peak AS (
      SELECT
        date(timestamp) as day,
        room_name,
        MAX(temperature_c) as peak_temp,
        timestamp as peak_time
      FROM readings
      WHERE time(timestamp) BETWEEN time(?) AND time(?)
        AND timestamp >= datetime('now', '-' || ? || ' days')
        AND room_name != 'Outside'
      GROUP BY date(timestamp), room_name
    )
    SELECT
      hs.room_name,
      AVG(hp.peak_temp - hs.start_temp) as avg_temp_rise,
      AVG((julianday(hp.peak_time) - julianday(hs.start_time)) * 24 * 60) as avg_mins_to_peak,
      COUNT(*) as sample_days
    FROM heating_start hs
    JOIN heating_peak hp ON hs.day = hp.day AND hs.room_name = hp.room_name
    GROUP BY hs.room_name
    ORDER BY avg_temp_rise DESC
  `).all(schedule.start, schedule.start, days, schedule.start, schedule.end, days);

  res.json({ period, schedule, results });
});

// Cool-down rate analysis - how quickly rooms cool after heating stops
app.get('/api/analysis/cooldown', (req, res) => {
  const period = req.query.period || 'morning'; // morning or evening
  const days = parseInt(req.query.days) || 7;
  const schedule = HEATING_SCHEDULE[period];

  // Calculate time 2 hours after heating ends
  const endHour = parseInt(schedule.end.split(':')[0]);
  const endMin = parseInt(schedule.end.split(':')[1]);
  const twoHoursLater = `${String(endHour + 2).padStart(2, '0')}:${String(endMin).padStart(2, '0')}`;

  const results = db.prepare(`
    WITH heating_end AS (
      SELECT
        date(timestamp) as day,
        room_name,
        temperature_c as end_temp
      FROM readings
      WHERE time(timestamp) BETWEEN time(?, '-10 minutes') AND time(?, '+10 minutes')
        AND timestamp >= datetime('now', '-' || ? || ' days')
        AND room_name != 'Outside'
    ),
    two_hours_later AS (
      SELECT
        date(timestamp) as day,
        room_name,
        temperature_c as later_temp
      FROM readings
      WHERE time(timestamp) BETWEEN time(?, '-10 minutes') AND time(?, '+10 minutes')
        AND timestamp >= datetime('now', '-' || ? || ' days')
        AND room_name != 'Outside'
    )
    SELECT
      he.room_name,
      AVG(he.end_temp - thl.later_temp) as avg_temp_drop,
      AVG(he.end_temp) as avg_start_temp,
      AVG(thl.later_temp) as avg_end_temp,
      COUNT(*) as sample_days
    FROM heating_end he
    JOIN two_hours_later thl ON he.day = thl.day AND he.room_name = thl.room_name
    GROUP BY he.room_name
    ORDER BY avg_temp_drop DESC
  `).all(schedule.end, schedule.end, days, twoHoursLater, twoHoursLater, days);

  res.json({ period, schedule, measurementWindow: '2 hours after heating off', results });
});

// Morning vs Evening comparison
app.get('/api/analysis/morning-vs-evening', (req, res) => {
  const days = parseInt(req.query.days) || 7;

  // Get cool-down rates for both periods
  const morningCooldown = db.prepare(`
    WITH morning_end AS (
      SELECT date(timestamp) as day, room_name, temperature_c as temp
      FROM readings
      WHERE time(timestamp) BETWEEN '09:20' AND '09:40'
        AND timestamp >= datetime('now', '-' || ? || ' days')
        AND room_name != 'Outside'
    ),
    morning_later AS (
      SELECT date(timestamp) as day, room_name, temperature_c as temp
      FROM readings
      WHERE time(timestamp) BETWEEN '11:20' AND '11:40'
        AND timestamp >= datetime('now', '-' || ? || ' days')
        AND room_name != 'Outside'
    )
    SELECT me.room_name, AVG(me.temp - ml.temp) as avg_drop
    FROM morning_end me
    JOIN morning_later ml ON me.day = ml.day AND me.room_name = ml.room_name
    GROUP BY me.room_name
  `).all(days, days);

  const eveningCooldown = db.prepare(`
    WITH evening_end AS (
      SELECT date(timestamp) as day, room_name, temperature_c as temp
      FROM readings
      WHERE time(timestamp) BETWEEN '21:50' AND '22:10'
        AND timestamp >= datetime('now', '-' || ? || ' days')
        AND room_name != 'Outside'
    ),
    evening_later AS (
      SELECT date(timestamp) as day, room_name, temperature_c as temp
      FROM readings
      WHERE time(timestamp) BETWEEN '23:50' AND '00:10'
        AND timestamp >= datetime('now', '-' || ? || ' days')
        AND room_name != 'Outside'
    )
    SELECT ee.room_name, AVG(ee.temp - el.temp) as avg_drop
    FROM evening_end ee
    JOIN evening_later el ON ee.day = el.day AND ee.room_name = el.room_name
    GROUP BY ee.room_name
  `).all(days, days);

  res.json({
    morning: { period: '09:30 to 11:30', results: morningCooldown },
    evening: { period: '22:00 to 00:00', results: eveningCooldown }
  });
});

// Warm-up rate comparison - morning vs evening
app.get('/api/analysis/warmup-comparison', (req, res) => {
  const days = parseInt(req.query.days) || 7;

  // Get warm-up rates for morning period (06:50 - 09:30)
  const morningWarmup = db.prepare(`
    WITH morning_start AS (
      SELECT date(timestamp) as day, room_name, temperature_c as temp
      FROM readings
      WHERE time(timestamp) BETWEEN '06:40' AND '07:00'
        AND timestamp >= datetime('now', '-' || ? || ' days')
        AND room_name != 'Outside'
    ),
    morning_peak AS (
      SELECT date(timestamp) as day, room_name, MAX(temperature_c) as temp
      FROM readings
      WHERE time(timestamp) BETWEEN '06:50' AND '09:30'
        AND timestamp >= datetime('now', '-' || ? || ' days')
        AND room_name != 'Outside'
      GROUP BY date(timestamp), room_name
    )
    SELECT ms.room_name, AVG(mp.temp - ms.temp) as avg_rise
    FROM morning_start ms
    JOIN morning_peak mp ON ms.day = mp.day AND ms.room_name = mp.room_name
    GROUP BY ms.room_name
  `).all(days, days);

  // Get warm-up rates for evening period (15:30 - 22:00)
  const eveningWarmup = db.prepare(`
    WITH evening_start AS (
      SELECT date(timestamp) as day, room_name, temperature_c as temp
      FROM readings
      WHERE time(timestamp) BETWEEN '15:20' AND '15:40'
        AND timestamp >= datetime('now', '-' || ? || ' days')
        AND room_name != 'Outside'
    ),
    evening_peak AS (
      SELECT date(timestamp) as day, room_name, MAX(temperature_c) as temp
      FROM readings
      WHERE time(timestamp) BETWEEN '15:30' AND '22:00'
        AND timestamp >= datetime('now', '-' || ? || ' days')
        AND room_name != 'Outside'
      GROUP BY date(timestamp), room_name
    )
    SELECT es.room_name, AVG(ep.temp - es.temp) as avg_rise
    FROM evening_start es
    JOIN evening_peak ep ON es.day = ep.day AND es.room_name = ep.room_name
    GROUP BY es.room_name
  `).all(days, days);

  res.json({
    morning: { period: '06:50 to 09:30', results: morningWarmup },
    evening: { period: '15:30 to 22:00', results: eveningWarmup }
  });
});

// Hallway vs Thermostat analysis
app.get('/api/analysis/thermostat', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;

  const hallwayData = db.prepare(`
    SELECT
      temperature_c,
      timestamp,
      CASE
        WHEN time(timestamp) BETWEEN '06:50' AND '09:30' THEN 'morning_heating'
        WHEN time(timestamp) BETWEEN '15:30' AND '22:00' THEN 'evening_heating'
        ELSE 'heating_off'
      END as period
    FROM readings
    WHERE room_name = 'Entrance Hall'
      AND timestamp >= datetime('now', '-' || ? || ' hours')
    ORDER BY timestamp
  `).all(hours);

  const stats = {
    thermostat_setting: THERMOSTAT_SETTING,
    readings: hallwayData.length,
    avg_temp: hallwayData.reduce((sum, r) => sum + r.temperature_c, 0) / hallwayData.length,
    max_temp: Math.max(...hallwayData.map(r => r.temperature_c)),
    min_temp: Math.min(...hallwayData.map(r => r.temperature_c)),
    times_reached_target: hallwayData.filter(r => r.temperature_c >= THERMOSTAT_SETTING).length,
    pct_at_target: (hallwayData.filter(r => r.temperature_c >= THERMOSTAT_SETTING).length / hallwayData.length * 100).toFixed(1),
    avg_below_target: (THERMOSTAT_SETTING - (hallwayData.reduce((sum, r) => sum + r.temperature_c, 0) / hallwayData.length)).toFixed(1)
  };

  // By period
  const byPeriod = {};
  ['morning_heating', 'evening_heating', 'heating_off'].forEach(period => {
    const periodData = hallwayData.filter(r => r.period === period);
    if (periodData.length > 0) {
      byPeriod[period] = {
        avg_temp: (periodData.reduce((sum, r) => sum + r.temperature_c, 0) / periodData.length).toFixed(1),
        readings: periodData.length
      };
    }
  });

  res.json({ stats, byPeriod });
});

// Room comparison - rank rooms by various metrics
app.get('/api/analysis/room-ranking', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;

  const rankings = db.prepare(`
    SELECT
      room_name,
      AVG(temperature_c) as avg_temp,
      MIN(temperature_c) as min_temp,
      MAX(temperature_c) as max_temp,
      MAX(temperature_c) - MIN(temperature_c) as temp_range,
      AVG(humidity) as avg_humidity,
      COUNT(*) as readings
    FROM readings
    WHERE timestamp >= datetime('now', '-' || ? || ' hours')
      AND room_name != 'Outside'
    GROUP BY room_name
    ORDER BY avg_temp DESC
  `).all(hours);

  res.json(rankings);
});

// Energy API endpoints

// Get energy history (deduplicated)
app.get('/api/energy/history', (req, res) => {
  const days = parseInt(req.query.days) || 7;

  const readings = db.prepare(`
    SELECT timestamp, type, kwh
    FROM energy_readings
    WHERE timestamp >= datetime('now', '-' || ? || ' days')
    GROUP BY timestamp, type
    ORDER BY timestamp ASC
  `).all(days);

  res.json(readings);
});

// Get daily energy totals (deduplicated)
app.get('/api/energy/daily', (req, res) => {
  const days = parseInt(req.query.days) || 7;

  const totals = db.prepare(`
    SELECT
      date(timestamp) as date,
      type,
      SUM(kwh) as total_kwh,
      COUNT(*) as readings
    FROM (
      SELECT timestamp, type, kwh
      FROM energy_readings
      WHERE timestamp >= datetime('now', '-' || ? || ' days')
      GROUP BY timestamp, type
    )
    GROUP BY date(timestamp), type
    ORDER BY date DESC, type
  `).all(days);

  res.json(totals);
});

// Get current energy status (deduplicated)
app.get('/api/energy/current', (req, res) => {
  const today = db.prepare(`
    SELECT type, SUM(kwh) as kwh
    FROM (
      SELECT timestamp, type, kwh FROM energy_readings
      WHERE date(timestamp) = date('now', '-1 day')
      GROUP BY timestamp, type
    )
    GROUP BY type
  `).all();

  const week = db.prepare(`
    SELECT type, SUM(kwh) as kwh
    FROM (
      SELECT timestamp, type, kwh FROM energy_readings
      WHERE timestamp >= datetime('now', '-7 days')
      GROUP BY timestamp, type
    )
    GROUP BY type
  `).all();

  res.json({
    yesterday: today.reduce((acc, r) => { acc[r.type] = r.kwh; return acc; }, {}),
    lastWeek: week.reduce((acc, r) => { acc[r.type] = r.kwh; return acc; }, {})
  });
});

// Manual trigger for energy poll
app.get('/api/energy/poll', async (req, res) => {
  await pollBright();
  res.json({ success: true });
});

// Historical energy data backfill - fetch data in 10-day chunks with Supabase sync
app.get('/api/energy/backfill', async (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const maxDays = 400; // ~13 months max (DCC limit)
  const actualDays = Math.min(days, maxDays);
  const chunkSize = 10; // API seems to have ~10 day limit per request

  try {
    console.log(`[Bright] Backfilling ${actualDays} days of energy data in ${chunkSize}-day chunks...`);

    const chunks = [];
    let totalElec = 0;
    let totalGas = 0;
    let totalStored = 0;
    let supabaseSynced = true;

    // End at start of today (DCC data is delayed by ~1 day)
    let chunkEnd = new Date();
    chunkEnd.setHours(0, 0, 0, 0);

    const insertStmt = db.prepare(`
      INSERT OR REPLACE INTO energy_readings (timestamp, type, kwh, cost_pence)
      VALUES (?, ?, ?, NULL)
    `);

    // Loop backwards in chunks
    let daysRemaining = actualDays;
    while (daysRemaining > 0) {
      const chunkDays = Math.min(chunkSize, daysRemaining);
      const chunkStart = new Date(chunkEnd);
      chunkStart.setDate(chunkStart.getDate() - chunkDays);

      console.log(`[Bright] Fetching chunk: ${chunkStart.toISOString().slice(0,10)} to ${chunkEnd.toISOString().slice(0,10)}`);

      try {
        // Fetch sequentially - Bright API doesn't handle concurrent requests well
        const elecData = await fetchBrightReadings(BRIGHT_CONFIG.resources.electricityConsumption, 'electricity', chunkStart, chunkEnd);
        const gasData = await fetchBrightReadings(BRIGHT_CONFIG.resources.gasConsumption, 'gas', chunkStart, chunkEnd);

        // Store in local SQLite
        let chunkCount = 0;
        const allReadings = [...elecData, ...gasData];
        const insertMany = db.transaction((readings) => {
          for (const r of readings) {
            if (r.kwh > 0) {
              insertStmt.run(r.timestamp, r.type, r.kwh);
              chunkCount++;
            }
          }
        });
        insertMany(allReadings);

        // Sync to Supabase
        const syncResult = await syncEnergyToSupabase(allReadings.filter(r => r.kwh > 0));
        if (!syncResult) supabaseSynced = false;

        chunks.push({
          from: chunkStart.toISOString().slice(0, 10),
          to: chunkEnd.toISOString().slice(0, 10),
          elec: elecData.length,
          gas: gasData.length,
          stored: chunkCount
        });

        totalElec += elecData.length;
        totalGas += gasData.length;
        totalStored += chunkCount;

        console.log(`[Bright] Chunk complete: ${elecData.length} elec, ${gasData.length} gas readings`);
      } catch (chunkError) {
        console.error(`[Bright] Chunk error (${chunkStart.toISOString().slice(0,10)}):`, chunkError.message);
        chunks.push({
          from: chunkStart.toISOString().slice(0, 10),
          to: chunkEnd.toISOString().slice(0, 10),
          error: chunkError.message
        });
      }

      // Move to next chunk (going backwards)
      chunkEnd = chunkStart;
      daysRemaining -= chunkDays;
    }

    console.log(`[Bright] Backfill complete: ${totalStored} total readings stored`);
    res.json({
      success: true,
      daysRequested: actualDays,
      chunksProcessed: chunks.length,
      chunks: chunks,
      totalElectricity: totalElec,
      totalGas: totalGas,
      totalStored: totalStored,
      supabaseSynced: supabaseSynced
    });
  } catch (error) {
    console.error('[Bright] Backfill error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Energy-temperature correlation endpoint
app.get('/api/energy/correlation', (req, res) => {
  const days = parseInt(req.query.days) || 7;

  // Get daily gas usage and average outdoor temperature for correlation analysis (deduplicated)
  const correlation = db.prepare(`
    SELECT
      e.date,
      e.gas_kwh,
      t.avg_outdoor_temp
    FROM (
      SELECT
        date(timestamp) as date,
        SUM(kwh) as gas_kwh
      FROM (
        SELECT timestamp, kwh FROM energy_readings
        WHERE type = 'gas' AND timestamp >= datetime('now', '-' || ? || ' days')
        GROUP BY timestamp
      )
      GROUP BY date(timestamp)
    ) e
    LEFT JOIN (
      SELECT
        date(timestamp) as date,
        AVG(temperature_c) as avg_outdoor_temp
      FROM readings
      WHERE room_name = 'Outside'
        AND timestamp >= datetime('now', '-' || ? || ' days')
      GROUP BY date(timestamp)
    ) t ON e.date = t.date
    WHERE e.gas_kwh > 0
    ORDER BY e.date
  `).all(days, days);

  res.json(correlation);
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Smart Home Dashboard running on http://0.0.0.0:${PORT}`);

  // Initial polls
  pollEcowitt();
  pollBright();

  // Schedule regular polling
  setInterval(pollEcowitt, POLL_INTERVAL); // Every 5 minutes
  setInterval(pollBright, 4 * 60 * 60 * 1000); // Every 4 hours (data updates daily)
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
