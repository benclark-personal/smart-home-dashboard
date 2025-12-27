# Raspberry Pi Configuration - Cross-Project Reference

This document tracks shared configuration, resource usage, and compatibility notes across all projects running on the Raspberry Pi.

## Pi Hardware
- **Model:** Raspberry Pi 4
- **OS:** DietPi
- **IP Address:** 192.168.1.119
- **Location:** Stonehouse, UK (51.75385, -2.278766)

---

## Projects Running on This Pi

### 1. Smart Home Dashboard
- **Repository:** [benclark-personal/smart-home-dashboard](https://github.com/benclark-personal/smart-home-dashboard)
- **Port:** 3001
- **Service:** Energy and temperature monitoring dashboard
- **Components:**
  - Ecowitt temperature/humidity sensors (HP2561 console)
  - Hildebrand Bright API (smart meter data)
- **Database:** SQLite (`/opt/smart-home-dashboard/readings.db`)
- **Cloud Backup:** Supabase (temperature_readings, energy_readings tables)
- **Auto-start:** Yes (systemd service)

### 2. ADS-B Feeder
- **Repository:** [benclark-personal/adsb-feeder-config](https://github.com/benclark-personal/adsb-feeder-config)
- **Service:** Aircraft tracking and feeding to flight tracking networks
- **Runtime:** Docker Compose
- **SDR:** RTL-SDR (serial: 1090, gain: autogain, PPM: -12)
- **Containers:**
  - ultrafeeder (decoder + tar1090 map)
  - piaware (FlightAware)
  - fr24 (FlightRadar24)
  - pfclient (PlaneFinder)
  - planewatch (Plane.Watch)
- **Data Storage:** `/opt/adsb/ultrafeeder/`
- **Auto-start:** Yes (Docker restart policy)

---

## Other Projects (Not on Pi)

### Gloucester Hurricanes Website
- **Repository:** [Gloucester-Hurricanes-Website](https://github.com/benclark-personal/gloucester-hurricanes-website) (if exists)
- **Hosting:** Netlify (cloud-hosted, NOT on Pi)
- **Type:** React app with Netlify Functions (serverless)
- **Local Dev Ports:** 3000 (React), 8888 (netlify dev)
- **Production URL:** (Netlify URL)
- **No Pi resources used**

---

## Port Allocation Registry

### Pi Ports - Currently In Use

| Port  | Project | Service | Description |
|-------|---------|---------|-------------|
| 3001  | smart-home-dashboard | Node.js | API + Web interface |
| 8080  | adsb-feeder | Ultrafeeder | tar1090 map + graphs1090 |
| 8081  | adsb-feeder | PiAware | FlightAware web interface |
| 8754  | adsb-feeder | FR24 | FlightRadar24 status page |
| 30005 | adsb-feeder | Beast | Beast output for external MLAT clients |
| 30053 | adsb-feeder | PlaneFinder | PlaneFinder client |

### Pi Ports - Reserved for Future Use

| Port  | Reserved For | Notes |
|-------|--------------|-------|
| 3002  | Future project | Next Node.js service |
| 3003  | Future project | Next Node.js service |
| 8082  | Future project | Web interface |
| 8083  | Future project | Web interface |

### Pi Ports - Avoid Using

| Port Range | Reason |
|------------|--------|
| 1-1023 | System/privileged ports |
| 3000 | Common React dev port (conflicts with local dev) |
| 5432 | PostgreSQL default |
| 6379 | Redis default |
| 8888 | Netlify dev default |
| 9000-9999 | Common monitoring/debug ports |
| 30000-39999 | Reserved for ADS-B services |

### Internal Ports (Docker network only)

| Port  | Service | Protocol |
|-------|---------|----------|
| 30004 | Beast output | Outbound to aggregators |
| 31090 | MLAT | Outbound to aggregators |
| 39000-39005 | MLAT results | Internal return ports |
| 30105 | PiAware MLAT | Internal Beast input |

---

## Adding a New Project to the Pi

### Checklist
1. **Check port availability:** Review the Port Allocation table above
2. **Choose a port:** Pick from reserved ports or an unused port >1024
3. **Update this document:** Add the new project and port to the registry
4. **Test for conflicts:** Run `ss -tlnp | grep <port>` on the Pi
5. **Document in project README:** Reference this PI-SETUP.md file

### Recommended Port Ranges
- **3001-3009:** Node.js web services
- **8080-8089:** Web interfaces
- **5000-5009:** Python/Flask services
- **4000-4009:** GraphQL/API services

---

## Storage Usage

Check current usage:
```bash
df -h /
du -sh /opt/*
```

Key directories:
- `/opt/smart-home-dashboard/` - Dashboard app + SQLite database
- `/opt/adsb/ultrafeeder/globe_history/` - Aircraft position history
- `/opt/adsb/ultrafeeder/graphs1090/` - System statistics

---

## Resource Considerations

### CPU Usage
- **Ultrafeeder:** Moderate CPU for decoding 1090MHz signals
- **Smart Home Dashboard:** Low CPU (polling every 5 mins for temp, 4 hours for energy)
- Both services can run simultaneously without issues

### Network Usage
- **ADS-B Feeder:** Continuous outbound connections to ~15 aggregators
- **Smart Home Dashboard:** Periodic API calls (Ecowitt, Bright, Supabase)

### USB Devices
- RTL-SDR dongle (ADS-B reception)
- Ensure no USB conflicts if adding other devices

---

## Maintenance

### Backups
- **Temperature data:** Synced to Supabase on each poll
- **Energy data:** Synced to Supabase during backfill operations
- **ADS-B config:** Git repository (no persistent data backup needed)

### Updates
```bash
# Smart Home Dashboard
cd /opt/smart-home-dashboard && git pull && sudo systemctl restart smart-home-dashboard

# ADS-B Feeder
cd /opt/adsb && docker-compose pull && docker-compose up -d
```

### Logs
```bash
# Smart Home Dashboard
sudo journalctl -u smart-home-dashboard -f

# ADS-B Feeder
docker logs -f ultrafeeder
docker logs -f piaware
```

### Check All Listening Ports
```bash
ss -tlnp | grep LISTEN
```

---
*Last updated: December 2024*
