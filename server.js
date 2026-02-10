const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const https = require('https');

const app = express();
const PORT = 3001;
const POLL_INTERVAL = 5 * 60 * 1000; // 5 minutes

// Ecowitt API configuration (from environment)
const ECOWITT_CONFIG = {
  applicationKey: process.env.ECOWITT_APP_KEY,
  apiKey: process.env.ECOWITT_API_KEY,
  mac: process.env.ECOWITT_MAC || 'BC:FF:4D:11:3D:18'
};

// Supabase configuration for cloud backup (from environment)
const SUPABASE_CONFIG = {
  url: process.env.SUPABASE_URL,
  serviceKey: process.env.SUPABASE_SERVICE_KEY
};

// Hildebrand Bright API configuration (from environment)
const BRIGHT_CONFIG = {
  username: process.env.BRIGHT_EMAIL,
  password: process.env.BRIGHT_PASSWORD,
  applicationId: process.env.BRIGHT_APP_ID || 'b0f1b774-a586-4f72-9edd-27ead8aa7a8d',
  baseUrl: 'https://api.glowmarkt.com/api/v0-1',
  resources: {
    electricityConsumption: process.env.BRIGHT_ELEC_CONSUMPTION_ID,
    electricityCost: process.env.BRIGHT_ELEC_COST_ID,
    gasConsumption: process.env.BRIGHT_GAS_CONSUMPTION_ID,
    gasCost: process.env.BRIGHT_GAS_COST_ID
  }
};

let brightToken = null;
let brightTokenExpiry = null;

// Severn Trent Water API configuration (from environment)
const SEVERN_TRENT_CONFIG = {
  email: process.env.SEVERN_TRENT_EMAIL,
  password: process.env.SEVERN_TRENT_PASSWORD,
  apiUrl: 'https://api.st.kraken.tech/v1/graphql/',
  meterSerial: process.env.SEVERN_TRENT_METER || '16MA207763'
};

let stToken = null;
let stRefreshToken = null;
let stTokenExpiry = 0;
let stAccountNumber = null;

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

  CREATE TABLE IF NOT EXISTS water_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME NOT NULL,
    reading_date DATE NOT NULL,
    consumption_m3 REAL NOT NULL,
    reading_type TEXT NOT NULL DEFAULT 'smart',
    meter_serial TEXT,
    UNIQUE(reading_date, reading_type)
  );

  CREATE INDEX IF NOT EXISTS idx_water_date ON water_readings(reading_date);

  CREATE TABLE IF NOT EXISTS meter_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reading_date DATE NOT NULL,
    reading_time TIME,
    reading_datetime DATETIME,
    meter_value_m3 REAL NOT NULL,
    meter_serial TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(reading_date, reading_time)
  );

  CREATE INDEX IF NOT EXISTS idx_meter_date ON meter_readings(reading_date);
`);

// Migration: add new columns to meter_readings if they don't exist
try {
  db.exec(`ALTER TABLE meter_readings ADD COLUMN reading_time TIME`);
} catch (e) { /* column already exists */ }

try {
  db.exec(`ALTER TABLE meter_readings ADD COLUMN reading_datetime DATETIME`);
} catch (e) { /* column already exists */ }

try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_meter_datetime ON meter_readings(reading_datetime)`);
} catch (e) { /* index already exists */ }

// Migration: deduplicate energy_readings and add unique constraint
try {
  // Check if unique index already exists
  const indexExists = db.prepare(`SELECT COUNT(*) as count FROM sqlite_master WHERE type='index' AND name='idx_energy_unique'`).get();

  if (!indexExists || indexExists.count === 0) {
    console.log('[Migration] Deduplicating energy_readings and creating unique index...');

    // Delete duplicates, keeping the entry with highest kwh for each (timestamp, type)
    db.exec(`
      DELETE FROM energy_readings
      WHERE id NOT IN (
        SELECT MAX(id)
        FROM energy_readings
        GROUP BY timestamp, type
      )
    `);

    // Now create the unique index
    db.exec(`CREATE UNIQUE INDEX idx_energy_unique ON energy_readings(timestamp, type)`);

    console.log('[Migration] Deduplication complete');
  }
} catch (e) {
  console.error('[Migration] Error deduplicating energy_readings:', e.message);
}

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

