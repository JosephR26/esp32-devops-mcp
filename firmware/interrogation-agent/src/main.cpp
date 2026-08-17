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
 * - General purpose. Arbitrary bytes may be written to any bus and any pin the
 *   caller names, because that is what makes the ESP32 usable as an
 *   experimentation instrument. The agent does not know or care what is
 *   attached, and it maintains no list of permitted commands.
 * - Refusals are physical. An operation is rejected because a pin does not
 *   exist, is wired to flash, cannot drive an output, or a parameter is out of
 *   the silicon's range — never because the operation was unanticipated.
 * - No flash access, no NVS access, no credential access, no firmware readout.
 * - Every operation is bounded by an explicit length and timeout so a single
 *   request cannot hang the agent.
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
#define AGENT_VERSION "2.0.0"
#endif

static const size_t kRequestCapacity = 8192;
static const size_t kMaxPayloadBytes = 512;
static const size_t kMaxSamples = 1024;
static const uint32_t kMaxCaptureMs = 30000;

static String g_line;

/** LEDC channel bookkeeping so PWM can be started and stopped per pin. */
static const int kMaxPwmChannels = 8;
static int g_pwmPins[kMaxPwmChannels];
static bool g_pwmActive[kMaxPwmChannels];

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

/**
 * Report exactly which operations this agent build implements.
 *
 * The host uses this to tell the caller what is genuinely available rather than
 * guessing, so a capability the firmware lacks is reported as unavailable
 * instead of failing obscurely at call time.
 */
