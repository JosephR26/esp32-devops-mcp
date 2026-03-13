---
description: >
  ALWAYS invoke this skill when the user asks to generate detection logic, a detection
  function, a firmware rule, or a Suricata/Sigma rule for a specific threat or signal.
  Trigger phrases include: "generate detection rule", "write detection code", "create
  firmware detection", "write a Suricata rule", "write a Sigma rule", "detect WiFi
  deauth", "detect deauthentication flood", "detect 433MHz carrier", "detect jamming",
  "write C code to detect", "add detection for", "make my firmware detect",
  "create an alert for", "how do I detect [threat] in firmware".
  Do NOT generate offensive or attack code — detection and alerting only.
allowed-tools:
  - mcp__esp32-devops__esp32_build
  - mcp__esp32-devops__esp32_get_recommended_port
  - mcp__esp32-devops__esp32_list_ports
  - Read
  - Write
  - Bash
---

# /generate-detection-rule

Generate detection logic for a threat — ESP32 firmware C code and optional Suricata/Sigma rules.

## Legal notice

This skill generates **detection and alerting** code only. It does not generate:
- Jamming or interference capabilities
- Replay or injection attacks
- DoS or deauthentication attack code

Such capabilities are illegal under the Wireless Telegraphy Act 2006, Computer Misuse
Act 1990, and related UK legislation. All generated code is for defensive/monitoring use.

## Step 1 — Gather threat description

If not already provided, ask the user for:
1. **Threat name** (e.g., "WiFi deauth flood", "433 MHz continuous carrier")
2. **Detection medium**: WiFi / BLE / Sub-GHz RF / Serial / Network
3. **Desired output**: C firmware code / Suricata rule / Sigma rule / All
4. **Alert action**: Log to serial / Set GPIO pin / Send MQTT / Blink LED

## Step 2 — Infer project style

Use `Read` to scan for existing project files that show code style:

```
Look for:
  - src/*.c, src/*.cpp, main/*.c (midas-recon-fw style)
  - include/*.h (type definitions, constants)
  - platformio.ini (target chip, framework)
```

Note:
- Framework: Arduino or ESP-IDF?
- Detection patterns already in use (e.g., `esp_wifi_80211_tx`, `cc1101_*`, `nrf24_*`)
- Alert mechanism already used (Serial.println vs ESP_LOGI vs MQTT publish)

If no project files found, use sensible defaults:
- Framework: ESP-IDF with FreeRTOS
- Alert: `ESP_LOGW()` + GPIO pin toggle

## Step 3 — Generate C firmware detection function

### Template: WiFi deauthentication flood

```c
/**
 * WiFi deauth flood detector
 * Counts 802.11 deauthentication frames in a sliding window.
 * Alert fires when count exceeds threshold within the window.
 *
 * Legal: Passive monitor mode receive only. No injection.
 */

#include "esp_wifi.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define DEAUTH_WINDOW_MS     5000   // 5-second sliding window
#define DEAUTH_THRESHOLD     10     // alert if > 10 deauths in window
#define DETECTION_LOG_TAG    "DEAUTH_DETECT"

static uint32_t s_deauth_timestamps[64];
static uint8_t  s_deauth_head = 0;
static uint8_t  s_deauth_count = 0;

void wifi_sniffer_cb(void *buf, wifi_promiscuous_pkt_type_t type) {
    if (type != WIFI_PKT_MGMT) return;

    const wifi_promiscuous_pkt_t *pkt = (wifi_promiscuous_pkt_t *)buf;
    const uint8_t *frame = pkt->payload;

    // Frame control: subtype 1100 (0xC0) = deauthentication
    uint8_t subtype = (frame[0] >> 4) & 0x0F;
    if (subtype != 0x0C) return;   // 0x0C = deauth

    uint32_t now = xTaskGetTickCount() * portTICK_PERIOD_MS;
    s_deauth_timestamps[s_deauth_head % 64] = now;
    s_deauth_head++;

    // Count events within window
    s_deauth_count = 0;
    for (int i = 0; i < 64; i++) {
        if (s_deauth_timestamps[i] && (now - s_deauth_timestamps[i]) < DEAUTH_WINDOW_MS) {
            s_deauth_count++;
        }
    }

    if (s_deauth_count > DEAUTH_THRESHOLD) {
        ESP_LOGW(DETECTION_LOG_TAG,
            "ALERT: Deauth flood detected — %u frames in %u ms window",
            s_deauth_count, DEAUTH_WINDOW_MS);
        // TODO: set alert GPIO, send MQTT, etc.
    }
}

void deauth_detector_init(void) {
    esp_wifi_set_promiscuous(true);
    esp_wifi_set_promiscuous_rx_cb(wifi_sniffer_cb);
    ESP_LOGI(DETECTION_LOG_TAG, "Deauth flood detector active (threshold=%d/%dms)",
             DEAUTH_THRESHOLD, DEAUTH_WINDOW_MS);
}
```

