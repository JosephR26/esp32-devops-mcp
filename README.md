# ESP32 DevOps MCP Server

> **AI-powered ESP32 development automation for Claude Code**

[![Featured on LobeHub](https://lobehub.com/badge/mcp--josephr26-esp32-devops-mcp?labelColor=black&color=black&style=flat-square&logo=&logoColor=white)](https://lobehub.com/mcp/josephr26-esp32-devops-mcp)

Transform Claude Code into your personal ESP32 DevOps engineer — 21 tools covering the full development lifecycle from project scaffolding to OTA deployment.

## Features

### Smart Serial Port Management
- Auto-detect ESP32 devices
- Manage favourite ports with custom names
- Intelligent port recommendations
- Port usage history

### Build & Flash Automation
- One-command build, flash, and monitor
- Detailed memory usage analysis
- Build error detection and reporting
- Cross-platform support (Windows, macOS, Linux)

### Performance Benchmarking
- Memory leak detection
- Loop timing analysis
- WiFi signal quality monitoring
- Comprehensive performance reports

### Automated Testing
- Boot verification
- Heartbeat detection
- Memory stability testing
- Pre-deployment validation

### Project Lifecycle (new in v1.1.0)
- Scaffold new PlatformIO projects with starter templates (bare, WiFi, BLE, MQTT)
- Validate project structure and `platformio.ini` configuration
- Search the PlatformIO library registry or list installed libraries
- Run PlatformIO unit tests with structured pass/fail output

### Log Analysis (new in v1.1.0)
- Parse saved serial log files into typed entries (ESP-IDF E/W/I/D/V levels)
- Detect Guru Meditation panics and stack traces automatically
- Track free-heap min/max across a capture

### OTA & Network (new in v1.1.0)
- Package built firmware with MD5 and SHA-256 checksums, ready for OTA
- Discover ESP32 devices on the local network via mDNS (avahi / dns-sd) with ARP fallback

## Installation

### Prerequisites
- Node.js 18+
- Python 3.x
- PlatformIO CLI (`pip install platformio`)
- [FirmwareToolkit](https://github.com/JosephR26/FirmwareToolkit) (required for benchmarking/testing features)

### Install from npm

```bash
npm install -g @midas/esp32-devops-mcp
```

### Install from source

```bash
git clone https://github.com/JosephR26/esp32-devops-mcp.git
cd esp32-devops-mcp

# Install Python dependencies
pip install -r requirements.txt

# Install npm dependencies and build
npm install
npm run build
npm link
```

## Configuration

### Claude Desktop

Add to your Claude Desktop config file:

- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "esp32-devops": {
      "command": "node",
      "args": ["C:\\Users\\YOUR_USERNAME\\Projects\\esp32-devops-mcp\\dist\\index.js"],
      "env": {
        "FIRMWARE_TOOLKIT_PATH": "C:\\Users\\YOUR_USERNAME\\Projects\\FirmwareToolkit"
      }
    }
  }
}
```

**Linux:**
```json
{
  "mcpServers": {
    "esp32-devops": {
      "command": "node",
      "args": ["/home/YOUR_USERNAME/projects/esp32-devops-mcp/dist/index.js"],
      "env": {
        "FIRMWARE_TOOLKIT_PATH": "/home/YOUR_USERNAME/projects/FirmwareToolkit"
      }
    }
  }
}
```

**macOS:**
```json
{
  "mcpServers": {
    "esp32-devops": {
      "command": "node",
      "args": ["/Users/YOUR_USERNAME/Projects/esp32-devops-mcp/dist/index.js"],
      "env": {
        "FIRMWARE_TOOLKIT_PATH": "/Users/YOUR_USERNAME/Projects/FirmwareToolkit"
      }
    }
  }
}
```

For Claude Code (CLI), copy `.mcp.json` from the repo root into your project directory. See [INSTALL.md](INSTALL.md) for full setup details.

### Environment Variables

| Variable | Description |
|---|---|
| `FIRMWARE_TOOLKIT_PATH` | Path to your FirmwareToolkit installation. Required for benchmarking and testing tools. |

## Quick Start

### Example Conversations with Claude

```
"List all available ESP32 ports"
→ Uses esp32_list_ports

"Create a new WiFi project called sensor_node"
→ Uses esp32_create_project (template: wifi)

"Build my ESP32 project"
→ Uses esp32_build

"Flash to COM3"
→ Uses esp32_flash with port COM3

"Run a full build and flash cycle"
→ Uses esp32_full_cycle

"Check for memory leaks"
→ Uses esp32_detect_memory_leaks

"Test my firmware before deployment"
→ Uses esp32_validate_deployment

"Parse the serial log I captured earlier"
→ Uses esp32_parse_logs

"Package the firmware for OTA update"
→ Uses esp32_generate_ota_image

"Find ESP32 devices on my network"
→ Uses esp32_list_network_devices
```

## Skills & Claude Code Integration

[Claude Code skills](https://docs.anthropic.com/en/docs/claude-code/skills) let Claude
auto-activate the right tools based on what you ask. This repo ships six skills in
`.claude/skills/` — copy them to `~/.claude/skills/` (global) or keep them in
`.claude/skills/` (project-only).

### ESP32 DevOps skills

| Skill | Trigger examples | MCP tools used |
|-------|-----------------|----------------|
| `/flash-target-device` | "flash the firmware", "upload to board", "build and flash" | `esp32_build`, `esp32_flash`, `esp32_full_cycle` |
| `/run-firmware-tests` | "test firmware", "benchmark", "check memory leaks", "validate deployment" | `esp32_test_firmware`, `esp32_validate_deployment`, `esp32_benchmark`, `esp32_quick_benchmark`, `esp32_detect_memory_leaks` |
| `/esp32-port-manager` | "which port is my ESP32", "set default port", "list serial ports" | `esp32_list_ports`, `esp32_detect_ports`, `esp32_set_default_port`, `esp32_add_favorite_port` |

### Example invocations

```
/flash-target-device
→ Builds and flashes the current PlatformIO project to the recommended port.

/flash-target-device --port /dev/ttyUSB1
→ Flashes to a specific port.

"Run a full performance benchmark on the current firmware."
→ Auto-activates /run-firmware-tests → calls esp32_benchmark (60 s).

"Quick bench on COM4."
→ Auto-activates /run-firmware-tests → calls esp32_quick_benchmark(port="COM4").
```

### Installing skills

```bash
# Global (all projects)
cp .claude/skills/*.md ~/.claude/skills/

# Project-only (already in place if you cloned this repo)
# .claude/skills/ is already configured
```

> **CLI vs Agent SDK:** The `allowed-tools` frontmatter field enforces tool restrictions
> in Claude Code CLI. When using the [Anthropic Agent SDK](https://docs.anthropic.com/en/docs/agents),
> pass the same list via the `allowedTools` option in `AgentOptions`.

---

## Available Tools

### Serial Port Management

#### `esp32_list_ports`
List all available serial ports with detection status, favorites, and recommendations.

No parameters required.

---

#### `esp32_detect_ports`
Auto-detect ESP32 devices on serial ports.

No parameters required.

---

#### `esp32_get_recommended_port`
Get the recommended serial port based on priority: default > last used > auto-detected.

No parameters required.

---

#### `esp32_set_default_port`
Set the default serial port for future operations.

```json
{
  "port": "COM3"
}
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `port` | string | Yes | Serial port name (e.g. `COM3`, `/dev/ttyUSB0`) |

---

#### `esp32_add_favorite_port`
Add a port to favorites with an optional custom name.

```json
{
  "port": "COM3",
  "name": "Main Dev Board"
}
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `port` | string | Yes | Serial port name |
| `name` | string | No | Custom label for this port |

---

### Build & Flash

#### `esp32_build`
Build ESP32 firmware using PlatformIO with detailed output including memory usage.

```json
{
  "projectPath": "./my-project",
  "environment": "esp32dev"
}
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string | No | Path to PlatformIO project (defaults to current directory) |
| `environment` | string | No | PlatformIO environment name (uses project default if omitted) |

---

#### `esp32_flash`
Flash compiled firmware to an ESP32 device.

```json
{
  "projectPath": "./my-project",
  "port": "COM3"
}
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string | No | Path to PlatformIO project |
| `port` | string | No | Serial port to flash to (uses recommended port if omitted) |

---

#### `esp32_full_cycle`
Complete development cycle: build → flash → monitor in one command.

```json
{
  "projectPath": "./my-project",
  "port": "COM3"
}
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string | No | Path to PlatformIO project |
| `port` | string | No | Serial port (uses recommended port if omitted) |

---

#### `esp32_clean`
Clean build artifacts and cache for a PlatformIO project.

```json
{
  "projectPath": "./my-project"
}
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string | No | Path to PlatformIO project (defaults to current directory) |

---

### Performance & Benchmarking

#### `esp32_benchmark`
Run a comprehensive performance benchmark (memory, loop timing, WiFi signal).

```json
{
  "port": "COM3",
  "duration": 60,
  "baudRate": 115200
}
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `port` | string | No | Serial port (uses recommended port if omitted) |
| `duration` | number | No | Duration in seconds (default: `60`, max: `3600`) |
| `baudRate` | number | No | Baud rate (default: `115200`) |

---

#### `esp32_quick_benchmark`
Quick 30-second performance check.

```json
{
  "port": "COM3"
}
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `port` | string | No | Serial port (uses recommended port if omitted) |

---

#### `esp32_detect_memory_leaks`
Extended memory leak detection test (5-minute default).

```json
{
  "port": "COM3",
  "duration": 300
}
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `port` | string | No | Serial port (uses recommended port if omitted) |
| `duration` | number | No | Test duration in seconds (default: `300`) |

---

### Firmware Testing

#### `esp32_test_firmware`
Run automated firmware tests: boot verification, heartbeat detection, memory stability.

```json
{
  "port": "COM3",
  "baudRate": 115200
}
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `port` | string | No | Serial port (uses recommended port if omitted) |
| `baudRate` | number | No | Baud rate (default: `115200`) |

---

#### `esp32_validate_deployment`
Pre-deployment validation — runs the full test suite and reports deployment readiness.

```json
{
  "port": "COM3"
}
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `port` | string | No | Serial port (uses recommended port if omitted) |

---

### Project Lifecycle

#### `esp32_create_project`
Scaffold a new PlatformIO ESP32 project with a starter template.

```json
{
  "name": "sensor_node",
  "board": "esp32dev",
  "template": "wifi"
}
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Project name (letters, numbers, `_`, `-`) |
| `projectPath` | string | No | Parent directory (defaults to cwd) |
| `board` | string | No | PlatformIO board ID (default: `esp32dev`) |
| `template` | string | No | `bare` \| `wifi` \| `ble` \| `mqtt` (default: `bare`) |

---

#### `esp32_validate_project`
Validate a PlatformIO project structure and report missing files or misconfigurations.

```json
{
  "projectPath": "./sensor_node"
}
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string | No | Path to project (defaults to cwd) |

---

#### `esp32_list_libraries`
Search the PlatformIO library registry or list installed libraries.

```json
{
  "query": "DHT sensor",
  "installed": false
}
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | No | Search term |
| `installed` | boolean | No | List installed libs instead of searching registry (default: `false`) |

---

#### `esp32_run_tests`
Run PlatformIO unit tests and return structured per-suite pass/fail results.

```json
{
  "projectPath": "./sensor_node",
  "environment": "esp32dev",
  "filter": "test_sensor*"
}
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string | No | Path to project (defaults to cwd) |
| `environment` | string | No | PlatformIO environment to test |
| `filter` | string | No | Test name filter pattern (e.g. `test_sensor*`) |

---

### Log Analysis

#### `esp32_parse_logs`
Parse a saved ESP32 serial log file into structured entries with severity classification, panic detection, and heap tracking.

```json
{
  "logPath": "./logs/capture_2026-05-09.txt"
}
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `logPath` | string | Yes | Path to the log file |

Returns each log line classified by level (`ERROR`, `WARN`, `INFO`, `DEBUG`, `VERBOSE`), plus a summary with error/warning/panic counts and heap min/max.

---

### OTA & Network

#### `esp32_generate_ota_image`
Package the built `firmware.bin` for OTA deployment — returns the image path, size, MD5, and SHA-256.

```json
{
  "projectPath": "./sensor_node",
  "environment": "esp32dev",
  "outputPath": "./releases"
}
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `projectPath` | string | No | Path to project (defaults to cwd) |
| `environment` | string | No | PlatformIO environment (auto-detected if omitted) |
| `outputPath` | string | No | Directory to copy the OTA image into |

---

#### `esp32_list_network_devices`
Discover ESP32 devices on the local network via mDNS, with ARP table fallback.

```json
{
  "timeout": 5000
}
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `timeout` | number | No | Discovery timeout in ms (default: `5000`) |

Uses `avahi-browse` on Linux, `dns-sd` on macOS. Falls back to the ARP table on Windows or when mDNS tools are unavailable.

---

## Architecture

```
esp32-devops-mcp/
├── src/
│   ├── index.ts           # MCP server entry point (21 tools)
│   ├── tools/
│   │   ├── serial.ts      # Serial port management
│   │   ├── build.ts       # Build & flash tools
│   │   ├── benchmark.ts   # Performance tools
│   │   ├── test.ts        # Firmware testing tools
│   │   ├── project.ts     # Project lifecycle tools (v1.1.0)
│   │   ├── logs.ts        # Log analysis tools (v1.1.0)
│   │   └── ota.ts         # OTA & network tools (v1.1.0)
│   ├── utils/
│   │   ├── exec.ts        # Command execution
│   │   ├── parser.ts      # Output parsing
│   │   └── validation.ts  # Input validation
│   └── types/
│       └── index.ts       # TypeScript types
└── package.json
```

## Security

- Input validation on all parameters
- No shell injection vulnerabilities
- Safe command execution with sanitization
- Timeout protection for long-running operations

## Troubleshooting

### Python not found
Install Python 3.x and ensure it's in your PATH.

### Serial port not detected
- Check USB connection
- Install drivers (CP210x, CH340)
- Try a different USB port

### Build fails
- Verify PlatformIO is installed: `pio --version`
- Check `platformio.ini` exists in the project directory
- Ensure the correct environment name is used

### Benchmark timeout
- Increase the `duration` parameter
- Check serial connection stability
- Verify the baud rate matches your firmware

### MCP server not loading in Claude Desktop
- Confirm you restarted Claude Desktop after editing the config
- Verify the path in the config points to `dist/index.js`
- Check Claude Desktop logs at `%APPDATA%\Claude\logs\` (Windows) or `~/Library/Logs/Claude/` (macOS)

## Roadmap

- [x] OTA image packaging with checksums (v1.1.0)
- [x] Project scaffolding and validation (v1.1.0)
- [x] Serial log analysis with panic detection (v1.1.0)
- [x] Network device discovery via mDNS (v1.1.0)
- [ ] Multi-device parallel testing
- [ ] CI/CD pipeline integration
- [ ] Custom test scenario definitions

## Contributing

Contributions welcome!

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## License

MIT License — see [LICENSE](LICENSE) for details.

## Author

**JosephR26**
- GitHub: [@JosephR26](https://github.com/JosephR26)

## Acknowledgments

- Built on [Model Context Protocol](https://github.com/anthropics/mcp)
- Powered by [PlatformIO](https://platformio.org/)
- Designed for [Claude Code](https://claude.ai/code)
- Showcased on [LobeHub MCP Marketplace](https://lobehub.com/mcp/josephr26-esp32-devops-mcp)
