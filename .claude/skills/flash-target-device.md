---
description: >
  ALWAYS invoke this skill when the user mentions flashing, programming, uploading,
  burning, or writing firmware to an ESP32 (or any ESP target). This includes phrases
  like "flash the device", "upload firmware", "program my board", "write the binary",
  "ota update", or "push to the chip".
  Do NOT run esptool, idf.py, or pio run --target upload directly — always route
  through this skill so port selection, error handling, and reporting are consistent.
allowed-tools:
  - mcp__esp32-devops__esp32_build
  - mcp__esp32-devops__esp32_flash
  - mcp__esp32-devops__esp32_full_cycle
  - mcp__esp32-devops__esp32_list_ports
  - mcp__esp32-devops__esp32_get_recommended_port
  - mcp__esp32-devops__esp32_set_default_port
  - Read
  - Write
disable-model-invocation: true
---

# /flash-target-device

Flash firmware to an ESP32 target using the esp32-devops MCP tools.

## Decision flow

```
User request
    │
    ├─ firmware path provided AND no explicit "build first"?
    │       └─ go to FLASH ONLY
    │
    ├─ "build and flash" / "full cycle" / no pre-built binary mentioned?
    │       └─ go to FULL CYCLE
    │
    └─ "just build" / "compile" (no flash)?
            └─ go to BUILD ONLY
```

## Step 1 — Resolve port

1. Call `esp32_get_recommended_port`.
2. If it returns a valid port, use it. Note the port to the user.
3. If it returns no port or an error:
   - Call `esp32_list_ports` and show the user the list.
   - Ask the user to confirm which port to use.
   - Once confirmed, call `esp32_set_default_port(port)` to persist it.

## Step 2A — Full cycle (build + flash)

Call `esp32_full_cycle` with:
- `projectPath` — the path the user specified, or `process.cwd()` if omitted
- `port` — resolved in Step 1
- `environment` — the PlatformIO env name if the user specified one

On success: report firmware size, upload time, and port used.
On failure: show the full error output and suggest:
  - Check that PlatformIO is installed (`pio --version`)
  - Check the port is not held by another process
  - Check the platformio.ini environment name is correct

## Step 2B — Flash only (pre-built binary)

Call `esp32_flash` with:
- `projectPath` — project root (PlatformIO locates the binary inside `.pio/build/`)
- `port` — resolved in Step 1

## Step 2C — Build only (no flash)

Call `esp32_build` with:
- `projectPath` — path provided by user or cwd
- `environment` — PlatformIO env if specified

Report: firmware size in KB, RAM/Flash usage percentages, any warnings/errors.

## Step 3 — Summary output

Always finish with a one-line status:

```
✓ Flash complete — firmware.bin (NNN KB) → <PORT> in N.Ns
```
or
```
✗ Flash failed — <short reason>. Full output above.
```

## Notes

- `esp32_full_cycle` is preferred over separate build + flash calls: it is atomic and
  reports both stages together.
- If the user passes a raw `.bin` path (not a PlatformIO project), explain that
  `esp32_flash` expects a PlatformIO project root, not a binary path directly.
  esptool usage is outside the scope of this skill.
- `allowed-tools` restriction applies to CLI use. When calling from the Agent SDK,
  enforce the same tool list via `allowedTools` in the `AgentOptions`.
