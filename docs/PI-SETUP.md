# Raspberry Pi Configuration - Cross-Project Reference

This document tracks shared configuration, resource usage, and compatibility notes across all projects running on the Raspberry Pi.

## Pi Hardware
- **Model:** Raspberry Pi 4
- **OS:** DietPi
- **IP Address:** 192.168.1.119
- **Location:** Stonehouse, UK (51.75385, -2.278766)

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

## Port Allocation

| Port  | Project | Service | Description |
|-------|---------|---------|-------------|
| 3001  | smart-home-dashboard | Node.js | API + Web interface |
| 8080  | adsb-feeder | Ultrafeeder | tar1090 map + graphs1090 |
| 8081  | adsb-feeder | PiAware | FlightAware web interface |
| 8754  | adsb-feeder | FR24 | FlightRadar24 status page |
| 30005 | adsb-feeder | Beast | Beast output for external MLAT clients |
| 30053 | adsb-feeder | PlaneFinder | PlaneFinder client |

### Internal Ports (Docker network only)
| Port  | Service | Protocol |
|-------|---------|----------|
| 30004 | Beast output | Outbound to aggregators |
| 31090 | MLAT | Outbound to aggregators |
| 39000-39005 | MLAT results | Internal return ports |
| 30105 | PiAware MLAT | Internal Beast input |

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

---
*Last updated: December 2024*
