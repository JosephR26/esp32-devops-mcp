# ESP32 DevOps MCP Server v1.0.0 🚀

**Initial Release - AI-Powered ESP32 Development Automation**

Transform Claude Code into your personal ESP32 DevOps engineer with 14 powerful tools for natural language hardware development.

## 🎯 What's Included

### Serial Port Management (5 tools)
- ✅ Auto-detect ESP32 devices
- ✅ Smart port recommendations
- ✅ Favorite ports with custom names
- ✅ Usage history tracking
- ✅ Default port configuration

### Build & Flash Automation (4 tools)
- ✅ One-command build pipeline
- ✅ Intelligent flashing with memory analysis
- ✅ Full development cycle (build → flash → monitor)
- ✅ Build artifact cleanup

### Performance Benchmarking (3 tools)
- ✅ Comprehensive performance analysis
- ✅ Memory leak detection
- ✅ Quick 30-second health checks

### Firmware Testing (2 tools)
- ✅ Automated test suites (boot, heartbeat, memory)
- ✅ Pre-deployment validation

## 💡 Example Usage

Simply talk to Claude Code:

```
"Build my ESP32 project and flash it"
"Check for memory leaks"
"Is this firmware ready for production?"
"What serial ports do I have available?"
```

Claude executes the appropriate tools automatically!

## 📦 Installation

### Quick Start (npm)
```bash
npm install -g @midas/esp32-devops-mcp
```

### Manual Install
```bash
git clone https://github.com/JosephR26/esp32-devops-mcp.git
cd esp32-devops-mcp
npm install
npm run build
npm link
```

### Configure Claude Desktop

Add to `claude_desktop_config.json`:

**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "esp32-devops": {
      "command": "node",
      "args": ["C:\\Users\\USERNAME\\AppData\\Roaming\\npm\\node_modules\\@midas\\esp32-devops-mcp\\dist\\index.js"],
      "env": {
        "FIRMWARE_TOOLKIT_PATH": "C:\\Path\\To\\FirmwareToolkit"
      }
    }
  }
}
```

Restart Claude Desktop and you're ready!

## 🔧 Requirements

- Node.js 18+
- Python 3.x
- PlatformIO CLI
- Claude Code or Claude Desktop
- [FirmwareToolkit](https://github.com/JosephR26/FirmwareToolkit) (for full functionality)

## 📊 What's Next

- 🔨 Hardware Documentation Generator MCP (coming soon)
- 🔨 OTA Update Manager MCP (coming soon)
- 🔨 Power Optimization MCP (coming soon)
- 🏢 Enterprise custom MCP development

## 💬 Support

- 📖 Full documentation: [README.md](https://github.com/JosephR26/esp32-devops-mcp)
- 🐛 Report issues: [GitHub Issues](https://github.com/JosephR26/esp32-devops-mcp/issues)
- 💡 Feature requests: [Discussions](https://github.com/JosephR26/esp32-devops-mcp/discussions)

## 📄 License

MIT License - Free to use for personal and commercial projects

---

**Built with ❤️ for the ESP32 community**

Star ⭐ this repo if you find it useful!
