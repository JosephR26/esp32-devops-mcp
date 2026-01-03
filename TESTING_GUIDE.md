# ESP32 DevOps MCP Server - Testing Guide

**Goal:** Validate the product works before selling it

**Time needed:** 30-60 minutes

---

## 🔧 STEP 1: Install & Configure (10 min)

### A) Verify Build is Complete

Check that compiled files exist:
```bash
dir C:\Users\josep\Documents\esp32-devops-mcp\dist
```

Should see:
- index.js
- tools/ folder
- types/ folder
- utils/ folder

✅ **Status:** Already built!

---

### B) Add to Claude Desktop Config

**Location:** `%APPDATA%\Claude\claude_desktop_config.json`

**Full path:** `C:\Users\josep\AppData\Roaming\Claude\claude_desktop_config.json`

**Actions:**
1. Open that file in notepad
2. If it's empty or missing, copy the entire contents from:
   `C:\Users\josep\Documents\esp32-devops-mcp\CLAUDE_DESKTOP_CONFIG.json`
3. If it already has content, ADD the esp32-devops entry to the mcpServers section
4. Save the file

**Expected result:**
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

---

### C) Restart Claude Desktop

**Important:** You MUST restart Claude Desktop for the MCP server to load.

1. Close Claude Desktop completely (check system tray)
2. Reopen Claude Desktop
3. Wait 10 seconds for MCP server to connect

**How to verify it loaded:**
- Open a new conversation
- Look for indicators that tools are available
- Try asking: "What MCP tools do you have available?"

---

## 🧪 STEP 2: Test Each Tool Category (20 min)

### Test 1: Serial Port Management

**Test command:**
```
"List all available ESP32 serial ports"
```

**Expected behavior:**
- Claude calls esp32_list_ports tool
- Returns list of COM ports
- Shows which are ESP32 devices
- Shows recommended port

**Success criteria:**
✅ Tool executes without errors
✅ Returns structured port information
✅ ESP32 devices identified correctly (if connected)

**Possible issues:**
- ❌ "Python not found" → Install Python 3.x
- ❌ "Script not found" → Check FIRMWARE_TOOLKIT_PATH
- ❌ No ports detected → Plug in ESP32

---

### Test 2: Build Automation

**Prerequisites:**
- Have a PlatformIO project ready
- Or use a test project

**Test command:**
```
"Build my ESP32 project at [path to project]"
```

**Expected behavior:**
- Claude calls esp32_build tool
- Executes PlatformIO build
- Returns memory usage statistics
- Reports success/failure

**Success criteria:**
✅ Build executes
✅ Memory usage reported
✅ Errors captured if build fails

**Possible issues:**
- ❌ "PlatformIO not found" → Install PlatformIO CLI
- ❌ "Project not found" → Check path
- ❌ Build errors → Normal, tool should report them

---

### Test 3: Quick Port Detection

**Test command:**
```
"Detect ESP32 ports"
```

**Expected behavior:**
- Claude calls esp32_detect_ports
- Returns only ESP32-compatible ports
- Shows port descriptions

**Success criteria:**
✅ Only ESP32 ports returned
✅ Descriptions include chip type (CP210x, CH340, etc.)

---

### Test 4: Set Default Port

**Test command:**
```
"Set COM3 as my default ESP32 port"
```
(Replace COM3 with your actual port)

**Expected behavior:**
- Claude calls esp32_set_default_port
- Saves preference
- Confirms success

**Success criteria:**
✅ Port saved successfully
✅ Future commands use this port by default

---

### Test 5: Error Handling

**Test command:**
```
"Build my ESP32 project at C:\nonexistent\path"
```

**Expected behavior:**
- Claude calls esp32_build
- Returns error message
- Doesn't crash

**Success criteria:**
✅ Graceful error message
✅ Tool doesn't crash
✅ Clear explanation of what went wrong

---

## 📊 STEP 3: Document Test Results (10 min)

### Create Test Report

**What worked:**
- [ ] Serial port listing
- [ ] ESP32 detection
- [ ] Build automation
- [ ] Default port setting
- [ ] Error handling

**What needs fixing:**
- [ ] Issue 1: _______________
- [ ] Issue 2: _______________
- [ ] Issue 3: _______________

**Performance:**
- Tool response time: _____ seconds
- Build time: _____ seconds
- Overall experience: _____ / 10

---

## 📸 STEP 4: Create Demo Content (10 min)

### A) Screenshots for Marketing

**Take screenshots of:**
1. Claude listing available ports
2. Build command execution with memory stats
3. Successful deployment validation
4. Error handling example

