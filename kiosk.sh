#!/bin/bash
# Smart Home Dashboard Kiosk Mode

# Disable screen blanking
xset s off
xset s noblank
xset -dpms

# Hide cursor after 3 seconds of inactivity
unclutter -idle 3 -root &

# Wait for dashboard service to be ready
sleep 5

# Start Chromium in kiosk mode
chromium --kiosk --noerrdialogs --disable-infobars --disable-session-crashed-bubble --disable-restore-session-state --no-first-run --start-fullscreen http://localhost:3001
