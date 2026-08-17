/**
 * ESP32 Hardware Interrogation Agent
 *
 * Serves newline-delimited JSON requests from the ESP32 DevOps MCP server over
 * the USB serial link and answers with newline-delimited JSON.
 *
 *   host  -> target : {"id":1,"op":"i2c.scan","params":{...}}
 *   target -> host  : {"id":1,"ok":true,"data":{...}}
 *
 * Design rules
 * ------------
 * - Passive at boot. No bus is initialised and no GPIO is driven until a request
 *   explicitly names the pins to use.
 * - Read-first. There is no arbitrary register-write operation. `i2c.writeRead`
 *   exists because addressed reads and documented identification commands
 *   require emitting bytes; the host layer gates it behind declared, justified
 *   probes.
 * - No flash access, no NVS access, no credential access, no firmware readout.
 * - Every operation is bounded by an explicit length and timeout.
 *
 * Blocking is confined to a single request handler; loop() itself never blocks
 * on delay() and the agent returns to idle between requests.
 */

#include <Arduino.h>
#include <ArduinoJson.h>
#include <SPI.h>
#include <Wire.h>
#include <esp_system.h>
#include <esp_chip_info.h>
#include <esp_flash.h>
#include <esp_ota_ops.h>

#ifndef AGENT_VERSION
#define AGENT_VERSION "1.0.0"
#endif

static const size_t kRequestCapacity = 4096;
static const size_t kMaxPayloadBytes = 512;
static const uint32_t kMaxCaptureMs = 30000;

static String g_line;

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

static void sendError(long id, const char *kind, const String &message) {
  JsonDocument doc;
  doc["id"] = id;
  doc["ok"] = false;
  doc["error"] = message;
  doc["errorKind"] = kind;
  serializeJson(doc, Serial);
  Serial.println();
}

static void sendOk(long id, JsonDocument &data) {
  JsonDocument doc;
  doc["id"] = id;
  doc["ok"] = true;
  doc["data"] = data;
  serializeJson(doc, Serial);
  Serial.println();
}

// ---------------------------------------------------------------------------
// Pin safety
// ---------------------------------------------------------------------------

/**
 * Reject pins that are wired to SPI flash on the classic ESP32 (GPIO6..11) and
 * any out-of-range value. Driving those pins corrupts execution.
 */
static bool pinIsUsable(int pin) {
  if (pin < 0 || pin > 48) return false;
#if CONFIG_IDF_TARGET_ESP32
  if (pin >= 6 && pin <= 11) return false;  // SPI flash
  if (pin >= 34 && pin <= 39) return true;  // input-only, still valid as MISO/RX
#endif
  return true;
}

