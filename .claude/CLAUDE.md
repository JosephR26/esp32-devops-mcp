# esp32-devops-mcp — Project Instructions

## What this repo is

MCP server that exposes 33 ESP32 development tools to Claude via the Model Context Protocol.
It wraps FirmwareToolkit and PlatformIO for build / flash / test / benchmark operations,
and interrogates physical hardware attached to an ESP32 via an on-target agent firmware.

## MCP tools reference (33 tools)

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

### Project lifecycle
- `esp32_create_project(name, projectPath?, board?, template?)` — scaffold a new PlatformIO project
- `esp32_validate_project(projectPath?)` — check project structure and platformio.ini
- `esp32_list_libraries(query?, installed?)` — search registry or list installed libraries
- `esp32_run_tests(projectPath?, environment?, filter?)` — run PlatformIO unit tests

### Log analysis
- `esp32_parse_logs(logPath)` — parse serial log file into structured entries with panic detection

### OTA & network
- `esp32_generate_ota_image(projectPath?, environment?, outputPath?)` — package firmware.bin with MD5/SHA-256
- `esp32_list_network_devices(timeout?)` — discover ESP32s via mDNS (avahi/dns-sd) with ARP fallback

### Hardware interrogation (v1.2.0)
Requires the interrogation agent firmware on the target (`firmware/interrogation-agent/`) and pyserial.
- `esp32_hardware_inventory(port?, projectPath?)` — full ESP32 inventory; UNKNOWN where undetermined
- `esp32_interface_discovery(port?, interfaces?)` — I2C/SPI/UART/GPIO/ADC/DAC/PWM/TOUCH survey (read-only)
- `esp32_i2c_scan(port?, controller?, sda?, scl?, frequencyHz?, startAddress?, endAddress?, repeats?, fingerprint?)` — six-state address scan with safe fingerprinting
- `esp32_spi_discovery(cs, mosi?, miso?, sclk?, mode?, clockHz?, bitOrder?, profiles?, component?)` — named probe profiles only
- `esp32_uart_discovery(rx, tx?, baud?, durationMs?, mode?, component?, scanBauds?)` — passive by default
- `esp32_component_identify(interface?, address?, candidates?, markings?, depth?)` — evidence-weighted identification
- `esp32_component_probe(component?, interface?, depth?, ...)` — core interrogation, BASIC/STANDARD/DEEP/FORENSIC
- `esp32_register_inspect(component, registers?, ...)` — READ-ONLY register decoding
- `esp32_component_capabilities(component, offline?, firmwareCapabilities?, ...)` — capability matrix + gap analysis
- `esp32_component_test(component, tests?, depth?, ...)` — functional tests; passing promotes to VERIFIED
- `esp32_component_benchmark(component, benchmarks?, iterations?, ...)` — measured vs documented maxima
- `esp32_hardware_experiment(objective, targetComponent?, procedure?, repetitions?, ...)` — full experiment lifecycle

## Environment variables
- `FIRMWARE_TOOLKIT_PATH` — path to FirmwareToolkit clone (required for benchmark/test tools).
  Resolved lazily: the server starts without it, and only the toolkit-dependent tools error.

## Key source files
- `src/utils/exec.ts` — command execution, cross-platform path helpers
- `src/tools/build.ts` — build/flash tool handlers
- `src/tools/serial.ts` — serial port tool handlers
- `src/tools/benchmark.ts` — benchmark tool handlers
- `src/tools/test.ts` — test/validate tool handlers
- `src/tools/hardware.ts` — inventory, interface discovery, I2C/SPI/UART discovery
- `src/tools/component.ts` — identify, probe, registers, capabilities, test, benchmark, experiment
- `src/hardware/` — the component-agnostic interrogation engine
- `src/hardware/profiles/` — component profiles (pure data; add a file to support a new part)
- `src/types/hardware.ts` — capability, evidence, profile, experiment and transport types
- `scripts/hw_bridge.py` — pyserial bridge to the on-target agent
- `firmware/interrogation-agent/` — PlatformIO agent firmware

## Development workflow
```bash
npm run build          # compile TypeScript → dist/
npm run build:watch    # watch mode
npm test               # compile src+tests → .test-build/, run node:test (no hardware needed)
node dist/index.js     # smoke-test the server
```

## Hardware interrogation rules
- A datasheet claim is NEVER a verified capability. `documented`, `softwareSupported`,
  `firmwareExposed`, `observed`, `tested` and `verified` are independent flags.
- Confidence is capped at `DOCUMENTED` without a physical observation, however many
  paper sources agree.
- Return UNKNOWN rather than guessing. `ObservedValue<T>.known === false` means unknown.
- Raw hardware responses are never discarded after parsing — including when parsing fails.
- Register inspection is READ-ONLY. There is no write path at any depth.
- FORENSIC depth means deeper observation, not destructive action.
- Adding component support means adding a profile object, never editing a tool handler.

## Skills available
Use `/flash-target-device`, `/run-firmware-tests`, `/esp32-port-manager`, `/hardware-interrogation`.
See `.claude/skills/` for full documentation, and `docs/HARDWARE-INTERROGATION.md`
for the interrogation architecture.

## Coding conventions
- TypeScript strict mode; ES2022 target; Node16 module resolution
- All tool handlers return plain objects (no thrown errors — wrap in `{ success, error }`)
- Cross-platform paths: use `path.join()` / `path.resolve()`, never string-concatenate with `\\`
- Input sanitised via `src/utils/validation.ts` before any shell execution
