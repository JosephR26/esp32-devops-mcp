# ESP32 DevOps MCP Server — Installation Guide

**Cross-platform setup in 5 minutes (Windows · Linux · macOS)**

---

## Prerequisites

Before installing, make sure you have:

1. **Node.js 18+**
   ```
   node --version
   ```
   Download: https://nodejs.org

2. **Python 3.x**
   ```
   python3 --version   # Linux/macOS
   python --version    # Windows
   ```
   Download: https://python.org

3. **PlatformIO CLI** (required for build/flash)
   ```
   pip install platformio
   pio --version
   ```

4. **Claude Desktop or Claude Code**
   - Claude Desktop: https://claude.ai/download
   - Claude Code CLI: `npm install -g @anthropic-ai/claude-code`

---

## Installation Steps

### Step 1: Clone and enter the repo

```bash
# Replace <your-path> with wherever you keep projects
git clone https://github.com/JosephR26/esp32-devops-mcp.git <your-path>/esp32-devops-mcp
cd <your-path>/esp32-devops-mcp
```

### Step 2: Install Python dependencies

```bash
pip install -r requirements.txt
# Verify:
python3 -c "import serial; print('pyserial', serial.VERSION)"
```

### Step 3: Install npm dependencies and build

```bash
npm install
npm run build
# Verify: dist/index.js should exist
```

---

## Configure Claude Desktop

The config file location depends on your OS:

| Platform | Config file path |
|----------|-----------------|
| Windows  | `%APPDATA%\Claude\claude_desktop_config.json` |
| macOS    | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Linux    | `~/.config/claude/claude_desktop_config.json` |

### Windows example

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

### Linux example

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

### macOS example

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

> **Note:** `FIRMWARE_TOOLKIT_PATH` is only required for benchmarking and testing tools.
> Build and flash tools (esp32_build, esp32_flash, esp32_full_cycle) work without it.

### Global npm install (alternative)

If you install via npm globally, use the package binary instead:

```json
{
  "mcpServers": {
    "esp32-devops": {
      "command": "esp32-devops-mcp",
      "env": {
        "FIRMWARE_TOOLKIT_PATH": "/path/to/FirmwareToolkit"
      }
    }
  }
}
```

---

## Configure Claude Code (CLI)

For Claude Code, create or edit `.mcp.json` in your project root (see `.mcp.json` in this repo for a ready-to-use template).

Set the environment variable in your shell profile for convenience:

```bash
# Linux/macOS — add to ~/.bashrc or ~/.zshrc
export FIRMWARE_TOOLKIT_PATH="$HOME/projects/FirmwareToolkit"

# Windows PowerShell — add to $PROFILE
$env:FIRMWARE_TOOLKIT_PATH = "C:\Users\$env:USERNAME\Projects\FirmwareToolkit"

# Windows — persistent (Command Prompt / system env)
setx FIRMWARE_TOOLKIT_PATH "C:\Users\YOUR_USERNAME\Projects\FirmwareToolkit"
```

---

## Verify Installation

### Test 1: Check MCP tools are loaded

In Claude Desktop or Claude Code, ask:
```
"What MCP tools do you have available?"
```
You should see the ESP32 DevOps tools listed.

### Test 2: List serial ports

```
"List all available ESP32 serial ports"
```

Expected: Claude calls `esp32_list_ports` and returns port list.

### Test 3: Full workflow (if you have an ESP32 project)

```
"Build my ESP32 project at /path/to/my/project"
```

---

## Troubleshooting

### "Python not found"

```bash
python3 --version   # try python3
python --version    # try python
py --version        # Windows launcher
```

Use whichever works: `python3 -m pip install -r requirements.txt`

### "PlatformIO not found"

```bash
pip install platformio
pio --version
```

### "FIRMWARE_TOOLKIT_PATH not set"

Only needed for benchmarking/testing tools. Either:
- Set the env var (see above)
- Or skip it if you only need build/flash/port tools

### "MCP server not loading in Claude"

Checklist:
- Did you restart Claude Desktop after editing config?
- Does `dist/index.js` exist? (run `npm run build` if not)
- Is the JSON in your config file valid? (no trailing commas)
- Check logs: `%APPDATA%\Claude\logs\` (Windows) or `~/Library/Logs/Claude/` (macOS)

### "Serial port access denied"

- Close other serial monitors (Arduino IDE, VS Code Serial Monitor, PuTTY)
- Unplug and replug ESP32
- Linux: add yourself to `dialout` group: `sudo usermod -aG dialout $USER` (re-login required)

---

## Installation Checklist

- [ ] Node.js 18+ installed
- [ ] Python 3.x installed
- [ ] PlatformIO installed (`pio --version`)
- [ ] Python deps installed (`pip install -r requirements.txt`)
- [ ] npm deps installed (`npm install`)
- [ ] Server built (`dist/index.js` exists)
- [ ] `FIRMWARE_TOOLKIT_PATH` set (if using benchmark/test tools)
- [ ] Claude config updated with correct paths
- [ ] Claude restarted
- [ ] Test command works

---

## Support

- GitHub Issues: https://github.com/JosephR26/esp32-devops-mcp/issues
- Email: josephreilly19@outlook.com
