# Smart Home Temperature Dashboard

A Node.js web dashboard for monitoring home temperature sensors, running on Raspberry Pi 4.

## Hardware & System Configuration

This application runs on a Raspberry Pi 4 at **192.168.0.145**. For complete hardware specifications, system configuration, and deployment procedures, see the **[raspberry-pi-config](../raspberry-pi-config)** repository.

**Key Hardware**:
- Raspberry Pi 4 Model B (4GB RAM)
- Low Profile Ice Tower Cooler (~35°C under load)
- DietPi OS (Debian-based)

**Related Projects** running on the same Pi:
- [adsb_feeder_config](../adsb_feeder_config) - ADS-B flight tracking (Ports 8080, 8081, 8754)
- [autodarts](../autodarts) - Darts board manager (Port 3180)

## Application Details

- **Deployment Path**: `/opt/smart-home-dashboard/`
- **Service**: `smart-home-dashboard.service` (systemd)
- **Port**: 3001
- **URL**: http://192.168.0.145:3001
- **Auto-start**: Yes (enabled on boot)

## Deployment

For detailed deployment procedures, see [raspberry-pi-config/docs/deployment.md](../raspberry-pi-config/docs/deployment.md).

### Quick Deploy
```bash
# From local machine
rsync -avz --delete -e "sshpass -p 'holymoly10' ssh" \
  ~/repos/personal/smart_home_dashboard/ \
  root@192.168.0.145:/opt/smart-home-dashboard/

# Restart service
ssh root@192.168.0.145 'systemctl restart smart-home-dashboard'

# Verify
curl http://192.168.0.145:3001
```

## Service Management

```bash
# Check status
ssh root@192.168.0.145 'systemctl status smart-home-dashboard'

# View logs
ssh root@192.168.0.145 'journalctl -u smart-home-dashboard -f'

# Restart
ssh root@192.168.0.145 'systemctl restart smart-home-dashboard'

# Stop
ssh root@192.168.0.145 'systemctl stop smart-home-dashboard'

# Start
ssh root@192.168.0.145 'systemctl start smart-home-dashboard'
```

## Development

### Local Development
```bash
# Install dependencies
npm install

# Run locally
npm start

# Access at http://localhost:3001
```

### Dependencies
- Node.js (v14 or higher)
- npm packages as specified in package.json

## Configuration

Configuration files and environment variables (if any) are stored in the deployment directory on the Pi.

## Troubleshooting

### Service Won't Start
```bash
# Check logs for errors
ssh root@192.168.0.145 'journalctl -u smart-home-dashboard -n 50'

# Check file permissions
ssh root@192.168.0.145 'ls -la /opt/smart-home-dashboard/'

# Reinstall dependencies
ssh root@192.168.0.145 'cd /opt/smart-home-dashboard && npm install --production'
```

### Cannot Access Dashboard
```bash
# Check if service is running
ssh root@192.168.0.145 'systemctl status smart-home-dashboard'

# Check if port is listening
ssh root@192.168.0.145 'netstat -tulpn | grep 3001'

# Test from Pi itself
ssh root@192.168.0.145 'curl http://localhost:3001'
```

### High Resource Usage
```bash
# Check system resources
ssh root@192.168.0.145 'free -h'
ssh root@192.168.0.145 'df -h'
ssh root@192.168.0.145 'vcgencmd measure_temp'
```

## Backup

Configuration and code are version controlled in this Git repository. Deploy from Git to restore.

```bash
# Backup configuration (if needed)
ssh root@192.168.0.145 'tar -czf smart-home-backup.tar.gz /opt/smart-home-dashboard/'
scp root@192.168.0.145:~/smart-home-backup.tar.gz ./backups/
```

## System Integration

The Smart Home Dashboard runs as a systemd service and starts automatically on boot. It coexists with other services on the Pi:
- **CPU**: ~5-10% idle, ~20-30% when serving requests
- **RAM**: ~50-100MB
- **Temperature**: Minimal impact (~1-2°C)

See [raspberry-pi-config](../raspberry-pi-config) for system-level monitoring and resource allocation.

## Support

For hardware issues, system configuration, or deployment problems, refer to the [raspberry-pi-config](../raspberry-pi-config) repository documentation.
