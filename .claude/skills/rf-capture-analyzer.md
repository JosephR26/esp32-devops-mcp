---
description: >
  ALWAYS invoke this skill when the user asks to capture, record, analyse, decode,
  or demodulate RF signals from a midas-recon or similar ESP32+CC1101/NRF24L01 device.
  Trigger phrases include: "capture RF", "record RF", "analyse capture", "decode the
  signal", "what frequency is this", "demodulate", "save RF capture", "read CC1101",
  "sniff NRF24", "capture from midas", "RF capture file", "analyse .iq file",
  "what protocol is this RF signal", "reverse the RF".
  Do NOT attempt to analyse RF captures without routing through this skill.
allowed-tools:
  - mcp__esp32-devops__esp32_list_ports
  - mcp__esp32-devops__esp32_get_recommended_port
  - mcp__esp32-devops__esp32_test_firmware
  - Bash
  - Read
  - Write
---

# /rf-capture-analyzer

Capture RF data from midas-recon hardware (ESP32 + CC1101 / NRF24L01) and analyse it.

## Legal notice

RF capture for analysis on your own equipment or with explicit written permission is
legal in the UK (and most jurisdictions). Capturing third-party transmissions without
consent may violate the Wireless Telegraphy Act 2006 and the Investigatory Powers Act
2016. Transmitting on a captured frequency (replay attacks) without authorisation is
illegal under Ofcom regulations. This skill is for RECEIVE/ANALYSE only — never replay
without authorisation.

## Prerequisites

- midas-recon device flashed and connected via USB serial
- `FIRMWARE_TOOLKIT_PATH` set if using FirmwareToolkit capture scripts
- Optional: GNU Radio, rtl_433, or Universal Radio Hacker (URH) for advanced analysis

## Step 1 — Connect to device

1. Call `esp32_get_recommended_port`. If no port, call `esp32_list_ports` and confirm.
2. Call `esp32_test_firmware(port)` to verify the device is alive.
   - If boot/heartbeat fails: prompt user to check connection or reflash.

## Step 2 — Initiate capture via serial command

If a `midas_recon_command` MCP tool is available, use it.
Otherwise, use `Bash` to send a capture command over serial:

```bash
# Install pyserial if needed: pip install pyserial
python3 - <<'EOF'
import serial, time, sys

port = sys.argv[1] if len(sys.argv) > 1 else "/dev/ttyUSB0"
freq = sys.argv[2] if len(sys.argv) > 2 else "433920000"  # 433.92 MHz default
duration = int(sys.argv[3]) if len(sys.argv) > 3 else 10  # seconds

with serial.Serial(port, 115200, timeout=1) as ser:
    # Send capture command in midas-recon command format
    cmd = f"CAPTURE {freq} {duration}\n"
    ser.write(cmd.encode())
    time.sleep(0.5)

    capture_data = []
    deadline = time.time() + duration + 5
    while time.time() < deadline:
        line = ser.readline().decode(errors='replace').strip()
        if line:
            capture_data.append(line)
            if line.startswith("CAPTURE_END"):
                break

    for l in capture_data:
        print(l)
EOF
```

Ask the user for:
- Target frequency (Hz or MHz) — default 433.92 MHz
- Capture duration (seconds) — default 10 s
- Port — from Step 1

## Step 3 — Save capture to file

Use `Write` to save the raw capture output to a local file:
- Filename format: `capture_<YYYYMMDD_HHMMSS>_<freq>MHz.txt`
- Example: `capture_20250315_143022_433MHz.txt`

Also try to save in a structured format if the device outputs JSON or hex bytes.

## Step 4 — Basic analysis

Parse the captured data for:

**Signal presence indicators:**
- Repeated bursts with consistent timing → likely keyfob / remote
- Continuous carrier → jammer or test tone
- Spread spectrum pattern → frequency-hopping device
- Low duty cycle bursts → sensor telemetry

**Common 433 MHz protocols to check (use `Bash` with rtl_433 if available):**
```bash
# If capture is in rtl_433-compatible format:
rtl_433 -r <capture_file> -F json 2>/dev/null | head -50
```

**Use URH for manual analysis if available:**
```bash
urh <capture_file> --cli --demodulation ASK --samples-per-symbol 100 2>/dev/null
```

## Step 5 — Protocol identification

Based on analysis, report:

```
RF Capture Analysis
===================
File:         capture_20250315_143022_433MHz.txt
Frequency:    433.92 MHz
Duration:     10 s
Signal type:  OOK (On-Off Keying) bursts
Timing:       Short pulse ~500 µs, Long pulse ~1500 µs
Pattern:      Repeated 24-bit code with preamble
Likely proto: Princeton PT2262 / EV1527 style remote
Confidence:   HIGH

Raw bits: 101010101010110100101011 (repeated x3)
```

## Step 6 — Generate detection logic (optional)

If the user asks to generate firmware detection code, suggest using `/generate-detection-rule`
with the protocol description from this analysis.

## Step 7 — Output files

Always report:
- Path to saved capture file
- Summary of detected signal characteristics
- Suggested next steps (manual analysis tool commands, protocol database links)

## Notes

- This skill uses `Bash` for serial I/O and external analysis tools. The `Bash` tool
  permission should be confirmed by the user before execution.
- If the midas-recon firmware does not support serial capture commands, read capture
  files directly from the filesystem instead (use `Read`).
- `allowed-tools` applies to CLI. For Agent SDK, enforce via `allowedTools`.