**Save to:**
`C:\Users\josep\Documents\esp32-devops-mcp\demo-screenshots\`

---

### B) Record GIF/Video

**Suggested demos:**
1. "Build and flash" full workflow (30 seconds)
2. Port detection demo (10 seconds)
3. Memory leak detection (60 seconds)

**Tools:**
- ScreenToGif (free, lightweight)
- OBS Studio (free, full-featured)
- Windows Game Bar (Win+G, built-in)

**Save to:**
`C:\Users\josep\Documents\esp32-devops-mcp\demo-videos\`

---

## 🐛 STEP 5: Fix Any Issues Found (Variable)

### Common Issues & Fixes

**Issue: Python not found**
```bash
# Check Python installation
python --version
# or
py --version

# If not installed, install Python 3.x from python.org
```

**Issue: PlatformIO not found**
```bash
# Check PlatformIO installation
pio --version

# If not installed:
pip install platformio
```

**Issue: Serial port access denied**
```
# Close any serial monitors (Arduino IDE, PuTTY, etc.)
# Unplug and replug ESP32
# Try different USB port
```

**Issue: Build fails with path errors**
```
# Check that project path has no spaces
# Or wrap path in quotes
# Verify platformio.ini exists in project
```

**Issue: Tool times out**
```
# Increase timeout in source code if needed
# Or simplify test (smaller project)
```

---

## ✅ STEP 6: Pre-Launch Checklist

Before publishing to Gumroad, verify:

**Functionality:**
- [ ] At least 3 tools tested and working
- [ ] Error handling tested and graceful
- [ ] Documentation accurate (no wrong paths/commands)
- [ ] Installation instructions work from scratch

**Content:**
- [ ] Screenshots captured for Gumroad page
- [ ] Demo GIF/video recorded
- [ ] README updated with accurate info
- [ ] Known issues documented (if any)

**Business:**
- [ ] Pricing decided ($29 launch)
- [ ] Refund policy clear (14 days)
- [ ] Support email set up (josephreilly19@outlook.com)
- [ ] You're confident selling this product

---

## 🎯 Testing Scenarios (Advanced)

### Full Workflow Test

**Command:**
```
"I have an ESP32 project at C:\Projects\MyESP32App.
Please build it, flash it to my device, and check for memory leaks."
```

**Expected:**
1. Detects port automatically
2. Builds project with memory stats
3. Flashes to detected device
4. Runs memory leak test
5. Reports complete analysis

**This is the ULTIMATE test** - if this works, the product is solid.

---

## 📝 Test Results Template

```
=================================
ESP32 DevOps MCP - Test Results
=================================

Date: _______________
Tester: Joseph
Version: 1.0.0

SERIAL PORT TOOLS:
[ ] esp32_list_ports - PASS / FAIL / NOT TESTED
[ ] esp32_detect_ports - PASS / FAIL / NOT TESTED
[ ] esp32_set_default_port - PASS / FAIL / NOT TESTED

BUILD TOOLS:
[ ] esp32_build - PASS / FAIL / NOT TESTED
[ ] esp32_flash - PASS / FAIL / NOT TESTED
[ ] esp32_clean - PASS / FAIL / NOT TESTED

BENCHMARK TOOLS:
[ ] esp32_benchmark - PASS / FAIL / NOT TESTED
[ ] esp32_quick_benchmark - PASS / FAIL / NOT TESTED
[ ] esp32_detect_memory_leaks - PASS / FAIL / NOT TESTED

TEST TOOLS:
[ ] esp32_test_firmware - PASS / FAIL / NOT TESTED
[ ] esp32_validate_deployment - PASS / FAIL / NOT TESTED

OVERALL RATING: ____ / 10

ISSUES FOUND:
1. _______________
2. _______________
3. _______________

READY TO LAUNCH: YES / NO

CONFIDENCE LEVEL: ____ / 10
```

---

## 🚀 After Testing

**If all tests PASS:**
✅ Launch with confidence
✅ Use test screenshots in marketing
✅ Mention testing in product description
✅ Offer refunds if issues found

**If some tests FAIL:**
⚠️ Fix critical issues first
⚠️ Document known limitations
⚠️ Launch with disclaimer: "v1.0 - Early Access"
⚠️ Offer discounted price ($19 instead of $29)

**If most tests FAIL:**
🛑 Don't launch yet
🛑 Fix issues first
🛑 Re-test
🛑 Launch when confident

---

## 💡 Testing Tips

1. **Test with REAL ESP32 device** (not just simulation)
2. **Test on clean project** (not just your main project)
3. **Test error cases** (wrong paths, missing files)
4. **Time each operation** (include in marketing: "30-second builds")
5. **Take notes** (feedback for v1.1)

---

**Good luck with testing! This is the professional way to launch.** ✅

Once testing is done, you'll have:
- Validated product
- Demo content
- Confidence to sell
- Better documentation

**Then we launch with ZERO doubts.** 🚀
