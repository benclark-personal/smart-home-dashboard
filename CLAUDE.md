# Smart Home Temperature Monitoring System

## Project Overview

A comprehensive home temperature and humidity monitoring system built on Raspberry Pi, polling Ecowitt sensors via their cloud API and displaying data on a dedicated kiosk display.

### Primary Intentions
1. Monitor temperature and humidity across all rooms in the house
2. Understand how the heating system affects different rooms
3. Identify rooms that heat up slowly or lose heat quickly
4. Compare room temperatures against the thermostat location (Entrance Hall)
5. Provide historical data for analysis and optimisation
6. Cloud backup via Supabase for remote access and data safety

---

## Hardware

### Base Station
- **Model:** Ecowitt HP2561 WiFi Weather Station
- **Location:** Dining Room (on desk)
- **Function:** Receives sensor data, uploads to Ecowitt cloud

### Sensors
- **Model:** Ecowitt WH31 Multi-Channel Temperature & Humidity Sensors
- **Quantity:** 5 external sensors + 1 built-in console sensor + 1 outdoor sensor
- **Transmission:** 433MHz (UK), ~48 second intervals
- **Battery:** 2x AA (0 = OK, 1 = Low)

### Display System
- **Model:** Raspberry Pi 4 (DietPi)
- **IP Address:** 192.168.0.145
- **Hostname:** DietPi
- **Login:** root / holymoly10 (or dietpi / holymoly10)
- **Display:** Connected monitor running Chromium in kiosk mode
- **Dashboard URL:** http://localhost:3001

---

## Sensor Deployment

**Deployment Date/Time:** 15:40 24/12/2024

All sensors calibrated side-by-side next to console before deployment. Data before this timestamp should be excluded from analysis as sensors were not in final positions.

### Channel Assignments

| Channel | Room Name | Floor | Placement | Notes |
|---------|-----------|-------|-----------|-------|
| indoor | Dining Room (Console) | Ground | On desk | Base station - fixed location |
| outdoor | Outside | External | Fixed | Outdoor sensor |
| ch1 | Living Room | Ground | Top wall (shared with dining) | Away from TV and radiator |
| ch2 | Entrance Hall | Ground | Wall by stairs | Thermostat reference location |
| ch3 | Laundry | Ground | Right wall | Opposite washing machine |
| ch4 | Master Bedroom | First | Top wall (by wardrobe) | Opposite window radiator |
| ch5 | Layla Room | First | Left wall | Opposite radiator |
| ch6 | *Available* | - | - | Could be used for Landing |
| ch7 | *Available* | - | - | - |
| ch8 | *Available* | - | - | - |

### Sensor Heights
- All WH31 sensors placed at approximately 6ft (1.8m) height
- Console on desk (lower, approximately 0.75m)

### Sensor IDs
Sensors registered via HP2561 console "Sensor ID" feature to lock specific sensor IDs and prevent interference from neighbouring Ecowitt systems.

| Channel | Room | Sensor ID |
|---------|------|-----------|
| ch1 | Living Room | f0 |
| ch2 | Entrance Hall | fd |
| ch3 | Laundry | f7 |
| ch4 | Master Bedroom | a1 |
| ch5 | Layla Room | b8 |

---

## Heating System

### Central Heating Thermostat
- **Location:** Entrance Hall (wall opposite WC, near stairs)
- **Current Setting:** 25°C
- **Reference Sensor:** ch2 (Entrance Hall) placed nearby for comparison

### Heating Schedule

```javascript
const HEATING_SCHEDULE = [
  { start: '06:50', end: '09:30' },  // Morning
  { start: '15:30', end: '22:00' }   // Evening
];
```

Heating periods are displayed as orange-shaded regions on history charts.

---

## Software Architecture

### Backend (server.js)
- **Runtime:** Node.js with Express
- **Database:** SQLite (better-sqlite3) for local storage
- **Cloud Sync:** Supabase PostgreSQL via REST API
- **Polling:** Every 5 minutes from Ecowitt cloud API