### Template: Sub-GHz continuous carrier (433 MHz jamming)

```c
/**
 * 433 MHz continuous carrier detector (potential jammer or stuck transmitter)
 * Reads RSSI from CC1101 and alerts if signal is sustained above threshold.
 *
 * Requires: CC1101 SPI driver (cc1101.h)
 */

#include "cc1101.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define CARRIER_RSSI_THRESHOLD   -65    // dBm — above this = strong signal
#define CARRIER_DURATION_MS      2000   // sustained for 2 s = alert
#define CARRIER_LOG_TAG          "RF_CARRIER"

void carrier_detect_task(void *pvParam) {
    uint32_t above_threshold_since = 0;
    bool alerting = false;

    cc1101_set_frequency(433920000UL);  // 433.92 MHz
    cc1101_set_mode(CC1101_MODE_RX);

    while (1) {
        int8_t rssi = cc1101_get_rssi_dbm();
        uint32_t now = xTaskGetTickCount() * portTICK_PERIOD_MS;

        if (rssi > CARRIER_RSSI_THRESHOLD) {
            if (above_threshold_since == 0) {
                above_threshold_since = now;
            } else if (!alerting && (now - above_threshold_since) >= CARRIER_DURATION_MS) {
                alerting = true;
                ESP_LOGW(CARRIER_LOG_TAG,
                    "ALERT: Sustained carrier at 433.92 MHz — RSSI %d dBm for >%u ms",
                    rssi, CARRIER_DURATION_MS);
                // TODO: alert action
            }
        } else {
            if (alerting) {
                ESP_LOGI(CARRIER_LOG_TAG, "Carrier gone — RSSI %d dBm", rssi);
            }
            above_threshold_since = 0;
            alerting = false;
        }

        vTaskDelay(pdMS_TO_TICKS(100));
    }
}

void carrier_detector_init(void) {
    xTaskCreate(carrier_detect_task, "carrier_detect", 4096, NULL, 5, NULL);
    ESP_LOGI(CARRIER_LOG_TAG, "Carrier detector active (threshold=%d dBm, window=%d ms)",
             CARRIER_RSSI_THRESHOLD, CARRIER_DURATION_MS);
}
```

## Step 4 — Generate Suricata rule (optional)

For WiFi-layer or IP-layer threats detectable by a network tap:

```
# Suricata rule: WiFi deauth storm (requires WIDS integration)
# Place in /etc/suricata/rules/custom.rules

alert wifi any any -> any any (
    msg:"WIDS WiFi Deauthentication Flood";
    wifi.type:mgmt;
    wifi.subtype:deauth;
    threshold: type threshold, track by_src, count 10, seconds 5;
    classtype:denial-of-service;
    sid:9001001; rev:1;
)
```

## Step 5 — Generate Sigma rule (optional)

```yaml
title: WiFi Deauthentication Flood Detected
id: a1b2c3d4-0000-0000-0000-000000000001
status: experimental
description: Detects a high rate of WiFi deauthentication frames indicating a potential attack
references:
  - https://www.wi-fi.org/
author: JosephR26
date: 2025/03/15
logsource:
  product: wireless_ids
  service: wids
detection:
  selection:
    EventID: DEAUTH_FLOOD
    FrameCount|gte: 10
  timeframe: 5s
  condition: selection
falsepositives:
  - Legitimate AP teardown
  - Driver bugs causing repeated deauth
level: high
tags:
  - attack.denial_of_service
  - attack.t1499
```

## Step 6 — Save generated files

Use `Write` to save:
- `detection_<threat_name>_esp32.c` — C firmware detection function
- `detection_<threat_name>.rules` — Suricata rule (if requested)
- `detection_<threat_name>.yml` — Sigma rule (if requested)

## Step 7 — Validate compilation (optional)

If the user wants to validate the C code compiles:
1. Ask for the project path.
2. Instruct user to add the generated `.c` file to their project's `src/` directory.
3. Call `esp32_build(projectPath)` via MCP to verify it compiles.
4. Report build success / errors.

## Step 8 — Summary

Report:
- Files generated and their paths
- Key constants the user should tune (thresholds, frequencies, GPIO pins)
- How to integrate into their `app_main()` or `setup()` function
- Any limitations (e.g., promiscuous mode requires specific ESP32 WiFi mode)

## Notes

- Adapt templates to match the user's existing code style (inferred in Step 2).
- If generating RF detection code, confirm the hardware (CC1101 vs NRF24 vs raw ADC).
- `allowed-tools` applies to CLI. For Agent SDK, enforce via `allowedTools`.
- Never generate code that transmits, jams, or injects frames.
