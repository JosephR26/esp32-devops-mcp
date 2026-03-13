# esp32-devops-mcp — Project Instructions

## What this repo is

MCP server that exposes 14 ESP32 development tools to Claude via the Model Context Protocol.
It wraps FirmwareToolkit and PlatformIO for build / flash / test / benchmark operations.

## MCP tools reference (14 tools)

### Serial port management
- `esp32_list_ports` — list all ports with detection status and favorites
- `esp32_detect_ports` — auto-detect ESP32 ports
- `esp32_get_recommended_port` — return the best port (default > last-used > auto-detected)
- `esp32_set_default_port(port)` — persist a default port
- `esp32_add_favorite_port(port, name?)` — label a port as a favorite

### Build & flash
- `esp32_build(projectPath?, environment?)` — PlatformIO build; returns size + memory
- `esp32_flash(projectPath?, port?)` — flash firmware over serial
- `esp32_full_cycle(projectPath?, port?)` — build then flash in one call
- `esp32_clean(projectPath?)` — remove build artefacts

### Benchmarking
- `esp32_benchmark(port?, duration?, baudRate?)` — full performance run (default 60 s)
- `esp32_quick_benchmark(port?)` — 30-second snapshot
- `esp32_detect_memory_leaks(port?, duration?)` — leak detection (default 300 s)

### Firmware testing
- `esp32_test_firmware(port?, baudRate?)` — boot / heartbeat / memory tests
- `esp32_validate_deployment(port?)` — readiness assessment with issues/warnings

## Environment variables
- `FIRMWARE_TOOLKIT_PATH` — path to FirmwareToolkit clone (required for benchmark/test tools)

## Key source files
- `src/utils/exec.ts` — command execution, cross-platform path helpers
- `src/tools/build.ts` — build/flash tool handlers
- `src/tools/serial.ts` — serial port tool handlers
- `src/tools/benchmark.ts` — benchmark tool handlers
- `src/tools/test.ts` — test/validate tool handlers

## Development workflow
```bash
npm run build          # compile TypeScript → dist/
npm run build:watch    # watch mode
node dist/index.js     # smoke-test the server
```

## Skills available
Use `/flash-target-device`, `/run-firmware-tests`, `/esp32-port-manager`,
`/rf-capture-analyzer`, `/detect-surveillance-device`, `/generate-detection-rule`.
See `.claude/skills/` for full documentation.

## Coding conventions
- TypeScript strict mode; ES2022 target; Node16 module resolution
- All tool handlers return plain objects (no thrown errors — wrap in `{ success, error }`)
- Cross-platform paths: use `path.join()` / `path.resolve()`, never string-concatenate with `\\`
- Input sanitised via `src/utils/validation.ts` before any shell execution
