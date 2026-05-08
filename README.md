# ESP32 DevOps MCP Server

> **AI-powered ESP32 development automation for Claude Code**

[![Featured on LobeHub](https://lobehub.com/badge/mcp--josephr26-esp32-devops-mcp?labelColor=black&color=black&style=flat-square&logo=&logoColor=white)](https://lobehub.com/mcp/josephr26-esp32-devops-mcp)

Transform Claude Code into your personal ESP32 DevOps engineer with intelligent build automation, serial port management, performance benchmarking, and automated testing.

## Features

### Smart Serial Port Management
- Auto-detect ESP32 devices
- Manage favorite ports with custom names
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

## Architecture

```
esp32-devops-mcp/
├── src/
│   ├── index.ts           # MCP server entry point
│   ├── tools/
│   │   ├── serial.ts      # Serial port management
│   │   ├── build.ts       # Build & flash tools
│   │   ├── benchmark.ts   # Performance tools
│   │   └── test.ts        # Testing tools
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

- [ ] Remote deployment support
- [ ] OTA update management
- [ ] Multi-device testing
- [ ] Custom test scenarios
- [ ] Integration with CI/CD

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
