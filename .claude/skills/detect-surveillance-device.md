---
description: >
  ALWAYS invoke this skill when the user asks to perform a bug sweep, TSCM sweep,
  counter-surveillance scan, RF spectrum scan, or detect hidden devices. Trigger
  phrases include: "sweep the room", "bug sweep", "TSCM", "counter-surveillance",
  "detect hidden camera", "find a bug", "RF sweep", "spectrum scan", "check for
  trackers", "is anyone listening", "scan for surveillance devices", "detect RF
  anomaly", "check 433MHz for bugs", "office sweep", "car sweep", "find listening
  device", "detect spy device".
  Do NOT produce jamming, neutralisation, or attack instructions — receive/detect only.
allowed-tools:
  - mcp__esp32-devops__esp32_list_ports
  - mcp__esp32-devops__esp32_get_recommended_port
  - mcp__esp32-devops__esp32_test_firmware
  - Bash
  - Read
  - Write
---

# /detect-surveillance-device

TSCM-style RF sweep using midas-recon hardware and/or SDR tools.

## Legal notice — READ FIRST

This skill performs **passive receive and analysis only**. In the UK:
- Ofcom regulates radio spectrum use (Wireless Telegraphy Act 2006).
- Passive scanning / receiving is legal for detection on your own property.
- **Jamming transmissions is illegal** under S.68 of the WTA 2006 — a criminal offence.
- **Recording private communications** without consent may violate RIPA 2000.
- This skill does not produce jamming, replay, or attack capabilities.
- For professional TSCM, consult a licensed security professional (CPNI guidance).

Proceed only on equipment/premises you own or have explicit authorisation to sweep.

## Prerequisites

One or more of:
- midas-recon device (ESP32 + CC1101/NRF24L01) connected via USB serial
- HackRF One (for broadband sweep via `hackrf_sweep`)
- RTL-SDR dongle (for `rtl_power` sweep)
- Any SDR tool accessible via `Bash`

## Step 1 — Inventory available hardware

1. Call `esp32_list_ports` — check for midas-recon device.
2. Run `Bash`: `hackrf_info 2>/dev/null && echo "HackRF: YES" || echo "HackRF: NO"`
3. Run `Bash`: `rtl_test -t 2>/dev/null && echo "RTL-SDR: YES" || echo "RTL-SDR: NO"`

Report what hardware is available. If nothing is found, tell the user which hardware
is recommended and stop.

## Step 2 — Define sweep parameters

Ask (or infer from context) if not provided:
- **Frequency range**: default comprehensive sweep
  - Sub-1GHz devices: 300–900 MHz (covers 315/433/868 MHz ISM bands)
  - 2.4 GHz band: 2400–2500 MHz (WiFi, Bluetooth, ZigBee bugs)
  - Full sweep: 1 MHz – 6 GHz (HackRF only)
- **Location context** (helps interpretation): home / office / vehicle / hotel room
- **Sweep duration**: default 60 s per band

## Step 3 — Perform sweep

### Option A: midas-recon CC1101 sweep (sub-1GHz)

```bash
python3 - <<'EOF'
import serial, time, sys

port = sys.argv[1]
with serial.Serial(port, 115200, timeout=2) as ser:
    # Request spectrum scan from midas-recon firmware
    ser.write(b"SPECTRUM_SCAN 300000000 900000000 100000\n")
    results = []
    deadline = time.time() + 90
    while time.time() < deadline:
        line = ser.readline().decode(errors='replace').strip()
        if line:
            results.append(line)
        if "SCAN_END" in line:
            break
    for r in results:
        print(r)
EOF
```

### Option B: HackRF sweep

```bash
hackrf_sweep -f 300:900 -w 100000 -N 1 -l 32 -g 40 2>/dev/null \
  | tee /tmp/hackrf_sweep_$(date +%Y%m%d_%H%M%S).csv | head -200
```

### Option C: RTL-SDR power scan

```bash
rtl_power -f 300M:900M:100k -g 40 -i 1 -e 60 \
  /tmp/rtl_power_$(date +%Y%m%d_%H%M%S).csv 2>/dev/null
```

### Option D: WiFi/BT/ZigBee (2.4 GHz via HackRF)

```bash
hackrf_sweep -f 2400:2500 -w 1000000 -N 1 -l 32 -g 40 2>/dev/null \
  | tee /tmp/hackrf_24ghz_$(date +%Y%m%d_%H%M%S).csv | head -100
```

## Step 4 — Anomaly detection

Parse sweep results for:

**High-priority anomaly indicators:**
- Signal > −60 dBm in a frequency band with no expected transmitters
- Intermittent bursts every 30–120 s (typical bug reporting interval)
- Continuous carrier in ISM bands (possible hidden camera video transmitter)
- Narrow FSK/GFSK signal in 433/868 MHz (typical audio bug)
- Bluetooth-like hopping at 2.4 GHz with unexpected device
- GSM/LTE uplink in 800/1800/2100 MHz (cellular bug / tracker)

**Common surveillance device frequencies (UK/EU):**

| Frequency | Likely device type |
|-----------|-------------------|
| 433.92 MHz | Keyfob, wireless sensor, cheap audio bug |
| 868 MHz | Z-Wave, LoRa sensor |
| 915 MHz | LoRa (US), ISM devices |
| 1227.6 / 1575.4 MHz | GPS (tracker) |
| 2400–2483 MHz | WiFi spy camera, BT device |
| 5150–5850 MHz | 5 GHz WiFi camera |

## Step 5 — Device identification

For each anomaly found:
1. Note: frequency, signal strength (dBm), modulation type (if determinable), duty cycle
2. Cross-reference against known device signatures
3. Assign suspicion level: LOW / MEDIUM / HIGH / CRITICAL

## Step 6 — Structured sweep report

Save a report using `Write`:

```
TSCM RF Sweep Report
====================
Date/Time:    2025-03-15 14:30:22
Location:     [user provided]
Hardware:     HackRF One + midas-recon CC1101
Sweep range:  300 MHz – 2.5 GHz
Duration:     ~3 minutes

ANOMALIES DETECTED
------------------
[HIGH]   433.921 MHz  −52 dBm  OOK bursts every ~45 s
         → Possible wireless audio transmitter or remote sensor
         → Recommended action: Physical search for small device;
           use directional antenna to locate source

[MEDIUM] 868.350 MHz  −71 dBm  FSK continuous
         → May be Z-Wave home automation (verify against known devices)
         → Recommended action: Check Z-Wave controller; if none present, investigate

CLEAR BANDS
-----------
315 MHz, 915 MHz, 2.4 GHz (no anomalies above threshold)

RECOMMENDATIONS
---------------
1. Physically inspect the area near the HIGH-priority signal source.
2. Use a directional antenna (or the midas-recon with a directional element)
   to triangulate the 433 MHz anomaly.
3. For professional TSCM, contact a CPNI-listed security provider.

Report saved to: sweep_report_20250315_143022.txt
```

## Step 7 — Next steps guidance

Based on findings, suggest:
- Physical search techniques for the anomalous frequencies
- Whether to engage `/rf-capture-analyzer` to characterise a specific signal
- Whether to engage `/generate-detection-rule` to create firmware detection logic

## Notes

- **This skill never generates jamming, replay, or attack payloads.**
- `Bash` commands run SDR tools that must be installed by the user.
- `allowed-tools` applies to CLI. For Agent SDK, enforce via `allowedTools`.
- All captures saved during this skill are for analysis only and should be handled
  in accordance with applicable law.
