# ESP32 DevOps MCP Server - Installation Guide

**Complete setup in 5 minutes**

---

## ✅ Prerequisites

Before installing, make sure you have:

1. **Node.js 18+**
   - Check: `node --version`
   - Download: https://nodejs.org

2. **Python 3.x**
   - Check: `python --version` or `py --version`
   - Download: https://python.org

3. **PlatformIO CLI** (for build/flash functionality)
   - Check: `pio --version`
   - Install: `pip install platformio`

4. **Claude Desktop or Claude Code**
   - Claude Desktop (free): https://claude.ai/download
   - Claude Code (CLI): Requires Claude Pro

---

## 📦 Installation Steps

### Step 1: Install Python Dependencies

```bash
cd C:\Users\josep\Documents\esp32-devops-mcp
pip install -r requirements.txt
```

**This installs:**
- pyserial (for serial port management)

**Verify installation:**
```bash
python -c "import serial; print('pyserial installed:', serial.VERSION)"
```

---

### Step 2: Install npm Dependencies

```bash
npm install
```

**This installs:**
- @modelcontextprotocol/sdk
- TypeScript compiler
- Type definitions

---

### Step 3: Build the MCP Server

```bash
npm run build
```

**Verify build:**
```bash
dir dist
```

Should see: `index.js`, `tools/`, `utils/`, `types/`

---

### Step 4: Configure Claude Desktop

**Location:** `%APPDATA%\Claude\claude_desktop_config.json`

**Windows Path:** `C:\Users\[USERNAME]\AppData\Roaming\Claude\claude_desktop_config.json`

**Add this configuration:**

```json
{
  "mcpServers": {
    "esp32-devops": {
      "command": "node",
      "args": [
        "C:\\Users\\josep\\Documents\\esp32-devops-mcp\\dist\\index.js"
      ],
      "env": {
        "FIRMWARE_TOOLKIT_PATH": "C:\\Users\\josep\\Documents\\FirmwareToolkit"
      }
    }
  }
}
```

**Important:**
- Replace `josep` with your Windows username
- Update `FIRMWARE_TOOLKIT_PATH` if your FirmwareToolkit is elsewhere
- Use double backslashes `\\` in paths

---

### Step 5: Restart Claude Desktop

1. Close Claude Desktop completely (check system tray)
2. Reopen Claude Desktop
3. Wait 10 seconds for MCP server to connect

---

## ✅ Verify Installation

### Test 1: Check MCP Server is Loaded

Open Claude Desktop and ask:
```
"What MCP tools do you have available?"
```

You should see ESP32 DevOps tools listed.

---

### Test 2: Run a Simple Command

```
"List all available ESP32 serial ports"
```

**Expected:**
- Claude calls `esp32_list_ports`
- Returns list of serial ports
- Success!

---

### Test 3: Full Workflow (if you have ESP32 project)

```
"Build my ESP32 project at [path]"
```

**Expected:**
- Builds firmware
- Shows memory usage
- Reports success/errors

---

## 🐛 Troubleshooting

### Issue: "Python not found"

**Solution:**
```bash
# Check which Python command works:
python --version
python3 --version
py --version

# Use the one that works:
python -m pip install -r requirements.txt
```

---

### Issue: "pyserial not found"

**Solution:**
```bash
pip install pyserial
# or
python -m pip install pyserial
```

---

### Issue: "PlatformIO not found"

**Solution:**
```bash
pip install platformio
pio --version
```

---

### Issue: "MCP server not loading in Claude"

**Checklist:**
- [ ] Did you restart Claude Desktop?
- [ ] Is the path in config correct?
- [ ] Did the build succeed? (check `dist/index.js` exists)
- [ ] Are there any syntax errors in claude_desktop_config.json?

**Debug:**
1. Open Claude Desktop
2. Look for error messages in logs
3. Check: `%APPDATA%\Claude\logs\`

---

### Issue: "Command times out"

**Solution:**
- Increase timeout in tool (default: 120s for builds)
- Check network/disk speed
- Try simpler project first

---

### Issue: "Serial port access denied"

**Solution:**
- Close other serial monitors (Arduino IDE, PuTTY)
- Unplug and replug ESP32
- Try different USB port
- Check drivers (CP210x, CH340)

---

## 📚 Next Steps

After installation:

1. **Read the documentation:**
   - README.md - Feature overview
   - TESTING_GUIDE.md - How to test all features

2. **Try example commands:**
   - "List ESP32 ports"
   - "Build my project"
   - "Check for memory leaks"

3. **Join the community:**
   - GitHub Issues: Report bugs
   - GitHub Discussions: Ask questions
   - Email: josephreilly19@outlook.com

---

## 🆘 Getting Help

**If installation fails:**

1. Check the troubleshooting section above
2. Open a GitHub issue with:
   - Your OS version
   - Error message (full text)
   - What you tried
   - Screenshots if helpful

3. Email: josephreilly19@outlook.com
   - Response within 24 hours
   - We'll help you get it working

---

## ✅ Installation Checklist

Use this to verify everything is set up:

- [ ] Node.js installed (`node --version`)
- [ ] Python installed (`python --version`)
- [ ] PlatformIO installed (`pio --version`)
- [ ] Python dependencies installed (`pip list | findstr pyserial`)
- [ ] npm dependencies installed (`dir node_modules`)
- [ ] MCP server built (`dir dist\index.js`)
- [ ] Claude config updated
- [ ] Claude Desktop restarted
- [ ] MCP server appears in Claude tools
- [ ] Test command works

**All checked?** You're ready to automate! 🚀

---

## 🎯 Quick Install (One Command)

**Windows PowerShell:**
```powershell
cd C:\Users\josep\Documents\esp32-devops-mcp
pip install -r requirements.txt && npm install && npm run build
echo "Installation complete! Now configure Claude Desktop and restart."
```

---

**Installation time:** 5-10 minutes
**Difficulty:** Easy (if you follow the steps)
**Support:** Available via email/GitHub

**Welcome to automated ESP32 development!** 🎉
