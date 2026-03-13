---
description: >
  ALWAYS invoke this skill when the user asks about serial ports, COM ports, or device
  connection. Trigger phrases include: "which port is my ESP32", "what port is it on",
  "set default port", "change port", "list ports", "show me the ports", "help with
  serial", "add favorite port", "my device is on COM3", "ttyUSB0", "can't find port",
  "no serial port detected", "which COM port should I use".
  Do NOT call port tools directly outside this skill.
allowed-tools:
  - mcp__esp32-devops__esp32_list_ports
  - mcp__esp32-devops__esp32_detect_ports
  - mcp__esp32-devops__esp32_get_recommended_port
  - mcp__esp32-devops__esp32_set_default_port
  - mcp__esp32-devops__esp32_add_favorite_port
  - Read
---

# /esp32-port-manager

Manage serial ports for ESP32 development.

## Step 1 — Identify user intent

| User says | Action |
|-----------|--------|
| "which port" / "what port" / "find my ESP32" | Step 2: Detect |
| "list ports" / "show ports" / "available ports" | Step 2: List all |
| "set default port" / "use COM3" / "use /dev/ttyUSB0" | Step 4: Set default |
| "add favorite" / "save this port" / "label port" | Step 5: Add favorite |
| "recommended port" / "best port" | Step 3: Get recommended |

## Step 2 — Detect / list ports

Call `esp32_list_ports`. This returns:
- All detected serial ports
- Which ones look like ESP32 devices (based on VID/PID)
- Current default port (if set)
- Favorites list

Display results as a table:

```
Port          | Description              | ESP32? | Status
/dev/ttyUSB0  | CP210x USB to UART       | YES    | Available
/dev/ttyACM0  | Arduino Mega 2560        | no     | Available
COM3          | Silicon Labs CP210x...   | YES    | FAVORITE (my-esp32)
```

If no ports found:
- Suggest the user plug in the ESP32 and retry
- On Linux: remind them to join the `dialout` group (`sudo usermod -aG dialout $USER`)
- On Windows: suggest installing CP210x / CH340 drivers

## Step 3 — Get recommended port

Call `esp32_get_recommended_port`. Priority order:
1. Explicitly set default port
2. Last successfully used port
3. Auto-detected ESP32 port

Report which port was recommended and why.

## Step 4 — Set default port

1. If the user specified a port (e.g., "use COM3"), call `esp32_set_default_port("COM3")`.
2. If not specified, first call `esp32_list_ports` and ask the user to pick.
3. Confirm: "Default port set to COM3. All future operations will use this port."

## Step 5 — Add favorite port

Call `esp32_add_favorite_port(port, name?)`:
- `port` — the port string (e.g., `/dev/ttyUSB0`, `COM3`)
- `name` — optional human label (e.g., "midas-recon", "devkit-v4")

Confirm: "Port /dev/ttyUSB0 saved as favorite 'midas-recon'."

## Common port patterns

| Platform | Typical pattern     | Notes |
|----------|--------------------|-|
| Windows  | `COM3`, `COM4`, ... | Device Manager shows exact number |
| Linux    | `/dev/ttyUSB0`, `/dev/ttyACM0` | USB-UART: ttyUSBx; native USB: ttyACMx |
| macOS    | `/dev/cu.usbserial-*`, `/dev/cu.SLAB_USBtoUART` | Use `cu.*` not `tty.*` |

## Notes

- `esp32_detect_ports` is a subset of `esp32_list_ports` (only returns detected ESP32s).
  Prefer `esp32_list_ports` for user-facing display.
- `allowed-tools` applies to CLI. For Agent SDK, enforce via `allowedTools`.