static void opSysCapabilities(long id) {
  JsonDocument data;
  data["agentVersion"] = AGENT_VERSION;

  JsonArray ops = data["operations"].to<JsonArray>();
  static const char *kOps[] = {
      "sys.ping",       "sys.info",         "sys.interfaces",       "sys.capabilities",
      "i2c.scan",       "i2c.read",         "i2c.write",            "i2c.writeRead",
      "spi.transfer",   "uart.listen",      "uart.writeRead",       "gpio.read",
      "gpio.configure", "gpio.write",       "gpio.pulse",           "gpio.sample",
      "gpio.measurePulse", "gpio.measureFrequency", "gpio.waitEdge", "gpio.stimulusCapture",
      "adc.read",       "pwm.start",        "pwm.stop",
  };
  for (const char *name : kOps) ops.add(name);

  JsonObject limits = data["limits"].to<JsonObject>();
  limits["maxPayloadBytes"] = kMaxPayloadBytes;
  limits["maxSamples"] = kMaxSamples;
  limits["maxCaptureMs"] = kMaxCaptureMs;
  limits["maxRequestBytes"] = kRequestCapacity;
  limits["maxPwmChannels"] = kMaxPwmChannels;
  limits["maxSampledPins"] = 16;

  // Capabilities this build does NOT provide, stated rather than left to be
  // discovered by a failing call.
  JsonArray unavailable = data["unavailable"].to<JsonArray>();
  JsonObject dac = unavailable.add<JsonObject>();
  dac["capability"] = "dac.write";
  dac["reason"] = "Not implemented by this agent build.";
  JsonObject touch = unavailable.add<JsonObject>();
  touch["capability"] = "touch.read";
  touch["reason"] = "Not implemented by this agent build.";
  JsonObject i2s = unavailable.add<JsonObject>();
  i2s["capability"] = "i2s.*";
  i2s["reason"] = "Not implemented; I2S needs continuous DMA streaming the JSON link cannot carry.";
  JsonObject logic = unavailable.add<JsonObject>();
  logic["capability"] = "high-speed logic capture";
  logic["reason"] =
      "GPIO sampling is a polling loop, so the sample rate is bounded well below the pin's "
      "switching limit. Use an external logic analyser for fast signals.";
  JsonObject can = unavailable.add<JsonObject>();
  can["capability"] = "can.* (TWAI)";
  can["reason"] = "Not implemented; also requires an external CAN transceiver.";

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

/**
 * Write arbitrary bytes with no read phase.
 *
 * This is the general write primitive, and it deliberately places no meaning on
 * the payload: a register write, a mode command, a bank select and a byte
 * sequence nobody has documented are all the same operation here. The agent
 * reports what the bus did; interpreting it is the caller's job.
 */
static void opI2cWrite(long id, JsonObject params) {
  TwoWire *bus = nullptr;
  if (!i2cBegin(id, params, &bus)) return;

  int address = params["address"] | -1;
  JsonArray write = params["write"].as<JsonArray>();

  if (address < 0 || address > 0x7F) {
    sendError(id, "DEVICE_ERROR", "address must be 0x00..0x7F");
    return;
  }
  if (write.isNull() || write.size() == 0 || write.size() > kMaxPayloadBytes) {
    sendError(id, "DEVICE_ERROR", "write must be a byte array of 1..512 bytes");
    return;
  }

  uint32_t t0 = micros();
  bus->beginTransmission((uint8_t)address);
  size_t queued = 0;
  for (JsonVariant v : write) queued += bus->write((uint8_t)(v.as<int>() & 0xFF));
  uint8_t rc = bus->endTransmission();
  uint32_t elapsed = micros() - t0;

  JsonDocument data;
  data["address"] = address;
  data["bytesQueued"] = queued;
  data["writeAck"] = (rc == 0);
  data["writeStatus"] = rc;
  data["durationUs"] = elapsed;
  data["bytes"].to<JsonArray>();  // No read phase; keep the shape consistent.
  switch (rc) {
    case 0: data["statusText"] = "ACK"; break;
    case 1: data["statusText"] = "data too long for the transmit buffer"; break;
    case 2: data["statusText"] = "NACK on address"; break;
    case 3: data["statusText"] = "NACK on data"; break;
    case 4: data["statusText"] = "other bus error"; break;
    case 5: data["statusText"] = "timeout"; break;
    default: data["statusText"] = "unknown"; break;
  }
  // A NACK is an observation about the bus, not a transport failure.
  sendOk(id, data);
}

static void opI2cWriteRead(long id, JsonObject params) {
  TwoWire *bus = nullptr;
  if (!i2cBegin(id, params, &bus)) return;

  int address = params["address"] | -1;
  int readLength = params["readLength"] | 0;
  uint32_t delayMs = params["delayMs"] | 0;
  bool repeatedStart = params["repeatedStart"] | false;
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
  // A repeated START keeps the bus held between phases, which many devices
  // require when the write only selects what the read should return.
  uint8_t rc = bus->endTransmission(!repeatedStart);

  JsonDocument data;
  data["writeAck"] = (rc == 0);
  data["writeStatus"] = rc;
  data["repeatedStart"] = repeatedStart;

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
  int padByte = params["padByte"] | 0x00;
  bool keepCsAsserted = params["keepCsAsserted"] | true;
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
  // Filler clocked out during the read phase. Defaults to 0x00; the caller may
  // choose another value where a device expects a specific idle byte.
  while (i < total) buffer[i++] = (uint8_t)(padByte & 0xFF);

  size_t txLength = tx.size();

  SPIClass spi(HSPI);
  spi.begin(sclk, miso, mosi, cs);
  pinMode(cs, OUTPUT);
  digitalWrite(cs, HIGH);

  uint32_t t0 = micros();
  spi.beginTransaction(SPISettings(clockHz, lsbFirst ? LSBFIRST : MSBFIRST, mode));
  digitalWrite(cs, LOW);
  if (keepCsAsserted || txLength == 0 || txLength == total) {
    spi.transfer(buffer, total);
  } else {
    // Deassert CS between the write and read phases for devices that latch a
    // command on the rising edge before responding.
    spi.transfer(buffer, txLength);
    digitalWrite(cs, HIGH);
    delayMicroseconds(1);
    digitalWrite(cs, LOW);
    spi.transfer(buffer + txLength, total - txLength);
  }
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
  data["lsbFirst"] = lsbFirst;
  data["txLength"] = txLength;
  data["keepCsAsserted"] = keepCsAsserted;
  data["note"] =
      "SPI is full duplex: bytes[0..txLength-1] were clocked in while tx was clocked out.";
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

  // Full 5-8 data bits x none/even/odd parity x 1/2 stop bits, as the UART
  // peripheral supports. An unknown peer may use any of these.
  uint32_t config;
  if (dataBits < 5 || dataBits > 8) {
    sendError(id, "DEVICE_ERROR", "dataBits must be 5, 6, 7 or 8");
    return false;
  }
  if (stopBits != 1 && stopBits != 2) {
    sendError(id, "DEVICE_ERROR", "stopBits must be 1 or 2");
    return false;
  }

  const bool even = strcmp(parity, "even") == 0;
  const bool odd = strcmp(parity, "odd") == 0;
  if (!even && !odd && strcmp(parity, "none") != 0) {
    sendError(id, "DEVICE_ERROR", "parity must be none, even or odd");
    return false;
  }

  switch (dataBits) {
    case 5:
      config = stopBits == 2 ? (even ? SERIAL_5E2 : odd ? SERIAL_5O2 : SERIAL_5N2)
                             : (even ? SERIAL_5E1 : odd ? SERIAL_5O1 : SERIAL_5N1);
      break;
    case 6:
      config = stopBits == 2 ? (even ? SERIAL_6E2 : odd ? SERIAL_6O2 : SERIAL_6N2)
                             : (even ? SERIAL_6E1 : odd ? SERIAL_6O1 : SERIAL_6N1);
      break;
    case 7:
      config = stopBits == 2 ? (even ? SERIAL_7E2 : odd ? SERIAL_7O2 : SERIAL_7N2)
                             : (even ? SERIAL_7E1 : odd ? SERIAL_7O1 : SERIAL_7N1);
      break;
    default:
      config = stopBits == 2 ? (even ? SERIAL_8E2 : odd ? SERIAL_8O2 : SERIAL_8N2)
                             : (even ? SERIAL_8E1 : odd ? SERIAL_8O1 : SERIAL_8N1);
      break;
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
// gpio.*
// ---------------------------------------------------------------------------

/** Busy-wait for sub-millisecond intervals, yielding on longer ones. */
static void waitMicros(uint32_t us) {
  if (us == 0) return;
  if (us < 5000) {
    delayMicroseconds(us);
    return;
  }
  uint32_t deadline = micros() + us;
  while ((int32_t)(micros() - deadline) < 0) yield();
}

static bool applyGpioMode(long id, int pin, const char *mode) {
  if (strcmp(mode, "INPUT") == 0) {
    pinMode(pin, INPUT);
  } else if (strcmp(mode, "INPUT_PULLUP") == 0) {
    pinMode(pin, INPUT_PULLUP);
  } else if (strcmp(mode, "INPUT_PULLDOWN") == 0) {
    pinMode(pin, INPUT_PULLDOWN);
  } else if (strcmp(mode, "OUTPUT") == 0) {
    pinMode(pin, OUTPUT);
  } else if (strcmp(mode, "OUTPUT_OPEN_DRAIN") == 0) {
    pinMode(pin, OUTPUT_OPEN_DRAIN);
  } else {
    sendError(id, "DEVICE_ERROR", String("Unknown GPIO mode: ") + mode);
    return false;
  }
  return true;
}

static void opGpioConfigure(long id, JsonObject params) {
  int pin = params["pin"] | -1;
  const char *mode = params["mode"] | "INPUT";
  if (!requirePins(id, {pin})) return;
  if (!applyGpioMode(id, pin, mode)) return;

  JsonDocument data;
  data["pin"] = pin;
  data["mode"] = mode;
  data["level"] = digitalRead(pin);
  sendOk(id, data);
}

/** Read pin levels without altering how they are configured. */
static void opGpioInfo(long id, JsonObject params) {
  JsonDocument data;
  JsonArray pins = data["pins"].to<JsonArray>();
  JsonArray levels = data["levels"].to<JsonArray>();
  JsonArray requested = params["pins"].as<JsonArray>();

  if (requested.isNull() || requested.size() == 0) {
    sendError(id, "DEVICE_ERROR", "pins must be a non-empty array");
    return;
  }

  for (JsonVariant v : requested) {
    int pin = v.as<int>();
    JsonObject entry = pins.add<JsonObject>();
    entry["gpio"] = pin;
    entry["usable"] = pinIsUsable(pin);
    if (pinIsUsable(pin)) {
      int level = digitalRead(pin);
      entry["level"] = level;
      levels.add(level);
    } else {
      entry["reason"] = "not bonded out, or wired to SPI flash on this target";
    }
  }

  data["note"] = "Levels read as-is; this operation does not reconfigure or drive any pin.";
  sendOk(id, data);
}

/** Drive a pin to a level. The caller named the pin, so the agent drives it. */
static void opGpioWrite(long id, JsonObject params) {
  int pin = params["pin"] | -1;
  int level = params["level"] | 0;
  if (!requirePins(id, {pin})) return;
  if (level != 0 && level != 1) {
    sendError(id, "DEVICE_ERROR", "level must be 0 or 1");
    return;
  }

  pinMode(pin, OUTPUT);
  digitalWrite(pin, level ? HIGH : LOW);

  JsonDocument data;
  data["pin"] = pin;
  data["level"] = level;
  data["readback"] = digitalRead(pin);
  sendOk(id, data);
}

static void opGpioPulse(long id, JsonObject params) {
  int pin = params["pin"] | -1;
  int level = params["level"] | 1;
  uint32_t durationUs = params["durationUs"] | 1000UL;
  int returnLevel = params["returnToLevel"] | (level ? 0 : 1);

  if (!requirePins(id, {pin})) return;
  if (durationUs > 10000000UL) durationUs = 10000000UL;

  pinMode(pin, OUTPUT);
  uint32_t t0 = micros();
  digitalWrite(pin, level ? HIGH : LOW);
  waitMicros(durationUs);
  digitalWrite(pin, returnLevel ? HIGH : LOW);
  uint32_t elapsed = micros() - t0;

  JsonDocument data;
  data["pin"] = pin;
  data["level"] = level;
  data["returnToLevel"] = returnLevel;
  data["requestedUs"] = durationUs;
  data["actualUs"] = elapsed;
  sendOk(id, data);
}

/**
 * Sample several pins repeatedly on one timebase.
 *
 * Samples are interleaved per round so a snapshot across pins shares an instant
 * — the basis for correlating one signal against another.
 */
static void opGpioSample(long id, JsonObject params) {
  JsonArray requested = params["pins"].as<JsonArray>();
  int samples = params["samples"] | 16;
  uint32_t intervalUs = params["intervalUs"] | 1000UL;

  if (requested.isNull() || requested.size() == 0) {
    sendError(id, "DEVICE_ERROR", "pins must be a non-empty array");
    return;
  }
  if (samples < 1) samples = 1;
  if ((size_t)samples > kMaxSamples) samples = kMaxSamples;

  int pins[16];
  size_t pinCount = 0;
  for (JsonVariant v : requested) {
    if (pinCount >= 16) break;
    int pin = v.as<int>();
    if (!requirePins(id, {pin})) return;
    pinMode(pin, INPUT);
    pins[pinCount++] = pin;
  }

  JsonDocument data;
  JsonArray pinList = data["pins"].to<JsonArray>();
  for (size_t i = 0; i < pinCount; i++) pinList.add(pins[i]);

  JsonArray rounds = data["rounds"].to<JsonArray>();
  JsonArray timestamps = data["timestampsUs"].to<JsonArray>();
  JsonArray flat = data["levels"].to<JsonArray>();

  uint32_t t0 = micros();
  for (int s = 0; s < samples; s++) {
    JsonArray round = rounds.add<JsonArray>();
    timestamps.add(micros() - t0);
    for (size_t i = 0; i < pinCount; i++) {
      int level = digitalRead(pins[i]);
      round.add(level);
      flat.add(level);
    }
    if (intervalUs > 0 && s + 1 < samples) waitMicros(intervalUs);
  }

  data["durationUs"] = micros() - t0;
  data["sampleCount"] = samples;
  data["note"] = "Each round holds one level per pin, in the order given by `pins`.";
  sendOk(id, data);
}

/** Measure the width of a single pulse at the given level. */
static void opGpioMeasurePulse(long id, JsonObject params) {
  int pin = params["pin"] | -1;
  int level = params["level"] | 1;
  uint32_t timeoutUs = params["timeoutUs"] | 1000000UL;

  if (!requirePins(id, {pin})) return;
  if (timeoutUs > 10000000UL) timeoutUs = 10000000UL;

  pinMode(pin, INPUT);
  uint32_t width = pulseIn(pin, level ? HIGH : LOW, timeoutUs);

  JsonDocument data;
  data["pin"] = pin;
  data["level"] = level;
  data["widthUs"] = width;
  data["timedOut"] = (width == 0);
  if (width == 0) {
    data["note"] = "pulseIn returned 0: no matching pulse started within the timeout.";
  }
  sendOk(id, data);
}

/** Count edges over a window and derive a frequency. */
static void opGpioMeasureFrequency(long id, JsonObject params) {
  int pin = params["pin"] | -1;
  uint32_t windowMs = params["windowMs"] | 100UL;
  const char *edge = params["edge"] | "RISING";

  if (!requirePins(id, {pin})) return;
  if (windowMs > kMaxCaptureMs) windowMs = kMaxCaptureMs;
  if (windowMs < 1) windowMs = 1;

  pinMode(pin, INPUT);

  bool countBoth = strcmp(edge, "CHANGE") == 0;
  bool countRising = strcmp(edge, "FALLING") != 0;

  uint32_t edges = 0;
  int previous = digitalRead(pin);
  uint32_t t0 = micros();
  uint32_t deadline = millis() + windowMs;

  while ((int32_t)(millis() - deadline) < 0) {
    int current = digitalRead(pin);
    if (current != previous) {
      if (countBoth || (countRising && current == HIGH) || (!countRising && current == LOW)) {
        edges++;
      }
      previous = current;
    }
  }

  uint32_t elapsedUs = micros() - t0;
  JsonDocument data;
  data["pin"] = pin;
  data["edge"] = edge;
  data["edgeCount"] = edges;
  data["windowUs"] = elapsedUs;
  if (elapsedUs > 0) {
    data["frequencyHz"] = (float)edges * 1000000.0f / (float)elapsedUs;
  }
  data["note"] =
      "Edges counted by polling. The sampling loop bounds the measurable frequency well below "
      "the GPIO limit; treat the result as a floor, not the pin's maximum.";
  sendOk(id, data);
}

/** Block until an edge occurs, reporting how long it took. */
static void opGpioWaitEdge(long id, JsonObject params) {
  int pin = params["pin"] | -1;
  const char *edge = params["edge"] | "CHANGE";
  uint32_t timeoutMs = params["timeoutMs"] | 1000UL;

  if (!requirePins(id, {pin})) return;
  if (timeoutMs > kMaxCaptureMs) timeoutMs = kMaxCaptureMs;

  pinMode(pin, INPUT);
  int initial = digitalRead(pin);
  bool wantRising = strcmp(edge, "RISING") == 0;
  bool wantFalling = strcmp(edge, "FALLING") == 0;

  uint32_t t0 = micros();
  uint32_t deadline = millis() + timeoutMs;
  bool seen = false;
  int previous = initial;

  while ((int32_t)(millis() - deadline) < 0) {
    int current = digitalRead(pin);
    if (current != previous) {
      if ((wantRising && current == HIGH) || (wantFalling && current == LOW) ||
          (!wantRising && !wantFalling)) {
        seen = true;
        break;
      }
      previous = current;
    }
    yield();
  }

  JsonDocument data;
  data["pin"] = pin;
  data["edge"] = edge;
  data["initialLevel"] = initial;
  data["finalLevel"] = digitalRead(pin);
  data["observed"] = seen;
  data["elapsedUs"] = micros() - t0;
  data["timedOut"] = !seen;
  sendOk(id, data);
}

/**
 * Drive a stimulus on one pin while sampling others on the same timebase.
 *
 * Component behaviour is often only visible as a correlation between a stimulus
 * and a response on a different signal, which separate calls cannot capture.
 */
static void opGpioStimulusCapture(long id, JsonObject params) {
  JsonObject stimulus = params["stimulus"].as<JsonObject>();
  JsonArray captureArr = params["capturePins"].as<JsonArray>();
  int samples = params["samples"] | 32;
  uint32_t intervalUs = params["intervalUs"] | 100UL;

  if (stimulus.isNull() || captureArr.isNull() || captureArr.size() == 0) {
    sendError(id, "DEVICE_ERROR", "stimulus and a non-empty capturePins array are required");
    return;
  }
  if (samples < 1) samples = 1;
  if ((size_t)samples > kMaxSamples) samples = kMaxSamples;

  int stimPin = stimulus["pin"] | -1;
  const char *kind = stimulus["kind"] | "PULSE";
  int level = stimulus["level"] | 1;
  uint32_t durationUs = stimulus["durationUs"] | 1000UL;
  int cycles = stimulus["cycles"] | 1;
  if (cycles < 1) cycles = 1;
  if (cycles > 1000) cycles = 1000;
  if (durationUs > 10000000UL) durationUs = 10000000UL;

  if (!requirePins(id, {stimPin})) return;

  int capturePins[16];
  size_t captureCount = 0;
  for (JsonVariant v : captureArr) {
    if (captureCount >= 16) break;
    int pin = v.as<int>();
    if (pin == stimPin) {
      sendError(id, "DEVICE_ERROR", "capture pin must differ from the stimulus pin");
      return;
    }
    if (!requirePins(id, {pin})) return;
    pinMode(pin, INPUT);
    capturePins[captureCount++] = pin;
  }

  pinMode(stimPin, OUTPUT);

  JsonDocument data;
  JsonArray pinList = data["capturePins"].to<JsonArray>();
  for (size_t i = 0; i < captureCount; i++) pinList.add(capturePins[i]);

  JsonArray rounds = data["rounds"].to<JsonArray>();
  JsonArray timestamps = data["timestampsUs"].to<JsonArray>();
  JsonArray stimTrace = data["stimulusLevels"].to<JsonArray>();
  JsonArray flat = data["levels"].to<JsonArray>();

  uint32_t t0 = micros();
  int stimLevel = (strcmp(kind, "LEVEL") == 0) ? level : (level ? 0 : 1);
  digitalWrite(stimPin, stimLevel ? HIGH : LOW);

  int cycleIndex = 0;
  uint32_t nextTransitionUs = 0;

  for (int s = 0; s < samples; s++) {
    uint32_t nowUs = micros() - t0;

    // Advance the stimulus waveform on its own schedule, independent of the
    // sample loop, so the capture records the transition rather than causing it.
    if (strcmp(kind, "PULSE") == 0 || strcmp(kind, "TOGGLE") == 0) {
      if (nowUs >= nextTransitionUs && cycleIndex < cycles * 2) {
        stimLevel = (cycleIndex % 2 == 0) ? (level ? 1 : 0) : (level ? 0 : 1);
        digitalWrite(stimPin, stimLevel ? HIGH : LOW);
        nextTransitionUs = nowUs + durationUs;
        cycleIndex++;
      }
    }

    JsonArray round = rounds.add<JsonArray>();
    timestamps.add(nowUs);
    stimTrace.add(stimLevel);
    for (size_t i = 0; i < captureCount; i++) {
      int reading = digitalRead(capturePins[i]);
      round.add(reading);
      flat.add(reading);
    }

    if (intervalUs > 0 && s + 1 < samples) waitMicros(intervalUs);
  }

  // Leave the stimulus pin low rather than holding an arbitrary drive level.
  digitalWrite(stimPin, LOW);

  data["stimulusPin"] = stimPin;
  data["kind"] = kind;
  data["durationUs"] = micros() - t0;
  data["sampleCount"] = samples;
  data["note"] =
      "stimulusLevels[i] is the level driven at the instant rounds[i] was sampled. The stimulus "
      "pin is left LOW on completion.";
  sendOk(id, data);
}

// ---------------------------------------------------------------------------
// adc.*
// ---------------------------------------------------------------------------

static void opAdcRead(long id, JsonObject params) {
  int pin = params["pin"] | -1;
  int samples = params["samples"] | 1;
  uint32_t intervalUs = params["intervalUs"] | 0UL;
  bool hasAtten = params["attenuationDb"].is<float>() || params["attenuationDb"].is<int>();
  float attenDb = params["attenuationDb"] | 11.0f;

  if (!requirePins(id, {pin})) return;
  if (samples < 1) samples = 1;
  if ((size_t)samples > kMaxSamples) samples = kMaxSamples;

  if (hasAtten) {
    adc_attenuation_t attenuation = ADC_11db;
    if (attenDb < 1.0f)      attenuation = ADC_0db;
    else if (attenDb < 4.0f) attenuation = ADC_2_5db;
    else if (attenDb < 8.0f) attenuation = ADC_6db;
    analogSetPinAttenuation(pin, attenuation);
  }

  JsonDocument data;
  JsonArray values = data["values"].to<JsonArray>();
  JsonArray timestamps = data["timestampsUs"].to<JsonArray>();

  uint32_t t0 = micros();
  for (int i = 0; i < samples; i++) {
    timestamps.add(micros() - t0);
    values.add(analogRead(pin));
    if (intervalUs > 0 && i + 1 < samples) waitMicros(intervalUs);
  }

  data["durationUs"] = micros() - t0;
  data["pin"] = pin;
  data["sampleCount"] = samples;
  data["resolutionBits"] = 12;
  if (hasAtten) data["attenuationDb"] = attenDb;
  data["note"] =
      "Raw ADC counts. This agent applies no calibration, and the ESP32 ADC is markedly "
      "non-linear near the rails; convert to volts only with a calibration you trust.";
  sendOk(id, data);
}

// ---------------------------------------------------------------------------
// pwm.* — stimulus generation via the LEDC peripheral
// ---------------------------------------------------------------------------

static int findPwmChannel(int pin, bool allocate) {
  for (int i = 0; i < kMaxPwmChannels; i++) {
    if (g_pwmActive[i] && g_pwmPins[i] == pin) return i;
  }
  if (!allocate) return -1;
  for (int i = 0; i < kMaxPwmChannels; i++) {
    if (!g_pwmActive[i]) return i;
  }
  return -1;
}

static void opPwmStart(long id, JsonObject params) {
  int pin = params["pin"] | -1;
  uint32_t frequencyHz = params["frequencyHz"] | 1000UL;
  float duty = params["duty"] | 0.5f;
  int resolutionBits = params["resolutionBits"] | 10;
  uint32_t durationMs = params["durationMs"] | 0UL;

  if (!requirePins(id, {pin})) return;
  if (frequencyHz < 1) {
    sendError(id, "DEVICE_ERROR", "frequencyHz must be at least 1");
    return;
  }
  if (duty < 0.0f || duty > 1.0f) {
    sendError(id, "DEVICE_ERROR", "duty must be between 0.0 and 1.0");
    return;
  }
  if (resolutionBits < 1 || resolutionBits > 20) {
    sendError(id, "DEVICE_ERROR", "resolutionBits must be 1-20");
    return;
  }
  // The LEDC timer divides an 80 MHz source; frequency x 2^bits must fit.
  double required = (double)frequencyHz * (double)(1UL << resolutionBits);
  if (required > 80000000.0) {
    sendError(id, "DEVICE_ERROR",
              String("frequency/resolution combination needs a ") + String(required / 1e6, 1) +
                  " MHz LEDC clock; the source is 80 MHz");
    return;
  }
  if (durationMs > kMaxCaptureMs) durationMs = kMaxCaptureMs;

  int channel = findPwmChannel(pin, true);
  if (channel < 0) {
    sendError(id, "DEVICE_ERROR", "No free LEDC channel; stop an existing PWM output first");
    return;
  }

  uint32_t maxDuty = (1UL << resolutionBits) - 1;
  uint32_t dutyValue = (uint32_t)(duty * (float)maxDuty);

#if ESP_ARDUINO_VERSION_MAJOR >= 3
  if (!ledcAttachChannel(pin, frequencyHz, resolutionBits, channel)) {
    sendError(id, "DEVICE_ERROR", "ledcAttachChannel failed for this pin/frequency");
    return;
  }
  ledcWrite(pin, dutyValue);
#else
  ledcSetup(channel, frequencyHz, resolutionBits);
  ledcAttachPin(pin, channel);
  ledcWrite(channel, dutyValue);
#endif

  g_pwmPins[channel] = pin;
  g_pwmActive[channel] = true;

  JsonDocument data;
  data["pin"] = pin;
  data["channel"] = channel;
  data["frequencyHz"] = frequencyHz;
  data["resolutionBits"] = resolutionBits;
  data["dutyValue"] = dutyValue;
  data["dutyMax"] = maxDuty;
  data["dutyFraction"] = (float)dutyValue / (float)maxDuty;

  if (durationMs > 0) {
    uint32_t deadline = millis() + durationMs;
    while ((int32_t)(millis() - deadline) < 0) yield();
#if ESP_ARDUINO_VERSION_MAJOR >= 3
    ledcDetach(pin);
#else
    ledcDetachPin(pin);
#endif
    g_pwmActive[channel] = false;
    pinMode(pin, INPUT);
    data["stoppedAfterMs"] = durationMs;
    data["running"] = false;
  } else {
    data["running"] = true;
    data["note"] = "Output is still running. Call pwm.stop to end it.";
  }

  sendOk(id, data);
}

static void opPwmStop(long id, JsonObject params) {
  int pin = params["pin"] | -1;
  if (!requirePins(id, {pin})) return;

  int channel = findPwmChannel(pin, false);
  JsonDocument data;
  data["pin"] = pin;

  if (channel < 0) {
    data["wasRunning"] = false;
    data["note"] = "No PWM output was active on this pin.";
    sendOk(id, data);
    return;
  }

#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcDetach(pin);
#else
  ledcDetachPin(pin);
#endif
  g_pwmActive[channel] = false;
  pinMode(pin, INPUT);

  data["wasRunning"] = true;
  data["channel"] = channel;
  data["note"] = "Pin released and reconfigured as an input.";
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
  } else if (strcmp(op, "i2c.write") == 0) {
    opI2cWrite(id, params);
  } else if (strcmp(op, "i2c.writeRead") == 0) {
    opI2cWriteRead(id, params);
  } else if (strcmp(op, "spi.transfer") == 0) {
    opSpiTransfer(id, params);
  } else if (strcmp(op, "uart.listen") == 0) {
    opUartListen(id, params);
  } else if (strcmp(op, "uart.writeRead") == 0) {
    opUartWriteRead(id, params);
  } else if (strcmp(op, "gpio.info") == 0 || strcmp(op, "gpio.read") == 0) {
    opGpioInfo(id, params);
  } else if (strcmp(op, "gpio.configure") == 0) {
    opGpioConfigure(id, params);
  } else if (strcmp(op, "gpio.write") == 0) {
    opGpioWrite(id, params);
  } else if (strcmp(op, "gpio.pulse") == 0) {
    opGpioPulse(id, params);
  } else if (strcmp(op, "gpio.sample") == 0) {
    opGpioSample(id, params);
  } else if (strcmp(op, "gpio.measurePulse") == 0) {
    opGpioMeasurePulse(id, params);
  } else if (strcmp(op, "gpio.measureFrequency") == 0) {
    opGpioMeasureFrequency(id, params);
  } else if (strcmp(op, "gpio.waitEdge") == 0) {
    opGpioWaitEdge(id, params);
  } else if (strcmp(op, "gpio.stimulusCapture") == 0) {
    opGpioStimulusCapture(id, params);
  } else if (strcmp(op, "adc.read") == 0) {
    opAdcRead(id, params);
  } else if (strcmp(op, "pwm.start") == 0) {
    opPwmStart(id, params);
  } else if (strcmp(op, "pwm.stop") == 0) {
    opPwmStop(id, params);
  } else if (strcmp(op, "sys.capabilities") == 0) {
    opSysCapabilities(id);
  } else {
    sendError(id, "UNSUPPORTED_OPERATION", String("Unknown op: ") + op);
  }
}

void setup() {
  Serial.begin(115200);
  g_line.reserve(kRequestCapacity);
  for (int i = 0; i < kMaxPwmChannels; i++) {
    g_pwmPins[i] = -1;
    g_pwmActive[i] = false;
  }
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