### Frontend (public/index.html)
- **Charts:** Chart.js with chartjs-adapter-date-fns
- **Tabs:** Current, History, Analysis, Data
- **Features:**
  - Real-time temperature/humidity display
  - Historical charts (indoor/outdoor separated)
  - Heating period visualisation
  - Temperature differentials vs Entrance Hall
  - Battery status warnings

### Key Files
```
/Users/SOS-Ben/smart-home-dashboard/
├── server.js              # Backend server
├── public/
│   └── index.html         # Dashboard frontend
├── package.json
└── CLAUDE.md              # This file

/opt/smart-home-dashboard/  # Deployed location on Pi
```

### Systemd Service
```
/etc/systemd/system/smart-home-dashboard.service
```

---

## Configuration

### Room Colours (for charts)
```javascript
const ROOM_COLOURS = {
  'Outside': '#81c784',
  'Entrance Hall': '#4fc3f7',
  'Living Room': '#ff7043',
  'Dining Room (Console)': '#ffc107',
  'Laundry': '#9575cd',
  'Master Bedroom': '#f06292',
  'Layla Room': '#4db6ac'
};
```

### Supabase Configuration
- **URL:** https://mtrjhzrzmqbahzipjisa.supabase.co
- **Table:** temperature_readings
- **Sync:** Automatic on each poll

### Ecowitt API
- **Endpoint:** api.ecowitt.net
- **Application Key:** Configured in server.js
- **API Key:** Configured in server.js
- **MAC Address:** Configured in server.js

### Hildebrand Bright API (Smart Meter Data)
- **Service:** Hildebrand Glowmarkt / Bright app
- **Access:** Free via DCC (Data Communications Company)
- **Data Delay:** Previous day only (DCC limitation)
- **Resolution:** Half-hourly readings
- **Polling:** Every 4 hours (data updates daily)
- **Account:** benclark.mail@gmail.com
- **Registration:** 25/12/2024 - Data expected within 24-48 hours

**Resource IDs:**
| Resource | Type | ID |
|----------|------|-----|
| Electricity Consumption | kWh | d32d26bc-b8f8-4f43-b098-49aa174f6df7 |
| Electricity Cost | pence | 2ee42fba-980f-426d-835e-ab1604491bb0 |
| Gas Consumption | kWh | 695a8307-7f36-4a47-985d-761136c79028 |
| Gas Cost | pence | 35d0e593-dada-4a2c-9fe7-d7321ac2fdf4 |

**API Endpoints:**
```bash
# Get energy history (last 7 days)
curl "http://192.168.0.145:3001/api/energy/history?days=7"

# Get daily totals
curl "http://192.168.0.145:3001/api/energy/daily?days=7"

# Get current status (yesterday's total + weekly total)
curl "http://192.168.0.145:3001/api/energy/current"

# Manual poll trigger
curl "http://192.168.0.145:3001/api/energy/poll"

# Historical backfill (fetches in 10-day chunks, syncs to Supabase)
curl "http://192.168.0.145:3001/api/energy/backfill?days=60"   # 60 days
curl "http://192.168.0.145:3001/api/energy/backfill?days=400"  # Max ~13 months
```

**Historical Data Notes:**
- **Electricity:** Full historical data available via DCC (~13 months)
- **Gas:** Historical data may NOT be available via API (DCC limitation)
  - Gas meters send data to comms hub every 30 mins over HAN
  - Historical backfill happens slowly ("a few days of history per day")
  - Contact support@glowmarkt.com to request full historical access
- **Supabase Table:** `energy_readings` (synced automatically during backfill)
- **Support Request:** See `docs/glowmarkt-support-email.md` (27/12/2024)

---

## Dashboard Features

### Current Tab
- Room cards showing temperature, humidity, battery status
- Stats bar: Outside temp, House average, Warmest room, Coldest room, Heating status (ON/OFF)
- Clock display
- Last update timestamp

