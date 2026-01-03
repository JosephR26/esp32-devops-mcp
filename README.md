# ESP32 DevOps MCP Server

> **AI-powered ESP32 development automation for Claude Code**

Transform Claude Code into your personal ESP32 DevOps engineer with intelligent build automation, serial port management, performance benchmarking, and automated testing.

## 🚀 Features

### 🔌 Smart Serial Port Management
- Auto-detect ESP32 devices
- Manage favorite ports with custom names
- Intelligent port recommendations
- Port usage history

### 🛠️ Build & Flash Automation
- One-command build, flash, and monitor
- Detailed memory usage analysis
- Build error detection and reporting
- Cross-platform support (Windows, macOS, Linux)

### 📊 Performance Benchmarking
- Memory leak detection
- Loop timing analysis
- WiFi signal quality monitoring
- Comprehensive performance reports

### ✅ Automated Testing
- Boot verification
- Heartbeat detection
- Memory stability testing
- Pre-deployment validation

## 📦 Installation

### Prerequisites
- Node.js 18+
- Python 3.x
- PlatformIO CLI
- [FirmwareToolkit](https://github.com/JosephR26/FirmwareToolkit) (included scripts)

### Install from npm

```bash
npm install -g @midas/esp32-devops-mcp
```

### Install from source

```bash
git clone https://github.com/JosephR26/esp32-devops-mcp.git
cd esp32-devops-mcp
npm install
npm run build
npm link
```

## ⚙️ Configuration

### Claude Desktop Configuration

Add to your Claude Desktop config file:

**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "esp32-devops": {
      "command": "node",
      "args": [
        "C:\\Users\\YOUR_USERNAME\\AppData\\Roaming\\npm\\node_modules\\@midas\\esp32-devops-mcp\\dist\\index.js"
      ],
      "env": {
        "FIRMWARE_TOOLKIT_PATH": "C:\\Users\\YOUR_USERNAME\\Documents\\FirmwareToolkit"
      }
    }
  }
}
```

### Environment Variables

- `FIRMWARE_TOOLKIT_PATH`: Path to FirmwareToolkit installation (default: `C:\Users\josep\Documents\FirmwareToolkit`)

## 🎯 Quick Start

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

## 🔧 Available Tools

### Serial Port Management

#### `esp32_list_ports`
List all available ESP32 serial ports with detection status, favorites, and recommendations.

```typescript
// No parameters required
```

#### `esp32_detect_ports`
Auto-detect ESP32 devices on serial ports.

#### `esp32_set_default_port`
Set default serial port for future operations.

```typescript
{
  port: "COM3" // or /dev/ttyUSB0 on Linux
}
```

#### `esp32_add_favorite_port`
Add a port to favorites with optional custom name.

```typescript
{
  port: "COM3",
  name: "Main Dev Board" // optional
}
```

### Build & Flash

#### `esp32_build`
Build ESP32 firmware with detailed output.

```typescript
{
  projectPath: "./my-project", // optional
  environment: "esp32dev"      // optional
}
```

#### `esp32_flash`
Flash firmware to ESP32 device.

```typescript
{
  projectPath: "./my-project", // optional
  port: "COM3"                 // optional
}
```

#### `esp32_full_cycle`
Complete cycle: build → flash → monitor.

```typescript
{
  projectPath: "./my-project", // optional
  port: "COM3"                 // optional
}
```

### Performance & Benchmarking

#### `esp32_benchmark`
Run comprehensive performance benchmark.

```typescript
{
  port: "COM3",     // optional
  duration: 60,     // seconds, optional
  baudRate: 115200  // optional
}
```

#### `esp32_quick_benchmark`
Quick 30-second performance check.

#### `esp32_detect_memory_leaks`
Extended memory leak detection test.

```typescript
{
  port: "COM3",   // optional
  duration: 300   // seconds, optional
}
```

### Firmware Testing

#### `esp32_test_firmware`
Run automated firmware tests.

```typescript
{
  port: "COM3",     // optional
  baudRate: 115200  // optional
}
```

#### `esp32_validate_deployment`
Pre-deployment validation with full test suite.

```typescript
{
  port: "COM3" // optional
}
```

## 🏗️ Architecture

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
├── python/                # Symlinks to toolkit scripts
├── scripts/               # Batch/shell scripts
└── package.json
```

## 🛡️ Security

- Input validation on all parameters
- No shell injection vulnerabilities
- Safe command execution with sanitization
- Timeout protection for long-running operations

## 🤝 Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## 📝 License

MIT License - see [LICENSE](LICENSE) file for details.

## 👨‍💻 Author

**JosephR26**
- Email: josephreilly19@outlook.com
- GitHub: [@JosephR26](https://github.com/JosephR26)

## 🙏 Acknowledgments

- Built on [Model Context Protocol](https://github.com/anthropics/mcp)
- Powered by [PlatformIO](https://platformio.org/)
- Designed for [Claude Code](https://claude.ai/code)

## 📊 Performance

Expected performance improvements:
- **Build time**: Same as manual
- **Workflow efficiency**: 10-20x faster (automated chaining)
- **Error detection**: Instant feedback
- **Testing**: Automated vs. manual inspection

## 🐛 Troubleshooting

### Python not found
Install Python 3.x and ensure it's in your PATH.

### Serial port not detected
- Check USB connection
- Install drivers (CP210x, CH340)
- Try a different USB port

### Build fails
- Verify PlatformIO is installed: `pio --version`
- Check `platformio.ini` exists in project
- Ensure correct environment name

### Benchmark timeout
- Increase duration parameter
- Check serial connection stability
- Verify baud rate matches firmware

## 📈 Roadmap

- [ ] Remote deployment support
- [ ] OTA update management
- [ ] Multi-device testing
- [ ] Custom test scenarios
- [ ] Integration with CI/CD

## 💰 Support

Love this tool? Consider:
- ⭐ Starring the repository
- 🐛 Reporting bugs
- 💡 Suggesting features
- 📢 Sharing with others

---

**Built with ❤️ for the ESP32 community**
