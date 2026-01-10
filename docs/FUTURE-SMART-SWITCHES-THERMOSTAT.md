# Future Project: Smart Light Switches & Thermostat

*Research notes - December 2024*

---

## Overview

Two potential upgrades for the smart home:
1. **Smart light switches** for hallway/landing with auto-off timers
2. **Smart thermostat** to integrate with new system boiler

---

## Current Situation

### Lighting
- Double switch in hallway → controls BOTH hallway + landing lights
- Double switch on landing → controls BOTH hallway + landing lights
- Single switch in hallway → controls hallway light only
- **2-way switching circuit** (multiple switches control same lights)
- Problem: Lights always left on

### Heating
- Gas boiler being replaced with **system/heat-only boiler** (separate hot water cylinder)
- Current dial thermostat
- Dashboard tracks heating schedule manually

---

## Smart Light Switches

### Option A: Yagusmart WiFi Switches (Simpler)

Replacement switch panels that swap out existing switches.

| Item | Price |
|------|-------|
| 2 x Yagusmart 1-gang (white) | ~£30-36 |
| 1 x Yagusmart 2-gang (black only) | ~£22-25 |
| **Total** | **~£52-61** |

**Pros:**
- Simple concept - just swap the switch
- Works with Smart Life app + Alexa
- No separate hub needed

**Cons:**
- 2-way switching is tricky - need to replace ALL switches on circuit
- Usually requires neutral wire (30-year-old house may not have this)
- If dumb switch left in circuit, it can cut power to smart switch

---

### Option B: SONOFF ZBMINIL2 Modules (Better for 2-way)

Modules that fit BEHIND existing switches - keeps current switch plates.

| Item | Price |
|------|-------|
| 2 x SONOFF ZBMINIL2 | ~£24-30 |
| 1 x SONOFF ZBBridge-P (Zigbee hub) | ~£25-28 |
| **Total** | **~£52-58** |

**Pros:**
- **No neutral wire required**
- **Designed for 2-way circuits** (S1/S2 terminals)
- Keep existing switch plates
- Built-in "Inching Mode" for auto-off timer
- Zigbee = local control, more reliable than WiFi

**Cons:**
- Needs Zigbee hub
- Slightly more complex installation (goes in wall box behind switch)

**Why this might be better for your setup:**
Your 2-way switching means multiple switches control the same lights. ZBMINIL2 handles this properly - you install ONE module per light circuit (not per switch), and your existing switches just act as inputs. No fighting between smart switches.

---

### Auto-Off Timer Options

1. **eWeLink Inching Mode** (with SONOFF) - set 5-min auto-off directly in app, works locally
2. **Alexa Routine** - "When light turns on → Wait 5 mins → Turn off" (needs internet)
3. **Smart Life app** (with Yagusmart) - automation rules in app

---

## Smart Thermostat

### Option A: Qiumi Budget Thermostat (~£30)

Basic smart thermostat, works with Smart Life app.

**Amazon:** https://www.amazon.co.uk/dp/B07HQ8Z3ZR

**Pros:**
- Very cheap
- Same app as Yagusmart switches
- Alexa compatible
- Simple 2-wire swap from dial thermostat

**Cons:**
- **Single channel only** - controls heating, NOT hot water
- Cloud-dependent
- No expansion (no TRVs)
- May not be suitable for system boiler with separate hot water

---

### Option B: Drayton Wiser Kit 2 (~£173)

Proper UK smart heating system designed for system boilers.

**Screwfix:** https://www.screwfix.com/p/drayton-wiser-wireless-heating-hot-water-internet-enabled-2-channel-smart-thermostat-kit-anthracite/117ka

**Pros:**
- **2-channel control** (heating + hot water) - right for system boiler
- Works offline (local control)
- Expandable with Smart TRVs (~£45-50 each) for room control
- Local API for dashboard integration
- Alexa compatible
- Good UK support

**Cons:**
- More expensive upfront
- Professional install recommended (~£50-100)

---

### Thermostat Comparison

| Feature | Qiumi (~£30) | Wiser Kit 2 (~£173) |
|---------|-------------|---------------------|
| Channels | Single (heating only) | 2 (heating + hot water) |
| System boiler support | Limited | Full |
| Room-by-room control | No | Yes (with TRVs) |
| Works offline | No | Yes |
| Dashboard API | No | Yes (local) |
| Expandable | No | Yes |

**Recommendation for system boiler:** Wiser Kit 2 is the right choice - Qiumi won't control your hot water.

---

## Cost Summary

### Budget Route
| Item | Cost |
|------|------|
| Yagusmart switches | ~£55 |
| Qiumi thermostat | ~£30 |
| **Total** | **~£85** |

*Caveat: May have issues with 2-way switching and won't control hot water*

### Recommended Route
| Item | Cost |
|------|------|
| SONOFF ZBMINIL2 x2 + hub | ~£55 |
| Drayton Wiser Kit 2 | ~£173 |
| **Total** | **~£228** |

*Properly handles 2-way switching and system boiler*

### Full Setup (with room control)
| Item | Cost |
|------|------|
| SONOFF ZBMINIL2 x2 + hub | ~£55 |
| Drayton Wiser Kit 2 | ~£173 |
| Wiser TRVs x4 | ~£180-200 |
| **Total** | **~£408-428** |

---

## Installation Notes

### Light Switches
1. Check for neutral wire first (turn off power, remove switch plate)
2. ZBMINIL2 works without neutral - designed for UK homes
3. Install module at light fitting or first switch position where permanent live is available
4. DIY if comfortable, or electrician ~£50-80

### Thermostat
1. Coordinate with boiler installer - ask about OpenTherm support
2. Ask installer to leave space for Wiser Heat Hub R
3. Can be installed same day as boiler or after
4. Professional install recommended for Heat Hub R (~£50-100)
5. TRV installation is DIY-friendly

---

## Home Assistant Note

Neither solution requires Home Assistant to work. Both work standalone with Alexa.

If you later want:
- Ecowitt sensors to influence heating decisions
- Complex automations
- Unified dashboard control

...Home Assistant can be added to the existing Pi. It's free software. Consider it a future enhancement.

---

## Decision Points

Before purchasing, decide:

1. **Lighting approach:**
   - [ ] Yagusmart (simpler but 2-way issues)
   - [ ] SONOFF ZBMINIL2 (better for 2-way circuits)

2. **Thermostat:**
   - [ ] Qiumi budget (heating only, ~£30)
   - [ ] Drayton Wiser (heating + hot water, ~£173)

3. **Room control:**
   - [ ] Not needed initially
   - [ ] Add TRVs to key rooms (~£45-50 each)

---

## Product Links

**SONOFF:**
- ZBMINIL2: https://www.amazon.co.uk/s?k=sonoff+zbminil2
- ZBBridge-P: https://www.amazon.co.uk/s?k=sonoff+zigbee+bridge+pro

**Yagusmart:**
- Search: https://www.amazon.co.uk/s?k=yagusmart+smart+switch

**Thermostats:**
- Qiumi: https://www.amazon.co.uk/dp/B07HQ8Z3ZR
- Wiser Kit 2: https://www.screwfix.com/p/drayton-wiser-wireless-heating-hot-water-internet-enabled-2-channel-smart-thermostat-kit-anthracite/117ka
- Wiser TRVs: https://www.screwfix.com/search?search=wiser+trv
