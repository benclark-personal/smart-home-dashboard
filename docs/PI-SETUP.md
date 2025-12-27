# Raspberry Pi Configuration - Cross-Project Reference

This document tracks shared configuration, resource usage, and compatibility notes across all projects running on the Raspberry Pi.

## Pi Hardware
- **Model:** Raspberry Pi (specify model)
- **Storage:** (specify SD card size)
- **IP Address:** 192.168.1.119

## Projects Running on This Pi

### 1. Smart Home Dashboard
- **Repository:** [benclark-personal/smart-home-dashboard](https://github.com/benclark-personal/smart-home-dashboard)
- **Port:** 3001
- **Service:** Energy monitoring dashboard with Bright API integration
- **Database:** SQLite (`/path/to/energy.db`)
- **Auto-start:** Yes (systemd service)

### 2. ADS-B Feeder
- **Repository:** [benclark-personal/adsb-feeder-config](https://github.com/benclark-personal/adsb-feeder-config)
- **Ports:** (document ports used)
- **Service:** Aircraft tracking and feeding to flight tracking networks
- **Auto-start:** Yes

## Storage Usage

Check current usage:
```bash
df -h /
du -sh /home/pi/*
```

## Port Allocation
| Port | Project | Service |
|------|---------|---------|
| 3001 | smart-home-dashboard | Node.js API + Frontend |
| TBD  | adsb-feeder | ADS-B services |

## Potential Conflicts
- Document any resource conflicts here
- CPU-intensive operations
- Shared network resources

## Maintenance Notes
- Regular backups: energy data synced to Supabase
- Log rotation: (configure if needed)
- Updates: (document update procedure)

---
*Last updated: December 2024*
