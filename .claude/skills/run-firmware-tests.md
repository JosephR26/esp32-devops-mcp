---
description: >
  ALWAYS invoke this skill when the user asks to test, benchmark, validate, profile,
  or check for memory leaks on ESP32 firmware. Trigger phrases include: "run tests",
  "test the firmware", "benchmark performance", "quick bench", "check memory leaks",
  "validate deployment", "is the device healthy", "profile the firmware", "how fast
  is the loop", "heap fragmentation", "check RAM usage over time".
  Do NOT skip this skill and call benchmark/test tools directly.
allowed-tools:
  - mcp__esp32-devops__esp32_test_firmware
  - mcp__esp32-devops__esp32_validate_deployment
  - mcp__esp32-devops__esp32_benchmark
  - mcp__esp32-devops__esp32_quick_benchmark
  - mcp__esp32-devops__esp32_detect_memory_leaks
  - mcp__esp32-devops__esp32_get_recommended_port
  - mcp__esp32-devops__esp32_list_ports
  - Read
  - Write
---

# /run-firmware-tests

Run tests, benchmarks, validation, and memory-leak detection on a running ESP32.

## Prerequisites

- ESP32 must be flashed and running (use `/flash-target-device` first if needed).
- `FIRMWARE_TOOLKIT_PATH` must be set for benchmark and memory-leak tools.
- Device must be accessible via serial port (no other process holding the port).

## Step 1 — Resolve port

1. Call `esp32_get_recommended_port`.
2. If no port returned, call `esp32_list_ports` and ask the user to confirm.

## Step 2 — Choose test type

Select based on user intent:

| User says | Run |
|-----------|-----|
| "test" / "is firmware working" / "basic check" | `esp32_test_firmware` |
| "validate" / "ready to deploy" / "deployment check" | `esp32_validate_deployment` |
| "benchmark" / "full performance" / "60 second bench" | `esp32_benchmark` |
| "quick bench" / "quick benchmark" / "fast check" | `esp32_quick_benchmark` |
| "memory leak" / "heap" / "RAM over time" / "leak detection" | `esp32_detect_memory_leaks` |
| "all tests" / "full suite" | run all five in order |

## Step 3A — Firmware test (`esp32_test_firmware`)

Call with `port` (and optional `baudRate`, default 115200).

Reports:
- Boot sequence detected: yes/no
- Heartbeat signal: present/absent
- Free heap at boot
- Any crash/panic in output

## Step 3B — Deployment validation (`esp32_validate_deployment`)

Call with `port`.

Reports:
- Issues (blocking) and warnings (non-blocking)
- Overall readiness: READY / NOT READY
- Recommended next steps

## Step 3C — Benchmark (`esp32_benchmark`)

Call with:
- `port`
- `duration` — from user's request, default 60 s, max 3600 s
- `baudRate` — default 115200

Reports: loop time (avg/min/max), free heap (start/end/min), WiFi RSSI if applicable.

## Step 3D — Quick benchmark (`esp32_quick_benchmark`)

Call with `port`. Runs a 30-second snapshot. Good for CI or iterative dev.

## Step 3E — Memory leak detection (`esp32_detect_memory_leaks`)

Call with:
- `port`
- `duration` — from user, default 300 s (5 min)

Reports:
- Heap trend (stable / slowly declining / rapid decline)
- Estimated leak rate (bytes/s) if detected
- Recommendation: OK / INVESTIGATE / CRITICAL

## Step 4 — Summary output

After each tool call, emit a human-readable summary:

```
Test: esp32_test_firmware
  Boot detected:   YES
  Heartbeat:       YES
  Free heap:       187,432 bytes
  Status:          PASS

Benchmark (60 s):
  Loop avg:        1.2 ms  (min 0.8 ms, max 4.1 ms)
  Free heap start: 187,432 bytes
  Free heap end:   186,900 bytes  (−532 bytes over 60 s)
  WiFi RSSI:       −62 dBm
```

If any test fails, list the specific failure and suggest remediation.

## Notes

- `esp32_benchmark` and `esp32_detect_memory_leaks` require `FIRMWARE_TOOLKIT_PATH`.
  If the env var is missing, tell the user and suggest they set it (see INSTALL.md).
- `allowed-tools` applies to CLI. For Agent SDK, set `allowedTools` in `AgentOptions`.