// Fetch energy readings from Bright API with specified period
function fetchBrightReadingsRaw(resourceId, type, fromDate, toDate, period = 'PT30M') {
  return new Promise(async (resolve, reject) => {
    try {
      const token = await getBrightToken();
      const fromStr = fromDate.toISOString().slice(0, 19);
      const toStr = toDate.toISOString().slice(0, 19);

      const path = `/api/v0-1/resource/${resourceId}/readings?from=${fromStr}&to=${toStr}&period=${period}&function=sum`;

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

      console.log(`[Bright] Fetching ${type} (${period}): ${path}`);

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

// Fetch energy readings with fallback to daily aggregation if half-hourly data is incomplete
async function fetchBrightReadings(resourceId, type, fromDate, toDate) {
  // Try half-hourly data first
  const halfHourly = await fetchBrightReadingsRaw(resourceId, type, fromDate, toDate, 'PT30M');

  // Check if recent days (last 48-96 hours) are mostly zeros - indicates DCC lag
  const now = new Date();
  const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
  const recentReadings = halfHourly.filter(r => new Date(r.timestamp) >= twoDaysAgo);
  const recentNonZero = recentReadings.filter(r => r.kwh > 0).length;
  const recentZeroPercentage = recentReadings.length > 0 ? (recentReadings.length - recentNonZero) / recentReadings.length : 0;

  // If recent data has >50% zeros, try daily aggregation for entire period
  if (recentReadings.length > 0 && recentZeroPercentage > 0.5) {
    console.log(`[Bright] ${type} recent data has ${(recentZeroPercentage * 100).toFixed(0)}% zeros (${recentNonZero}/${recentReadings.length}), trying daily aggregation...`);

    const daily = await fetchBrightReadingsRaw(resourceId, type, fromDate, toDate, 'P1D');

    // Convert daily readings to half-hourly by distributing evenly across 48 periods
    const expanded = [];
    for (const dayReading of daily) {
      const dayStart = new Date(dayReading.timestamp);
      dayStart.setHours(0, 0, 0, 0);
      const kwhPerHalfHour = dayReading.kwh / 48;

      for (let i = 0; i < 48; i++) {
        const timestamp = new Date(dayStart);
        timestamp.setMinutes(i * 30);
        expanded.push({
          timestamp: timestamp.toISOString(),
          type: type,
          kwh: kwhPerHalfHour
        });
      }
    }

    console.log(`[Bright] ${type} expanded ${daily.length} daily readings to ${expanded.length} half-hourly readings`);
    return expanded;
  }

  return halfHourly;
}

// Merge consumption and cost data by timestamp
function mergeConsumptionAndCost(consumptionData, costData) {
  const costMap = new Map();
  for (const c of costData) {
    costMap.set(c.timestamp, c.kwh); // kwh field contains pence for cost resources
  }

  return consumptionData.map(r => ({
    ...r,
    cost_pence: costMap.get(r.timestamp) || null
  }));
}

// Poll Bright API for energy data
async function pollBright() {
  try {
    console.log('[Bright] Polling energy data...');

    // Get last 7 days of data (DCC data can be delayed or incomplete, so re-fetch recent days)
    const toDate = new Date();
    toDate.setHours(0, 0, 0, 0); // Start of today
    const fromDate = new Date(toDate);
    fromDate.setDate(fromDate.getDate() - 7); // Last 7 days

    // Fetch consumption and cost data sequentially - Bright API doesn't handle concurrent requests well
    const elecConsumption = await fetchBrightReadings(BRIGHT_CONFIG.resources.electricityConsumption, 'electricity', fromDate, toDate);
    const elecCost = BRIGHT_CONFIG.resources.electricityCost
      ? await fetchBrightReadings(BRIGHT_CONFIG.resources.electricityCost, 'electricity_cost', fromDate, toDate)
      : [];
    const gasConsumption = await fetchBrightReadings(BRIGHT_CONFIG.resources.gasConsumption, 'gas', fromDate, toDate);
    const gasCost = BRIGHT_CONFIG.resources.gasCost
      ? await fetchBrightReadings(BRIGHT_CONFIG.resources.gasCost, 'gas_cost', fromDate, toDate)
      : [];

    // Merge consumption with cost data
    const elecData = mergeConsumptionAndCost(elecConsumption, elecCost);
    const gasData = mergeConsumptionAndCost(gasConsumption, gasCost);

    // Store in database (avoid duplicates)
    const insertStmt = db.prepare(`
      INSERT OR REPLACE INTO energy_readings (timestamp, type, kwh, cost_pence)
      VALUES (?, ?, ?, ?)
    `);

    let count = 0;
    const insertMany = db.transaction((readings) => {
      for (const r of readings) {
        // Store all readings including zeros (zero usage is still valid data)
        if (typeof r.kwh === 'number') {
          insertStmt.run(r.timestamp, r.type, r.kwh, r.cost_pence);
          count++;
        }
      }
    });

    const allReadings = [...elecData, ...gasData];
    insertMany(allReadings);
    console.log(`[Bright] Stored ${count} energy readings locally (including zeros)`);

    // Sync to Supabase cloud - include all numeric readings
    const validReadings = allReadings.filter(r => typeof r.kwh === 'number');
    if (validReadings.length > 0) {
      await syncEnergyToSupabase(validReadings);
    }
  } catch (error) {
    console.error('[Bright] Poll error:', error.message);
  }
}

// Severn Trent Water API - GraphQL authentication
function authenticateSevernTrent() {
  return new Promise((resolve, reject) => {
    const mutation = `
      mutation ObtainKrakenToken($input: ObtainJSONWebTokenInput!) {
        obtainKrakenToken(input: $input) {
          token
          payload
          refreshToken
          refreshExpiresIn
        }
      }
    `;

    const postData = JSON.stringify({
      query: mutation,
      variables: {
        input: {
          email: SEVERN_TRENT_CONFIG.email,
          password: SEVERN_TRENT_CONFIG.password
        }
      },
      operationName: 'ObtainKrakenToken'
    });

    const url = new URL(SEVERN_TRENT_CONFIG.apiUrl);
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'SmartHomeDashboard/1.0'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log(`[SevernTrent] Auth response status: ${res.statusCode}, content-type: ${res.headers['content-type']}`);
        if (res.statusCode !== 200) {
          console.log('[SevernTrent] Non-200 response:', data.slice(0, 200));
        }
        try {
          const result = JSON.parse(data);
          if (result.data && result.data.obtainKrakenToken && result.data.obtainKrakenToken.token) {
            stToken = result.data.obtainKrakenToken.token;
            stRefreshToken = result.data.obtainKrakenToken.refreshToken;
            stTokenExpiry = Date.now() + (10 * 60 * 1000); // 10 minutes
            console.log('[SevernTrent] Authenticated successfully');
            resolve(stToken);
          } else {
            const error = result.errors ? result.errors[0].message : 'Authentication failed';
            console.error('[SevernTrent] Auth error:', error, JSON.stringify(result).slice(0, 200));
            reject(new Error(error));
          }
        } catch (e) {
          console.error('[SevernTrent] Parse error, raw response:', data.slice(0, 300));
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// Get valid Severn Trent token (refresh if needed)
async function getSevernTrentToken() {
  if (stToken && Date.now() < stTokenExpiry) {
    return stToken;
  }
  return await authenticateSevernTrent();
}

// Fetch Severn Trent account number
function fetchSevernTrentAccountNumber(token) {
  return new Promise((resolve, reject) => {
    const query = `
      query AccountNumberList {
        viewer {
          accounts {
            number
          }
        }
      }
    `;

    const postData = JSON.stringify({
      query: query,
      operationName: 'AccountNumberList'
    });

    const url = new URL(SEVERN_TRENT_CONFIG.apiUrl);
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': token,
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'SmartHomeDashboard/1.0'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.data && result.data.viewer && result.data.viewer.accounts) {
            const accounts = result.data.viewer.accounts;
            if (accounts.length > 0) {
              stAccountNumber = accounts[0].number;
              console.log(`[SevernTrent] Found account: ${stAccountNumber}`);
              resolve(stAccountNumber);
            } else {
              reject(new Error('No accounts found'));
            }
          } else {
            reject(new Error('Failed to fetch account number'));
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

// Fetch Severn Trent smart meter readings
function fetchSevernTrentReadings(token, accountNumber, startDate, endDate) {
  return new Promise((resolve, reject) => {
    const query = `
      query SmartMeterReadings($accountNumber: String!, $startAt: DateTime, $endAt: DateTime, $utilityFilters: [UtilityFiltersInput]!) {
        account(accountNumber: $accountNumber) {
          properties {
            measurements(
              first: 1000
              startAt: $startAt
              endAt: $endAt
              utilityFilters: $utilityFilters
            ) {
              edges {
                node {
                  ... on IntervalMeasurementType {
                    startAt
                    endAt
                  }
                  value
                  unit
                  readAt
                }
              }
            }
          }
        }
      }
    `;

    const postData = JSON.stringify({
      query: query,
      variables: {
        accountNumber: accountNumber,
        startAt: startDate.toISOString(),
        endAt: endDate.toISOString(),
        utilityFilters: [{ utilityType: 'WATER' }]
      },
      operationName: 'SmartMeterReadings'
    });

    const url = new URL(SEVERN_TRENT_CONFIG.apiUrl);
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': token,
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'SmartHomeDashboard/1.0'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          console.log('[SevernTrent] Readings response:', JSON.stringify(result).slice(0, 500));

          if (result.data && result.data.account && result.data.account.properties) {
            const readings = [];
            for (const property of result.data.account.properties) {
              if (property.measurements && property.measurements.edges) {
                for (const edge of property.measurements.edges) {
                  const node = edge.node;
                  if (node && node.value !== null) {
                    readings.push({
                      timestamp: node.readAt || node.startAt,
                      reading_date: (node.readAt || node.startAt).slice(0, 10),
                      consumption_m3: parseFloat(node.value),
                      reading_type: 'smart',
                      meter_serial: SEVERN_TRENT_CONFIG.meterSerial
                    });
                  }
                }
              }
            }
            resolve(readings);
          } else {
            console.log('[SevernTrent] No readings in response');
            resolve([]);
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

// Poll Severn Trent for water data
async function pollSevernTrent() {
  try {
    console.log('[SevernTrent] Polling water data...');

    const token = await getSevernTrentToken();

    // Get account number if not cached
    if (!stAccountNumber) {
      await fetchSevernTrentAccountNumber(token);
    }

    // Get last 7 days of data (data is delayed by ~1 day)
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 7);

    const readings = await fetchSevernTrentReadings(token, stAccountNumber, startDate, endDate);

    if (readings.length === 0) {
      console.log('[SevernTrent] No new readings');
      return;
    }

    // Store in local SQLite
    const insertStmt = db.prepare(`
      INSERT OR REPLACE INTO water_readings (timestamp, reading_date, consumption_m3, reading_type, meter_serial)
      VALUES (?, ?, ?, ?, ?)
    `);

    let count = 0;
    const insertMany = db.transaction((readings) => {
      for (const r of readings) {
        if (r.consumption_m3 > 0) {
          insertStmt.run(r.timestamp, r.reading_date, r.consumption_m3, r.reading_type, r.meter_serial);
          count++;
        }
      }
    });

    insertMany(readings);
    console.log(`[SevernTrent] Stored ${count} water readings locally`);

    // Sync to Supabase
    const validReadings = readings.filter(r => r.consumption_m3 > 0);
    if (validReadings.length > 0) {
      await syncWaterToSupabase(validReadings);
    }
  } catch (error) {
    console.error('[SevernTrent] Poll error:', error.message);
  }
}

// Sync water readings to Supabase cloud
function syncWaterToSupabase(readings) {
  return new Promise((resolve, reject) => {
    if (!readings || readings.length === 0) {
      resolve(true);
      return;
    }

    const supabaseReadings = readings.map(r => ({
      timestamp: r.timestamp,
      reading_date: r.reading_date,
      consumption_m3: r.consumption_m3,
      reading_type: r.reading_type,
      meter_serial: r.meter_serial
    }));

    const postData = JSON.stringify(supabaseReadings);
    const url = new URL(`${SUPABASE_CONFIG.url}/rest/v1/water_readings`);

    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_CONFIG.serviceKey,
        'Authorization': `Bearer ${SUPABASE_CONFIG.serviceKey}`,
        'Prefer': 'resolution=merge-duplicates',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[Supabase] Synced ${readings.length} water readings to cloud`);
          resolve(true);
        } else {
          console.error(`[Supabase] Water sync failed (${res.statusCode}):`, data);
          resolve(false);
        }
      });
    });

    req.on('error', (e) => {
      console.error('[Supabase] Water sync error:', e.message);
      resolve(false);
    });

    req.write(postData);
    req.end();
  });
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
      cost_pence: r.cost_pence || null
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
app.use(express.json());
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
    SELECT timestamp, type, kwh, cost_pence
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
      SUM(cost_pence) as total_cost_pence,
      COUNT(*) as readings
    FROM (
      SELECT timestamp, type, kwh, cost_pence
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
    SELECT type, SUM(kwh) as kwh, SUM(cost_pence) as cost_pence
    FROM (
      SELECT timestamp, type, kwh, cost_pence FROM energy_readings
      WHERE date(timestamp) = date('now', '-1 day')
      GROUP BY timestamp, type
    )
    GROUP BY type
  `).all();

  const week = db.prepare(`
    SELECT type, SUM(kwh) as kwh, SUM(cost_pence) as cost_pence
    FROM (
      SELECT timestamp, type, kwh, cost_pence FROM energy_readings
      WHERE timestamp >= datetime('now', '-7 days')
      GROUP BY timestamp, type
    )
    GROUP BY type
  `).all();

  res.json({
    yesterday: today.reduce((acc, r) => { acc[r.type] = r.kwh; acc[r.type + '_cost'] = r.cost_pence; return acc; }, {}),
    lastWeek: week.reduce((acc, r) => { acc[r.type] = r.kwh; acc[r.type + '_cost'] = r.cost_pence; return acc; }, {})
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
    console.log(`[Bright] Backfilling ${actualDays} days of energy data (with costs) in ${chunkSize}-day chunks...`);

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
      VALUES (?, ?, ?, ?)
    `);

    // Loop backwards in chunks
    let daysRemaining = actualDays;
    while (daysRemaining > 0) {
      const chunkDays = Math.min(chunkSize, daysRemaining);
      const chunkStart = new Date(chunkEnd);
      chunkStart.setDate(chunkStart.getDate() - chunkDays);

      console.log(`[Bright] Fetching chunk: ${chunkStart.toISOString().slice(0,10)} to ${chunkEnd.toISOString().slice(0,10)}`);

      try {
        // Fetch consumption and cost data sequentially - Bright API doesn't handle concurrent requests well
        const elecConsumption = await fetchBrightReadings(BRIGHT_CONFIG.resources.electricityConsumption, 'electricity', chunkStart, chunkEnd);
        const elecCost = BRIGHT_CONFIG.resources.electricityCost
          ? await fetchBrightReadings(BRIGHT_CONFIG.resources.electricityCost, 'electricity_cost', chunkStart, chunkEnd)
          : [];
        const gasConsumption = await fetchBrightReadings(BRIGHT_CONFIG.resources.gasConsumption, 'gas', chunkStart, chunkEnd);
        const gasCost = BRIGHT_CONFIG.resources.gasCost
          ? await fetchBrightReadings(BRIGHT_CONFIG.resources.gasCost, 'gas_cost', chunkStart, chunkEnd)
          : [];

        // Merge consumption with cost data
        const elecData = mergeConsumptionAndCost(elecConsumption, elecCost);
        const gasData = mergeConsumptionAndCost(gasConsumption, gasCost);

        // Store in local SQLite
        let chunkCount = 0;
        const allReadings = [...elecData, ...gasData];
        const insertMany = db.transaction((readings) => {
          for (const r of readings) {
            if (r.kwh > 0) {
              insertStmt.run(r.timestamp, r.type, r.kwh, r.cost_pence);
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
          elecCost: elecCost.length,
          gasCost: gasCost.length,
          stored: chunkCount
        });

        totalElec += elecData.length;
        totalGas += gasData.length;
        totalStored += chunkCount;

        console.log(`[Bright] Chunk complete: ${elecData.length} elec, ${gasData.length} gas readings (with ${elecCost.length}/${gasCost.length} cost entries)`);
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

// Energy usage analysis - identify patterns, spikes, and quiet days
app.get('/api/energy/analysis', (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const energyType = req.query.type || 'both'; // 'electricity', 'gas', or 'both'

  // Get daily totals for analysis
  const dailyData = db.prepare(`
    SELECT
      date(timestamp) as date,
      type,
      SUM(kwh) as total_kwh,
      SUM(cost_pence) as total_cost_pence,
      strftime('%w', timestamp) as day_of_week
    FROM (
      SELECT timestamp, type, kwh, cost_pence FROM energy_readings
      WHERE timestamp >= datetime('now', '-' || ? || ' days')
        AND (? = 'both' OR type = ?)
      GROUP BY timestamp, type
    )
    GROUP BY date(timestamp), type
    ORDER BY date(timestamp)
  `).all(days, energyType, energyType);

  // Separate by type
  const electricityData = dailyData.filter(d => d.type === 'electricity');
  const gasData = dailyData.filter(d => d.type === 'gas');

  // Calculate statistics
  const analyzeType = (data, typeName) => {
    if (data.length === 0) return null;

    const values = data.map(d => d.total_kwh);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const sorted = [...values].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const stdDev = Math.sqrt(values.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / values.length);

    // Identify spikes (>1.5 std deviations above mean)
    const spikeThreshold = avg + (1.5 * stdDev);
    const spikes = data.filter(d => d.total_kwh > spikeThreshold).map(d => ({
      date: d.date,
      kwh: d.total_kwh,
      percentAboveAvg: ((d.total_kwh - avg) / avg * 100).toFixed(1),
      dayOfWeek: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.day_of_week]
    }));

    // Identify quiet days (>1 std deviation below mean)
    const quietThreshold = avg - stdDev;
    const quietDays = data.filter(d => d.total_kwh < quietThreshold).map(d => ({
      date: d.date,
      kwh: d.total_kwh,
      percentBelowAvg: ((avg - d.total_kwh) / avg * 100).toFixed(1),
      dayOfWeek: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.day_of_week]
    }));

    // Day of week analysis
    const byDayOfWeek = {};
    for (let i = 0; i < 7; i++) {
      const dayData = data.filter(d => d.day_of_week == i);
      if (dayData.length > 0) {
        const dayAvg = dayData.reduce((sum, d) => sum + d.total_kwh, 0) / dayData.length;
        byDayOfWeek[['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][i]] = {
          avg_kwh: Math.round(dayAvg * 100) / 100,
          days_count: dayData.length,
          percentVsOverall: ((dayAvg - avg) / avg * 100).toFixed(1)
        };
      }
    }

    // Highest and lowest days
    const highest = data.reduce((max, d) => d.total_kwh > max.total_kwh ? d : max, data[0]);
    const lowest = data.reduce((min, d) => d.total_kwh < min.total_kwh ? d : min, data[0]);

    return {
      type: typeName,
      period_days: data.length,
      statistics: {
        average_kwh: Math.round(avg * 100) / 100,
        median_kwh: Math.round(median * 100) / 100,
        std_deviation: Math.round(stdDev * 100) / 100,
        min_kwh: Math.round(sorted[0] * 100) / 100,
        max_kwh: Math.round(sorted[sorted.length - 1] * 100) / 100,
        total_kwh: Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100
      },
      spikes: {
        threshold_kwh: Math.round(spikeThreshold * 100) / 100,
        count: spikes.length,
        days: spikes.sort((a, b) => b.kwh - a.kwh).slice(0, 10) // Top 10
      },
      quiet_days: {
        threshold_kwh: Math.round(quietThreshold * 100) / 100,
        count: quietDays.length,
        days: quietDays.sort((a, b) => a.kwh - b.kwh).slice(0, 10) // Bottom 10
      },
      by_day_of_week: byDayOfWeek,
      extremes: {
        highest: {
          date: highest.date,
          kwh: highest.total_kwh,
          dayOfWeek: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][highest.day_of_week]
        },
        lowest: {
          date: lowest.date,
          kwh: lowest.total_kwh,
          dayOfWeek: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][lowest.day_of_week]
        }
      }
    };
  };

  const analysis = {};
  if (energyType === 'electricity' || energyType === 'both') {
    analysis.electricity = analyzeType(electricityData, 'electricity');
  }
  if (energyType === 'gas' || energyType === 'both') {
    analysis.gas = analyzeType(gasData, 'gas');
  }

  res.json(analysis);
});

// Hourly usage patterns - identify peak hours
app.get('/api/energy/hourly-patterns', (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const energyType = req.query.type || 'electricity'; // 'electricity' or 'gas'

  const hourlyData = db.prepare(`
    SELECT
      strftime('%H', timestamp) as hour,
      AVG(kwh) as avg_kwh,
      MAX(kwh) as max_kwh,
      MIN(kwh) as min_kwh,
      COUNT(*) as reading_count
    FROM (
      SELECT timestamp, kwh FROM energy_readings
      WHERE type = ?
        AND timestamp >= datetime('now', '-' || ? || ' days')
      GROUP BY timestamp
    )
    GROUP BY strftime('%H', timestamp)
    ORDER BY hour
  `).all(energyType, days);

  // Calculate overall average for comparison
  const overallAvg = hourlyData.reduce((sum, h) => sum + h.avg_kwh, 0) / hourlyData.length;

  const analysis = hourlyData.map(h => ({
    hour: parseInt(h.hour),
    timeLabel: `${h.hour}:00-${h.hour}:30`,
    avg_kwh: Math.round(h.avg_kwh * 1000) / 1000,
    max_kwh: Math.round(h.max_kwh * 1000) / 1000,
    min_kwh: Math.round(h.min_kwh * 1000) / 1000,
    percentVsAvg: ((h.avg_kwh - overallAvg) / overallAvg * 100).toFixed(1),
    isPeak: h.avg_kwh > overallAvg * 1.2,
    isQuiet: h.avg_kwh < overallAvg * 0.8
  }));

  // Identify peak hours
  const peakHours = analysis.filter(h => h.isPeak).sort((a, b) => b.avg_kwh - a.avg_kwh);
  const quietHours = analysis.filter(h => h.isQuiet).sort((a, b) => a.avg_kwh - b.avg_kwh);

  res.json({
    type: energyType,
    period_days: days,
    overall_avg_kwh: Math.round(overallAvg * 1000) / 1000,
    hourly_breakdown: analysis,
    peak_hours: peakHours,
    quiet_hours: quietHours
  });
});

// Water API endpoints

// Get water usage summary
app.get('/api/water/summary', (req, res) => {
  const result = db.prepare(`
    SELECT
      SUM(CASE WHEN reading_date >= date('now', '-7 days') THEN consumption_m3 ELSE 0 END) as week_m3,
      SUM(CASE WHEN reading_date >= date('now', '-30 days') THEN consumption_m3 ELSE 0 END) as month_m3,
      AVG(CASE WHEN reading_date >= date('now', '-7 days') THEN consumption_m3 ELSE NULL END) as avg_daily_m3
    FROM water_readings
  `).get();

  // Get yesterday's reading
  const yesterday = db.prepare(`
    SELECT consumption_m3
    FROM water_readings
    WHERE reading_date = date('now', '-1 day')
  `).get();

  res.json({
    yesterday_m3: yesterday ? yesterday.consumption_m3 : null,
    yesterday_litres: yesterday ? Math.round(yesterday.consumption_m3 * 1000) : null,
    week_m3: result.week_m3 || 0,
    week_litres: Math.round((result.week_m3 || 0) * 1000),
    month_m3: result.month_m3 || 0,
    month_litres: Math.round((result.month_m3 || 0) * 1000),
    avg_daily_m3: result.avg_daily_m3 || 0,
    avg_daily_litres: Math.round((result.avg_daily_m3 || 0) * 1000)
  });
});

// Get daily water readings
app.get('/api/water/daily', (req, res) => {
  const days = parseInt(req.query.days) || 30;

  const readings = db.prepare(`
    SELECT
      reading_date,
      consumption_m3,
      ROUND(consumption_m3 * 1000) as consumption_litres,
      reading_type
    FROM water_readings
    WHERE reading_date >= date('now', '-' || ? || ' days')
    ORDER BY reading_date ASC
  `).all(days);

  res.json(readings);
});

// Get water history (detailed)
app.get('/api/water/history', (req, res) => {
  const days = parseInt(req.query.days) || 7;

  const readings = db.prepare(`
    SELECT
      timestamp,
      reading_date,
      consumption_m3,
      reading_type,
      meter_serial
    FROM water_readings
    WHERE reading_date >= date('now', '-' || ? || ' days')
    ORDER BY reading_date DESC
  `).all(days);

  res.json(readings);
});

// Get water data aggregated by billing periods
app.get('/api/water/periods', (req, res) => {
  const days = parseInt(req.query.days) || 365;

  const readings = db.prepare(`
    SELECT
      reading_date,
      consumption_m3,
      reading_type
    FROM water_readings
    WHERE reading_date >= date('now', '-' || ? || ' days')
    ORDER BY reading_date ASC
  `).all(days);

  if (readings.length === 0) {
    return res.json([]);
  }

  // Group consecutive days with same consumption_m3 into periods
  const periods = [];
  let currentPeriod = null;

  for (const reading of readings) {
    const dailyM3 = Math.round(reading.consumption_m3 * 1000000) / 1000000; // Round for comparison

    if (!currentPeriod || Math.abs(currentPeriod.dailyM3 - dailyM3) > 0.0001) {
      // Start new period
      if (currentPeriod) {
        periods.push(currentPeriod);
      }
      currentPeriod = {
        startDate: reading.reading_date,
        endDate: reading.reading_date,
        dailyM3: dailyM3,
        days: 1,
        totalM3: dailyM3,
        readingType: reading.reading_type
      };
    } else {
      // Extend current period
      currentPeriod.endDate = reading.reading_date;
      currentPeriod.days++;
      currentPeriod.totalM3 = currentPeriod.dailyM3 * currentPeriod.days;
    }
  }

  // Don't forget last period
  if (currentPeriod) {
    periods.push(currentPeriod);
  }

  // Calculate totals and format output
  const formatted = periods.map(p => ({
    startDate: p.startDate,
    endDate: p.endDate,
    days: p.days,
    totalM3: Math.round(p.totalM3 * 100) / 100,
    totalLitres: Math.round(p.totalM3 * 1000),
    avgDailyLitres: Math.round(p.dailyM3 * 1000),
    readingType: p.readingType,
    label: formatPeriodLabel(p.startDate, p.endDate)
  }));

  res.json(formatted);
});

// Format period label (e.g., "Mar-Sep 2024")
function formatPeriodLabel(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const startMonth = start.toLocaleDateString('en-GB', { month: 'short' });
  const endMonth = end.toLocaleDateString('en-GB', { month: 'short' });
  const startYear = start.getFullYear();
  const endYear = end.getFullYear();

  if (startYear === endYear) {
    return `${startMonth}-${endMonth} ${startYear}`;
  } else {
    return `${startMonth} ${startYear}-${endMonth} ${endYear}`;
  }
}

// Manual trigger for water poll
app.get('/api/water/poll', async (req, res) => {
  await pollSevernTrent();
  res.json({ success: true });
});

// Water backfill - fetch historical data
app.get('/api/water/backfill', async (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const maxDays = 365;
  const actualDays = Math.min(days, maxDays);

  try {
    console.log(`[SevernTrent] Backfilling ${actualDays} days of water data...`);

    const token = await getSevernTrentToken();

    if (!stAccountNumber) {
      await fetchSevernTrentAccountNumber(token);
    }

    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - actualDays);

    const readings = await fetchSevernTrentReadings(token, stAccountNumber, startDate, endDate);

    // Store in local SQLite
    const insertStmt = db.prepare(`
      INSERT OR REPLACE INTO water_readings (timestamp, reading_date, consumption_m3, reading_type, meter_serial)
      VALUES (?, ?, ?, ?, ?)
    `);

    let count = 0;
    const insertMany = db.transaction((readings) => {
      for (const r of readings) {
        if (r.consumption_m3 > 0) {
          insertStmt.run(r.timestamp, r.reading_date, r.consumption_m3, r.reading_type, r.meter_serial);
          count++;
        }
      }
    });

    insertMany(readings);
    console.log(`[SevernTrent] Backfill stored ${count} water readings`);

    // Sync to Supabase
    const validReadings = readings.filter(r => r.consumption_m3 > 0);
    let supabaseSynced = false;
    if (validReadings.length > 0) {
      supabaseSynced = await syncWaterToSupabase(validReadings);
    }

    res.json({
      success: true,
      daysRequested: actualDays,
      readingsFetched: readings.length,
      readingsStored: count,
      supabaseSynced: supabaseSynced
    });
  } catch (error) {
    console.error('[SevernTrent] Backfill error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Manual water entry endpoint
app.post('/api/water/manual', async (req, res) => {
  try {
    const { readings } = req.body;

    if (!readings || !Array.isArray(readings) || readings.length === 0) {
      return res.status(400).json({ success: false, error: 'No readings provided' });
    }

    const insertStmt = db.prepare(`
      INSERT OR REPLACE INTO water_readings (timestamp, reading_date, consumption_m3, reading_type, meter_serial)
      VALUES (?, ?, ?, 'manual', ?)
    `);

    let count = 0;
    const insertMany = db.transaction((items) => {
      for (const r of items) {
        if (!r.date || r.litres === undefined) continue;

        const litres = parseFloat(r.litres);
        if (isNaN(litres) || litres < 0) continue;

        const m3 = litres / 1000;
        const timestamp = new Date(r.date + 'T12:00:00Z').toISOString();

        insertStmt.run(timestamp, r.date, m3, SEVERN_TRENT_CONFIG.meterSerial);
        count++;
      }
    });

    insertMany(readings);
    console.log(`[Water] Manual entry: stored ${count} readings`);

    // Sync to Supabase
    const supabaseReadings = readings
      .filter(r => r.date && !isNaN(parseFloat(r.litres)))
      .map(r => ({
        timestamp: new Date(r.date + 'T12:00:00Z').toISOString(),
        reading_date: r.date,
        consumption_m3: parseFloat(r.litres) / 1000,
        reading_type: 'manual',
        meter_serial: SEVERN_TRENT_CONFIG.meterSerial
      }));

    let supabaseSynced = false;
    if (supabaseReadings.length > 0) {
      supabaseSynced = await syncWaterToSupabase(supabaseReadings);
    }

    res.json({
      success: true,
      readingsStored: count,
      supabaseSynced
    });
  } catch (error) {
    console.error('[Water] Manual entry error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Billing period import - distribute total usage across date range
app.post('/api/water/billing-period', async (req, res) => {
  try {
    const { startDate, endDate, totalM3 } = req.body;

    if (!startDate || !endDate || totalM3 === undefined) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    const days = Math.ceil((end - start) / (1000 * 60 * 60 * 24));

    if (days <= 0) {
      return res.status(400).json({ success: false, error: 'End date must be after start date' });
    }

    const dailyM3 = parseFloat(totalM3) / days;
    const dailyLitres = dailyM3 * 1000;

    console.log(`[Water] Billing period import: ${startDate} to ${endDate}, ${totalM3} m3 over ${days} days = ${dailyLitres.toFixed(1)} L/day`);

    const insertStmt = db.prepare(`
      INSERT OR REPLACE INTO water_readings (timestamp, reading_date, consumption_m3, reading_type, meter_serial)
      VALUES (?, ?, ?, 'billing', ?)
    `);

    const readings = [];
    let count = 0;

    // Create a reading for each day in the period
    const insertMany = db.transaction(() => {
      const currentDate = new Date(start);
      while (currentDate < end) {
        const dateStr = currentDate.toISOString().slice(0, 10);
        const timestamp = new Date(dateStr + 'T12:00:00Z').toISOString();

        insertStmt.run(timestamp, dateStr, dailyM3, SEVERN_TRENT_CONFIG.meterSerial);

        readings.push({
          timestamp,
          reading_date: dateStr,
          consumption_m3: dailyM3,
          reading_type: 'billing',
          meter_serial: SEVERN_TRENT_CONFIG.meterSerial
        });

        count++;
        currentDate.setDate(currentDate.getDate() + 1);
      }
    });

    insertMany();
    console.log(`[Water] Billing period: stored ${count} daily readings`);

    // Sync to Supabase
    let supabaseSynced = false;
    if (readings.length > 0) {
      supabaseSynced = await syncWaterToSupabase(readings);
    }

    res.json({
      success: true,
      daysCreated: count,
      dailyM3: dailyM3,
      dailyLitres: dailyLitres,
      totalM3: parseFloat(totalM3),
      supabaseSynced
    });
  } catch (error) {
    console.error('[Water] Billing period import error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Meter reading entry - enter cumulative meter value, calculates consumption from previous
app.post('/api/water/meter-reading', async (req, res) => {
  try {
    const { date, time, meterValue } = req.body;

    if (!date || meterValue === undefined) {
      return res.status(400).json({ success: false, error: 'Date and meter value required' });
    }

    const meterM3 = parseFloat(meterValue);
    if (isNaN(meterM3) || meterM3 < 0) {
      return res.status(400).json({ success: false, error: 'Invalid meter value' });
    }

    // Build datetime from date and optional time (default to current time if not provided)
    const readingTime = time || new Date().toTimeString().slice(0, 5);
    const readingDatetime = `${date}T${readingTime}:00`;

    // Get previous meter reading
    const previous = db.prepare(`
      SELECT reading_date, reading_time, reading_datetime, meter_value_m3
      FROM meter_readings
      WHERE reading_datetime < ?
      ORDER BY reading_datetime DESC
      LIMIT 1
    `).get(readingDatetime);

    // Store the new meter reading
    db.prepare(`
      INSERT OR REPLACE INTO meter_readings (reading_date, reading_time, reading_datetime, meter_value_m3, meter_serial)
      VALUES (?, ?, ?, ?, ?)
    `).run(date, readingTime, readingDatetime, meterM3, SEVERN_TRENT_CONFIG.meterSerial);

    let consumption = null;
    let hours = null;
    let days = null;
    let avgDailyLitres = null;
    let litresPerHour = null;

    if (previous) {
      // Calculate consumption between readings using actual hours
      consumption = meterM3 - previous.meter_value_m3;
      const prevDatetime = new Date(previous.reading_datetime);
      const newDatetime = new Date(readingDatetime);
      hours = (newDatetime - prevDatetime) / (1000 * 60 * 60);
      days = hours / 24;

      if (hours > 0 && consumption >= 0) {
        litresPerHour = (consumption * 1000) / hours;
        avgDailyLitres = Math.round(litresPerHour * 24);
        const dailyM3 = consumption / days;

        // Create water_readings entries for each day in the period
        // For partial days, we'll still create one entry per day but log the actual rate
        const insertStmt = db.prepare(`
          INSERT OR REPLACE INTO water_readings (timestamp, reading_date, consumption_m3, reading_type, meter_serial)
          VALUES (?, ?, ?, 'meter', ?)
        `);

        const readings = [];
        const insertMany = db.transaction(() => {
          const currentDate = new Date(prevDatetime);
          currentDate.setDate(currentDate.getDate() + 1);
          currentDate.setHours(0, 0, 0, 0);

          while (currentDate <= newDatetime) {
            const dateStr = currentDate.toISOString().slice(0, 10);
            const timestamp = new Date(dateStr + 'T12:00:00Z').toISOString();

            insertStmt.run(timestamp, dateStr, dailyM3, SEVERN_TRENT_CONFIG.meterSerial);

            readings.push({
              timestamp,
              reading_date: dateStr,
              consumption_m3: dailyM3,
              reading_type: 'meter',
              meter_serial: SEVERN_TRENT_CONFIG.meterSerial
            });

            currentDate.setDate(currentDate.getDate() + 1);
          }
        });

        insertMany();
        console.log(`[Water] Meter reading: ${previous.meter_value_m3} -> ${meterM3} m³ = ${(consumption * 1000).toFixed(0)}L over ${hours.toFixed(1)}h (${avgDailyLitres} L/day)`);

        // Sync to Supabase
        if (readings.length > 0) {
          await syncWaterToSupabase(readings);
        }
      }
    } else {
      console.log(`[Water] First meter reading recorded: ${meterM3} m³ on ${date} at ${readingTime}`);
    }

    res.json({
      success: true,
      meterValue: meterM3,
      date: date,
      time: readingTime,
      datetime: readingDatetime,
      previousReading: previous ? {
        date: previous.reading_date,
        time: previous.reading_time,
        value: previous.meter_value_m3
      } : null,
      consumption: consumption,
      consumptionLitres: consumption ? Math.round(consumption * 1000) : null,
      hours: hours ? Math.round(hours * 10) / 10 : null,
      days: days ? Math.round(days * 10) / 10 : null,
      avgDailyLitres: avgDailyLitres,
      litresPerHour: litresPerHour ? Math.round(litresPerHour * 10) / 10 : null
    });
  } catch (error) {
    console.error('[Water] Meter reading error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get all meter readings
app.get('/api/water/meter-readings', (req, res) => {
  const readings = db.prepare(`
    SELECT reading_date, reading_time, reading_datetime, meter_value_m3, meter_serial, created_at
    FROM meter_readings
    ORDER BY reading_datetime DESC
  `).all();

  res.json(readings);
});

// Delete water readings before a date
app.delete('/api/water/before/:date', (req, res) => {
  const date = req.params.date;

  const countBefore = db.prepare(`SELECT COUNT(*) as count FROM water_readings WHERE reading_date < ?`).get(date);

  const result = db.prepare(`DELETE FROM water_readings WHERE reading_date < ?`).run(date);

  console.log(`[Water] Deleted ${result.changes} readings before ${date}`);

  res.json({
    success: true,
    deleted: result.changes,
    date: date
  });
});

// Delete water readings by date and type
app.delete('/api/water/:date/:type', (req, res) => {
  const { date, type } = req.params;

  const result = db.prepare(`DELETE FROM water_readings WHERE reading_date = ? AND reading_type = ?`).run(date, type);

  console.log(`[Water] Deleted ${result.changes} ${type} readings on ${date}`);

  res.json({
    success: true,
    deleted: result.changes,
    date: date,
    type: type
  });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Smart Home Dashboard running on http://0.0.0.0:${PORT}`);

  // Initial polls
  pollEcowitt();
  pollBright();
  // pollSevernTrent(); // Disabled - Severn Trent now uses passwordless auth, use manual meter entries instead

  // Schedule regular polling
  setInterval(pollEcowitt, POLL_INTERVAL); // Every 5 minutes
  setInterval(pollBright, 4 * 60 * 60 * 1000); // Every 4 hours (data updates daily)
  // setInterval(pollSevernTrent, 24 * 60 * 60 * 1000); // Disabled - use manual meter entries
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