### History Tab
- **Indoor Temperature History** (700px) - All rooms except Outside
- **Outdoor Temperature History** (200px) - Outside only
- **Indoor Humidity History** (700px) - All rooms except Outside
- **Outdoor Humidity History** (200px) - Outside only
- Time range selector: 6h, 12h, 24h, 48h, 7 days
- Dual timelines (top and bottom)
- Dual legends (top and bottom)
- Heating period shading (orange)

### Analysis Tab
- Temperature differentials vs Entrance Hall (thermostat location)
- Heating/cooling rates
- Daily statistics

### Data Tab
- Raw data export

---

## Floor Plan Reference

### Ground Floor (560 sq.ft)
- Kitchen
- Kitchen/Dining Room (21'8" x 13'3") - Console location
- Laundry
- Living Room (16'1" x 11'6") - TV on left wall
- Entrance Hall - Stairs to first floor
- WC
- Cupboard under stairs

### First Floor (567 sq.ft)
- Bedroom 2 (12'0" x 10'6")
- Bedroom 3 (12'0" x 6'9") - Not monitored
- Bedroom 4 (9'4" x 6'7") - Not monitored
- Master Bedroom (12'0" x 11'8")
- Bathroom
- Ensuite
- Landing
- Cupboard
- Wardrobe

### Radiator Locations
- Ground: Kitchen/Dining, Laundry, Living Room (far right), Entrance Hall (near door)
- First: All bedrooms have radiators under windows

---

## Issues Resolved

### Neighbour's Sensor Interference (24/12/2024)
- **Problem:** ch1 showing 12°C/78% when actual sensor showed 21°C
- **Cause:** Neighbour's Ecowitt system broadcasting on same ch1 frequency
- **Solution:** Used HP2561 "Sensor ID" registration feature (Gear > More > Sensors ID > Re-register) to lock console to specific sensor ID

### Battery Warning Logic (24/12/2024)
- **Problem:** All sensors showing "Low Battery!" when batteries were fine
- **Cause:** Code used `battery <= 1` which triggered on 0 (OK)
- **Solution:** Changed to `battery >= 1` to only warn when actually low

### Chart Timeline Sync (23/12/2024)
- **Problem:** Top and bottom timelines showing different ranges
- **Solution:** Compute minTime/maxTime from data and set explicitly on both axes

### Chart Height Expansion (23/12/2024)
- **Problem:** Charts expanding vertically uncontrollably
- **Solution:** Wrapped canvas in fixed-height div containers

### Room Name Inconsistency (23/12/2024)
- **Problem:** "Hallway (Console)" in database instead of "Dining Room (Console)"
- **Solution:** SQL UPDATE on both local SQLite and Supabase

---

## Data Anomalies

### Heating Failure (24/12/2024)
- **Time:** 15:30 scheduled start - heating failed to switch on
- **Impact:** Temperatures lower than normal for evening period
- **Note:** Exclude this period from baseline analysis

### Heating Partial Operation (25/12/2024)
- **Time:** Morning heating cycle
- **Status:** Heating started but not running at full range
- **Impact:** Temperatures may be lower than normal baseline

### Radiator Bleeding In Progress (25/12/2024)
- **Time:** 08:20 - 08:40
- **Reason:** Radiators not functioning well, prompted early bleeding
- **Status:** Started but not complete on all radiators
- **Master Bedroom:** Particularly incomplete - expect lower temps in ch4
- **Impact:** Variable heating performance across rooms until complete

### Manual Heating Test (25/12/2024)
- **Time:** 13:00 - 14:00
- **Reason:** Manual heating test outside normal schedule
- **Purpose:** Test heating performance after radiator bleeding
- **Note:** This is outside the normal heating schedule (06:50-09:30, 15:30-22:00)

### Tumble Dryer Running (25/12/2024)
- **Time:** ~10:00 - 13:00 (approx 3 hours)
- **Location:** Laundry room
- **Conditions:** Dining room door open, laundry room is open-fronted
- **Impact:** Expect elevated humidity in Laundry (ch3) and possibly Dining Room (console)
- **Note:** Heat/humidity from dryer may affect readings in both rooms

### Evening Heating Failure + Late Recovery (25/12/2024)
- **Time:** 15:30 - 22:30 heating failed to operate
- **Recovery:** 22:30 - heating restored, boiler set to max temp
- **Extended Run:** 22:30 through entire night until 09:30 morning cycle end
- **Impact:** Evening temperatures lower than expected; late spike from recovery heating
- **Note:** Useful for comparing heating performance at max boiler temp vs normal

### Overnight Heating + Door Closure Test (25-26/12/2024)
- **Time:** 22:30 (25th) through 09:30 (26th) - continuous heating
- **Boiler Setting:** Max temperature throughout
- **Door Configuration:**
  - Living Room: CLOSED
  - Master Bedroom: CLOSED
  - Layla Room: CLOSED (window slightly open for condensation)
  - Kitchen door (to hallway): CLOSED
  - Dining Room: OPEN to Laundry (open-fronted)
  - Result: Dining/Kitchen/Laundry form one connected zone
- **Tumble Dryer:** OFF
- **Purpose:** Test heat retention with doors closed vs typical open-door baseline
- **Expected:** Bedrooms should retain heat better overnight; living room may be cooler but more stable

---

## System Changes

### New Boiler Installation (04/02/2026)
- **Date:** 04 February 2026
- **Change:** Old boiler replaced with new boiler
- **Impact on Analysis:**
  - Energy usage data before this date reflects old boiler performance
  - Data from 04/02/2026 onwards reflects new boiler efficiency
  - Compare gas consumption before/after to measure efficiency improvements
  - Warm-up rates may improve with new boiler
  - Consider this date as a key boundary when running analysis comparisons

### Immersion Heater Usage (Late Dec 2024 - 04/02/2026)
- **Period:** Late December 2024 to 04 February 2026
- **Reason:** Old boiler unable to heat water; immersion heater used as temporary solution
- **Impact on Analysis:**
  - **Electricity usage elevated** during this period (immersion heater is electric)
  - **From 04/02/2026:** Electricity should decrease (no immersion heater)
  - **From 04/02/2026:** Gas may increase slightly (new boiler heating water)
  - When comparing energy costs, factor in the shift from electric water heating to gas

**Recommended Analysis Comparisons:**
- Gas consumption: Compare weekly/monthly totals before vs after 04/02/2026
- Electricity consumption: Expect decrease after 04/02/2026 (no immersion heater)
- **Total energy cost:** Compare combined gas + electricity costs, not just gas alone
- Heating efficiency: Compare warm-up rates (time to reach target temperature)
- Room temperature consistency: New boiler may provide more even heating

---

## Planned Experiments

### Radiator Bleeding (In Progress)
- **Started:** 25/12/2024 (earlier than planned due to poor radiator performance)
- **Status:** Incomplete - see Data Anomalies section
- **Purpose:** Observe temperature changes after bleeding radiators
- **Expected:** More even heating, faster heat-up times in affected rooms

### Door Closure Test (First Trial Complete)
- **First Trial:** 25-26/12/2024 overnight - see Data Anomalies section
- **Purpose:** Measure heat retention with doors closed vs open
- **Method:** Keep certain doors closed for a period and compare data
- **Rooms of Interest:** Bedrooms and Living Room
- **Baseline Needed:** Repeat with doors open on similar outdoor temp night for comparison

---

## Analysis Tests API

Available at `http://192.168.0.145:3001/api/analysis/...`

**Note:** Data prior to sensor deployment (15:40 24/12/2024) should be excluded from analysis.

### Warm-up Rate Test
```bash
curl "http://192.168.0.145:3001/api/analysis/warmup?period=morning&days=7"
curl "http://192.168.0.145:3001/api/analysis/warmup?period=evening&days=7"
```
- Measures how quickly each room heats up after heating starts
- Returns: avg_temp_rise, avg_mins_to_peak per room
- Useful for identifying slow-heating rooms (radiator issues)

### Cool-down Rate Test
```bash
curl "http://192.168.0.145:3001/api/analysis/cooldown?period=morning&days=7"
curl "http://192.168.0.145:3001/api/analysis/cooldown?period=evening&days=7"
```
- Measures how quickly each room cools after heating stops
- Measures temperature drop over 2 hours
- Useful for identifying rooms with poor insulation

### Morning vs Evening Cool-down Comparison
```bash
curl "http://192.168.0.145:3001/api/analysis/morning-vs-evening?days=7"
```
- Compares cool-down rates between morning (09:30) and evening (22:00)
- Shows if house loses heat faster at night (colder outside) vs day

### Morning vs Evening Warm-up Comparison
```bash
curl "http://192.168.0.145:3001/api/analysis/warmup-comparison?days=7"
```
- Compares warm-up rates between morning (06:50-09:30) and evening (15:30-22:00)
- Shows if rooms heat up faster in evening (warmer starting point) vs morning (cold start)

### Hallway vs Thermostat Test
```bash
curl "http://192.168.0.145:3001/api/analysis/thermostat?hours=24"
```
- Compares Entrance Hall (ch2) temperature to thermostat setting (25°C)
- Shows: avg temp, times reached target, % at target, avg below target
- Breaks down by period: morning_heating, evening_heating, heating_off

### Room Ranking
```bash
curl "http://192.168.0.145:3001/api/analysis/room-ranking?hours=24"
```
- Ranks all rooms by avg temp, min, max, range, humidity
- Quick overview of room performance

---

## Useful Commands

### Check sensor readings
```bash
curl -s "http://192.168.0.145:3001/api/current" | python3 -m json.tool
```

### Restart dashboard service
```bash
ssh root@192.168.0.145 'systemctl restart smart-home-dashboard'
```

### View service logs
```bash
ssh root@192.168.0.145 'journalctl -u smart-home-dashboard -f'
```

### Restart kiosk browser
```bash
ssh root@192.168.0.145 'pkill chromium; DISPLAY=:0 chromium --no-sandbox --kiosk http://localhost:3001 &'
```

### Deploy updated files
```bash
cat public/index.html | ssh root@192.168.0.145 'cat > /opt/smart-home-dashboard/public/index.html'
cat server.js | ssh root@192.168.0.145 'cat > /opt/smart-home-dashboard/server.js'
```

---

## Data Analysis Notes

### Baseline Period
- Data from before 15:40 24/12/2024 should be excluded (sensors not deployed)
- First valid analysis period starts after deployment

### Key Metrics to Watch
1. **Heat-up rate:** How quickly each room reaches target temperature after heating starts
2. **Cool-down rate:** How quickly rooms lose heat after heating stops
3. **Temperature differential:** Difference from Entrance Hall (thermostat location)
4. **Overnight retention:** Minimum temperature reached before morning heating

### Rooms of Interest
- **Living Room:** Large room with TV heat source
- **Laundry:** May have humidity spikes from washing/drying
- **Bedrooms:** Overnight temperature patterns important for comfort

---

## Version History

| Date | Changes |
|------|---------|
| 23/12/2024 | Initial setup, Ecowitt polling, SQLite storage |
| 23/12/2024 | Added Supabase cloud sync |
| 23/12/2024 | Added clock display, chart legends, dual timelines |
| 23/12/2024 | Fixed chart height issues |
| 24/12/2024 | Added heating schedule visualisation |
| 24/12/2024 | Separated indoor/outdoor charts |
| 24/12/2024 | Fixed sensor ID interference issue |
| 24/12/2024 | Fixed battery warning logic |
| 24/12/2024 | All sensors deployed to final positions (15:40) |
| 25/12/2024 | Added morning vs evening warm-up comparison endpoint |
| 25/12/2024 | Fixed outdoor temperature Y-axis decimal formatting |
| 25/12/2024 | Added Hildebrand Bright API integration for smart meter data |

---

*Generated by Claude Code - 25/12/2024*