static bool requirePins(long id, std::initializer_list<int> pins) {
  for (int pin : pins) {
    if (!pinIsUsable(pin)) {
      sendError(id, "DEVICE_ERROR", String("Refusing to use unsafe or invalid GPIO ") + pin);
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// sys.*
// ---------------------------------------------------------------------------

static const char *resetReasonName(esp_reset_reason_t reason) {
  switch (reason) {
    case ESP_RST_POWERON:  return "POWERON";
    case ESP_RST_EXT:      return "EXTERNAL";
    case ESP_RST_SW:       return "SOFTWARE";
    case ESP_RST_PANIC:    return "PANIC";
    case ESP_RST_INT_WDT:  return "INT_WDT";
    case ESP_RST_TASK_WDT: return "TASK_WDT";
    case ESP_RST_WDT:      return "WDT";
    case ESP_RST_DEEPSLEEP:return "DEEPSLEEP";
    case ESP_RST_BROWNOUT: return "BROWNOUT";
    case ESP_RST_SDIO:     return "SDIO";
    default:               return "UNKNOWN";
  }
}

static void opSysInfo(long id) {
  esp_chip_info_t info;
  esp_chip_info(&info);

  JsonDocument data;
  data["agentVersion"] = AGENT_VERSION;

  switch (info.model) {
    case CHIP_ESP32:   data["family"] = "ESP32";    break;
    case CHIP_ESP32S2: data["family"] = "ESP32-S2"; break;
    case CHIP_ESP32S3: data["family"] = "ESP32-S3"; break;
    case CHIP_ESP32C3: data["family"] = "ESP32-C3"; break;
#ifdef CHIP_ESP32C6
    case CHIP_ESP32C6: data["family"] = "ESP32-C6"; break;
#endif
#ifdef CHIP_ESP32H2
    case CHIP_ESP32H2: data["family"] = "ESP32-H2"; break;
#endif
    default:           data["family"] = "UNKNOWN";  break;
  }

  data["cores"] = info.cores;
  data["revision"] = info.revision;
  data["cpuFrequencyMHz"] = getCpuFrequencyMhz();
  data["sdkVersion"] = ESP.getSdkVersion();
  data["framework"] = "arduino-esp32";
  data["resetReason"] = resetReasonName(esp_reset_reason());
  data["uptimeMs"] = (uint32_t)millis();
  data["freeHeap"] = ESP.getFreeHeap();
  data["heapSize"] = ESP.getHeapSize();
  data["minFreeHeap"] = ESP.getMinFreeHeap();
  data["sketchSize"] = ESP.getSketchSize();
  data["sketchMD5"] = ESP.getSketchMD5();

  uint32_t flashSize = 0;
  if (esp_flash_get_size(NULL, &flashSize) == ESP_OK) {
    data["flashSizeBytes"] = flashSize;
  }
  data["psramBytes"] = ESP.getPsramSize();

  uint8_t mac[6] = {0};
  if (esp_read_mac(mac, ESP_MAC_WIFI_STA) == ESP_OK) {
    char buf[18];
    snprintf(buf, sizeof(buf), "%02X:%02X:%02X:%02X:%02X:%02X",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    data["mac"] = buf;
  }

  JsonArray features = data["features"].to<JsonArray>();
  if (info.features & CHIP_FEATURE_WIFI_BGN) features.add("WIFI_BGN");
  if (info.features & CHIP_FEATURE_BT)       features.add("BT_CLASSIC");
  if (info.features & CHIP_FEATURE_BLE)      features.add("BLE");
  if (info.features & CHIP_FEATURE_EMB_FLASH) features.add("EMBEDDED_FLASH");
  if (info.features & CHIP_FEATURE_EMB_PSRAM) features.add("EMBEDDED_PSRAM");

  const esp_app_desc_t *app = esp_ota_get_app_description();
  if (app != NULL) {
    data["appName"] = app->project_name;
    data["appVersion"] = app->version;
    data["buildInfo"] = String(app->date) + " " + String(app->time);
    data["idfVersion"] = app->idf_ver;
  }

  sendOk(id, data);
}

static void opSysInterfaces(long id) {
  esp_chip_info_t info;
  esp_chip_info(&info);

  JsonDocument data;
  // Only what the running firmware can actually attest to. Peripheral counts
  // are the host's job (from its datasheet catalog) — the agent does not guess.
  data["agentVersion"] = AGENT_VERSION;
  data["cores"] = info.cores;
  data["cpuFrequencyMHz"] = getCpuFrequencyMhz();
  data["defaultI2CSda"] = SDA;
  data["defaultI2CScl"] = SCL;
  data["defaultSpiMosi"] = MOSI;
  data["defaultSpiMiso"] = MISO;
  data["defaultSpiSclk"] = SCK;
  data["defaultSpiCs"] = SS;
  data["monitorBaud"] = 115200;

  JsonArray configured = data["configuredPeripherals"].to<JsonArray>();
  configured.add("UART0 (console, in use by this agent)");

  sendOk(id, data);
}

// ---------------------------------------------------------------------------
// i2c.*
// ---------------------------------------------------------------------------

static TwoWire *i2cBus(int controller) {
#if SOC_I2C_NUM > 1
  return controller == 1 ? &Wire1 : &Wire;
#else
  (void)controller;
  return &Wire;
#endif
}

static bool i2cBegin(long id, JsonObject params, TwoWire **out) {
  int controller = params["controller"] | 0;
  int sda = params["sda"] | SDA;
  int scl = params["scl"] | SCL;
  uint32_t freq = params["frequencyHz"] | 100000UL;

  if (!requirePins(id, {sda, scl})) return false;
  if (freq < 1000 || freq > 1000000) {
    sendError(id, "DEVICE_ERROR", "I2C frequency out of range (1kHz..1MHz)");
    return false;
  }

  TwoWire *bus = i2cBus(controller);
  if (!bus->begin(sda, scl, freq)) {
    sendError(id, "BUS_ERROR", "Wire.begin() failed — check SDA/SCL wiring and pull-ups");
    return false;
  }
  bus->setTimeOut(50);
  *out = bus;
  return true;
}

static void opI2cScan(long id, JsonObject params) {
  TwoWire *bus = nullptr;
  if (!i2cBegin(id, params, &bus)) return;

  int start = params["start"] | 0x08;
  int end = params["end"] | 0x77;
  int repeats = params["repeats"] | 1;
  if (start < 0x00) start = 0x00;
  if (end > 0x7F) end = 0x7F;
  if (repeats < 1) repeats = 1;
  if (repeats > 8) repeats = 8;

  JsonDocument data;
  JsonArray results = data["addresses"].to<JsonArray>();
  uint32_t scanStart = millis();

  for (int addr = start; addr <= end; addr++) {
    int acks = 0;
    int busErrors = 0;
    uint32_t firstAckUs = 0;

    for (int i = 0; i < repeats; i++) {
      uint32_t t0 = micros();
      bus->beginTransmission((uint8_t)addr);
      uint8_t rc = bus->endTransmission();
      uint32_t elapsed = micros() - t0;

      if (rc == 0) {
        if (acks == 0) firstAckUs = elapsed;
        acks++;
      } else if (rc == 4 || rc == 5) {
        busErrors++;  // 4 = other error, 5 = timeout
      }
    }

    if (acks == 0 && busErrors == 0) continue;  // Plain NACK — nothing to report.

    JsonObject entry = results.add<JsonObject>();
    entry["address"] = addr;
    entry["ackCount"] = acks;
    entry["probeCount"] = repeats;
    entry["busErrors"] = busErrors;
    if (acks > 0) entry["responseTimeUs"] = firstAckUs;
  }

  data["scanDurationMs"] = millis() - scanStart;
  data["start"] = start;
  data["end"] = end;
  sendOk(id, data);
}

static void opI2cRead(long id, JsonObject params) {
  TwoWire *bus = nullptr;
  if (!i2cBegin(id, params, &bus)) return;

  int address = params["address"] | -1;
  int length = params["length"] | 1;
  bool hasRegister = params["register"].is<int>();
  int reg = params["register"] | 0;

  if (address < 0 || address > 0x7F) {
    sendError(id, "DEVICE_ERROR", "address must be 0x00..0x7F");
    return;
  }
  if (length < 1 || (size_t)length > kMaxPayloadBytes) {
    sendError(id, "DEVICE_ERROR", "length must be 1..512");
    return;
  }

  if (hasRegister) {
    bus->beginTransmission((uint8_t)address);
    bus->write((uint8_t)reg);
    uint8_t rc = bus->endTransmission(false);
    if (rc != 0) {
      sendError(id, "DEVICE_ERROR", String("Register address write NACKed (code ") + rc + ")");
      return;
    }
  }

  uint32_t t0 = micros();
  size_t got = bus->requestFrom((uint8_t)address, (size_t)length, true);
  JsonDocument data;
  JsonArray bytes = data["bytes"].to<JsonArray>();
  while (bus->available() && bytes.size() < (size_t)length) {
    bytes.add(bus->read());
  }
  data["durationUs"] = micros() - t0;
  data["requested"] = length;
  data["received"] = got;
  sendOk(id, data);
}

static void opI2cWriteRead(long id, JsonObject params) {
  TwoWire *bus = nullptr;
  if (!i2cBegin(id, params, &bus)) return;

  int address = params["address"] | -1;
  int readLength = params["readLength"] | 0;
  uint32_t delayMs = params["delayMs"] | 0;
  JsonArray write = params["write"].as<JsonArray>();

  if (address < 0 || address > 0x7F) {
    sendError(id, "DEVICE_ERROR", "address must be 0x00..0x7F");
    return;
  }
  if (write.isNull() || write.size() == 0) {
    sendError(id, "DEVICE_ERROR", "write must be a non-empty byte array");
    return;
  }
  if (write.size() > kMaxPayloadBytes || (size_t)readLength > kMaxPayloadBytes) {
    sendError(id, "DEVICE_ERROR", "write/readLength exceed 512 bytes");
    return;
  }
  if (delayMs > 2000) delayMs = 2000;

  uint32_t t0 = micros();
  bus->beginTransmission((uint8_t)address);
  for (JsonVariant v : write) bus->write((uint8_t)(v.as<int>() & 0xFF));
  uint8_t rc = bus->endTransmission();

  JsonDocument data;
  data["writeAck"] = (rc == 0);
  data["writeStatus"] = rc;

  if (rc != 0) {
    data["durationUs"] = micros() - t0;
    data["bytes"].to<JsonArray>();
    sendOk(id, data);  // A NACK is an observation, not a transport failure.
    return;
  }

  if (delayMs > 0) {
    uint32_t until = millis() + delayMs;
    while ((int32_t)(millis() - until) < 0) {
      yield();
    }
  }

  JsonArray bytes = data["bytes"].to<JsonArray>();
  if (readLength > 0) {
    size_t got = bus->requestFrom((uint8_t)address, (size_t)readLength, true);
    data["received"] = got;
    while (bus->available() && bytes.size() < (size_t)readLength) {
      bytes.add(bus->read());
    }
  }
  data["durationUs"] = micros() - t0;
  sendOk(id, data);
}

// ---------------------------------------------------------------------------
// spi.*
// ---------------------------------------------------------------------------

static void opSpiTransfer(long id, JsonObject params) {
  int sclk = params["sclk"] | SCK;
  int miso = params["miso"] | MISO;
  int mosi = params["mosi"] | MOSI;
  int cs = params["cs"] | SS;
  int mode = params["mode"] | 0;
  uint32_t clockHz = params["clockHz"] | 1000000UL;
  bool lsbFirst = params["lsbFirst"] | false;
  int readLength = params["readLength"] | 0;
  JsonArray tx = params["tx"].as<JsonArray>();

  if (!requirePins(id, {sclk, miso, mosi, cs})) return;
  if (mode < 0 || mode > 3) {
    sendError(id, "DEVICE_ERROR", "mode must be 0..3");
    return;
  }
  if (clockHz < 10000 || clockHz > 40000000UL) {
    sendError(id, "DEVICE_ERROR", "clockHz out of range (10kHz..40MHz)");
    return;
  }
  if (tx.isNull()) {
    sendError(id, "DEVICE_ERROR", "tx must be a byte array");
    return;
  }

  size_t total = tx.size() + (readLength > 0 ? (size_t)readLength : 0);
  if (total == 0 || total > kMaxPayloadBytes) {
    sendError(id, "DEVICE_ERROR", "total transaction size must be 1..512 bytes");
    return;
  }

  static uint8_t buffer[kMaxPayloadBytes];
  size_t i = 0;
  for (JsonVariant v : tx) buffer[i++] = (uint8_t)(v.as<int>() & 0xFF);
  // Trailing clocks for the read phase are emitted as 0x00 — a benign idle byte.
  while (i < total) buffer[i++] = 0x00;

  SPIClass spi(HSPI);
  spi.begin(sclk, miso, mosi, cs);
  pinMode(cs, OUTPUT);
  digitalWrite(cs, HIGH);

  uint32_t t0 = micros();
  spi.beginTransaction(SPISettings(clockHz, lsbFirst ? LSBFIRST : MSBFIRST, mode));
  digitalWrite(cs, LOW);
  spi.transfer(buffer, total);
  digitalWrite(cs, HIGH);
  spi.endTransaction();
  uint32_t elapsed = micros() - t0;
  spi.end();

  JsonDocument data;
  JsonArray rx = data["bytes"].to<JsonArray>();
  for (size_t j = 0; j < total; j++) rx.add(buffer[j]);
  data["durationUs"] = elapsed;
  data["mode"] = mode;
  data["clockHz"] = clockHz;
  sendOk(id, data);
}

// ---------------------------------------------------------------------------
// uart.*
// ---------------------------------------------------------------------------

static bool uartBegin(long id, JsonObject params, HardwareSerial **out, uint32_t *baudOut) {
  int controller = params["controller"] | 1;
  int rx = params["rx"] | -1;
  int tx = params["tx"] | -1;
  uint32_t baud = params["baud"] | 9600UL;
  const char *parity = params["parity"] | "none";
  int dataBits = params["dataBits"] | 8;
  int stopBits = params["stopBits"] | 1;

  if (controller < 1 || controller > 2) {
    sendError(id, "DEVICE_ERROR", "controller must be 1 or 2 (UART0 is the console)");
    return false;
  }
  if (rx < 0) {
    sendError(id, "DEVICE_ERROR", "rx pin is required");
    return false;
  }
  if (!requirePins(id, {rx})) return false;
  if (tx >= 0 && !requirePins(id, {tx})) return false;
  if (baud < 300 || baud > 3000000UL) {
    sendError(id, "DEVICE_ERROR", "baud out of range (300..3000000)");
    return false;
  }

  uint32_t config;
  if (dataBits == 8 && stopBits == 1 && strcmp(parity, "none") == 0)      config = SERIAL_8N1;
  else if (dataBits == 8 && stopBits == 1 && strcmp(parity, "even") == 0) config = SERIAL_8E1;
  else if (dataBits == 8 && stopBits == 1 && strcmp(parity, "odd") == 0)  config = SERIAL_8O1;
  else if (dataBits == 8 && stopBits == 2 && strcmp(parity, "none") == 0) config = SERIAL_8N2;
  else if (dataBits == 7 && stopBits == 1 && strcmp(parity, "none") == 0) config = SERIAL_7N1;
  else {
    sendError(id, "UNSUPPORTED_OPERATION", "Unsupported data/parity/stop combination");
    return false;
  }

#if SOC_UART_NUM > 2
  HardwareSerial *port = (controller == 2) ? &Serial2 : &Serial1;
#else
  HardwareSerial *port = &Serial1;
#endif
  port->begin(baud, config, rx, tx);
  *out = port;
  *baudOut = baud;
  return true;
}

static void opUartListen(long id, JsonObject params) {
  HardwareSerial *port = nullptr;
  uint32_t baud = 0;
  if (!uartBegin(id, params, &port, &baud)) return;

  uint32_t durationMs = params["durationMs"] | 2000UL;
  if (durationMs > kMaxCaptureMs) durationMs = kMaxCaptureMs;
  size_t maxBytes = params["maxBytes"] | (int)kMaxPayloadBytes;
  if (maxBytes > kMaxPayloadBytes) maxBytes = kMaxPayloadBytes;

  JsonDocument data;
  JsonArray bytes = data["bytes"].to<JsonArray>();
  JsonArray gaps = data["gapsUs"].to<JsonArray>();

  uint32_t deadline = millis() + durationMs;
  uint32_t lastByteUs = 0;
  bool first = true;

  while ((int32_t)(millis() - deadline) < 0 && bytes.size() < maxBytes) {
    if (port->available()) {
      uint32_t nowUs = micros();
      bytes.add(port->read());
      gaps.add(first ? 0 : (nowUs - lastByteUs));
      lastByteUs = nowUs;
      first = false;
    } else {
      yield();
    }
  }

  port->end();
  data["baud"] = baud;
  data["durationMs"] = durationMs;
  data["truncated"] = bytes.size() >= maxBytes;
  sendOk(id, data);
}

static void opUartWriteRead(long id, JsonObject params) {
  HardwareSerial *port = nullptr;
  uint32_t baud = 0;
  if (!uartBegin(id, params, &port, &baud)) return;

  JsonArray write = params["write"].as<JsonArray>();
  int readLength = params["readLength"] | 0;
  uint32_t timeoutMs = params["timeoutMs"] | 1000UL;
  if (timeoutMs > kMaxCaptureMs) timeoutMs = kMaxCaptureMs;

  if (write.isNull() || write.size() == 0 || write.size() > kMaxPayloadBytes) {
    port->end();
    sendError(id, "DEVICE_ERROR", "write must be a byte array of 1..512 bytes");
    return;
  }
  if (readLength < 0 || (size_t)readLength > kMaxPayloadBytes) {
    port->end();
    sendError(id, "DEVICE_ERROR", "readLength must be 0..512");
    return;
  }

  uint32_t t0 = micros();
  for (JsonVariant v : write) port->write((uint8_t)(v.as<int>() & 0xFF));
  port->flush();

  JsonDocument data;
  JsonArray bytes = data["bytes"].to<JsonArray>();
  uint32_t deadline = millis() + timeoutMs;
  while ((int32_t)(millis() - deadline) < 0 && bytes.size() < (size_t)readLength) {
    if (port->available()) {
      bytes.add(port->read());
    } else {
      yield();
    }
  }

  data["durationUs"] = micros() - t0;
  data["baud"] = baud;
  data["complete"] = bytes.size() == (size_t)readLength;
  port->end();
  sendOk(id, data);
}

// ---------------------------------------------------------------------------
// gpio.* / adc.*
// ---------------------------------------------------------------------------

static void opGpioInfo(long id, JsonObject params) {
  JsonDocument data;
  JsonArray pins = data["pins"].to<JsonArray>();
  JsonArray requested = params["pins"].as<JsonArray>();

  // Read-only inspection: pins are sampled as inputs and never driven.
  if (!requested.isNull()) {
    for (JsonVariant v : requested) {
      int pin = v.as<int>();
      JsonObject entry = pins.add<JsonObject>();
      entry["gpio"] = pin;
      entry["usable"] = pinIsUsable(pin);
      if (pinIsUsable(pin)) {
        pinMode(pin, INPUT);
        entry["level"] = digitalRead(pin);
      } else {
        entry["reason"] = "reserved or out of range on this target";
      }
    }
  }

  data["note"] = "Levels sampled with INPUT (no pull-up/down applied); pins are never driven.";
  sendOk(id, data);
}

static void opAdcRead(long id, JsonObject params) {
  int pin = params["pin"] | -1;
  int samples = params["samples"] | 1;
  if (!requirePins(id, {pin})) return;
  if (samples < 1) samples = 1;
  if (samples > 64) samples = 64;

  JsonDocument data;
  JsonArray values = data["values"].to<JsonArray>();
  uint32_t t0 = micros();
  for (int i = 0; i < samples; i++) {
    values.add(analogRead(pin));
  }
  data["durationUs"] = micros() - t0;
  data["pin"] = pin;
  data["resolutionBits"] = 12;
  sendOk(id, data);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

static void handleRequest(const String &line) {
  JsonDocument request;
  DeserializationError err = deserializeJson(request, line);
  if (err) {
    sendError(0, "MALFORMED_RESPONSE", String("Invalid request JSON: ") + err.c_str());
    return;
  }

  long id = request["id"] | 0;
  const char *op = request["op"] | "";
  JsonObject params = request["params"].is<JsonObject>()
                          ? request["params"].as<JsonObject>()
                          : request["emptyParams"].to<JsonObject>();

  if (strcmp(op, "sys.ping") == 0) {
    JsonDocument data;
    data["agentVersion"] = AGENT_VERSION;
    data["uptimeMs"] = (uint32_t)millis();
    sendOk(id, data);
  } else if (strcmp(op, "sys.info") == 0) {
    opSysInfo(id);
  } else if (strcmp(op, "sys.interfaces") == 0) {
    opSysInterfaces(id);
  } else if (strcmp(op, "i2c.scan") == 0) {
    opI2cScan(id, params);
  } else if (strcmp(op, "i2c.read") == 0) {
    opI2cRead(id, params);
  } else if (strcmp(op, "i2c.writeRead") == 0) {
    opI2cWriteRead(id, params);
  } else if (strcmp(op, "spi.transfer") == 0) {
    opSpiTransfer(id, params);
  } else if (strcmp(op, "uart.listen") == 0) {
    opUartListen(id, params);
  } else if (strcmp(op, "uart.writeRead") == 0) {
    opUartWriteRead(id, params);
  } else if (strcmp(op, "gpio.info") == 0) {
    opGpioInfo(id, params);
  } else if (strcmp(op, "adc.read") == 0) {
    opAdcRead(id, params);
  } else {
    sendError(id, "UNSUPPORTED_OPERATION", String("Unknown op: ") + op);
  }
}

void setup() {
  Serial.begin(115200);
  g_line.reserve(kRequestCapacity);
  // Announce on a non-JSON line so the bridge records it as raw context without
  // mistaking it for a response.
  Serial.println("# esp32-interrogation-agent " AGENT_VERSION " ready");
}

void loop() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n') {
      String line = g_line;
      g_line = "";
      line.trim();
      if (line.length() > 0) handleRequest(line);
    } else if (c != '\r') {
      if (g_line.length() < kRequestCapacity) {
        g_line += c;
      } else {
        g_line = "";  // Overlong request — drop and resynchronise on next newline.
      }
    }
  }
}
