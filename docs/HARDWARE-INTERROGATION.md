# Hardware Interrogation Subsystem

> Turning the ESP32 DevOps MCP from a firmware-development server into one that can
> systematically interrogate physical hardware and determine what it actually supports.

## The one rule

**A datasheet claim is never a verified capability.**

Every value this subsystem produces carries its evidence source and confidence.
"The datasheet says the PN532 supports FeliCa" and "we exchanged FeliCa frames with
this PN532" are different facts, stored in different fields, and the system will
never let the first masquerade as the second.

---

## Contents

- [Architecture](#architecture)
- [The interrogation pipeline](#the-interrogation-pipeline)
- [The interrogation agent](#the-interrogation-agent)
- [MCP tools](#mcp-tools)
- [Interrogation depths](#interrogation-depths)
- [Capability model](#capability-model)
- [Capability gap analysis](#capability-gap-analysis)
- [Component profiles](#component-profiles)
- [Experiment model](#experiment-model)
- [Raw data and interpretation](#raw-data-and-interpretation)
- [Reproducibility](#reproducibility)
- [Safety model](#safety-model)
- [Testing strategy](#testing-strategy)
- [Worked example: PN532 on an ESP32 DevKitC-32](#worked-example-pn532-on-an-esp32-devkitc-32)
- [Adding a component profile](#adding-a-component-profile)

---

## Architecture

```
Claude
  │  MCP tool call
  ▼
src/tools/hardware.ts        inventory, interface discovery, I2C/SPI/UART discovery
src/tools/component.ts       identify, probe, registers, capabilities, test, benchmark, experiment
  │
  ▼
src/hardware/                the engine — knows nothing about any specific component
  ├── session.ts             port resolution, agent detection, pin-safety checks
  ├── transport.ts           injectable HardwareTransport (replaced wholesale in tests)
  ├── probe.ts               executes declarative ProbeOperations
  ├── identify.ts            evidence-weighted identification scoring
  ├── capability.ts          capability model + gap analysis
  ├── registers.ts           read-only register decoding
  ├── patterns.ts            byte patterns, ASCII, statistics
  ├── evidence.ts            confidence derivation, UNKNOWN handling
  ├── experiment.ts          experiment lifecycle orchestration
  ├── esp32-catalog.ts       static datasheet data per ESP32 family
  ├── registry.ts            component profile registry + validation
  └── profiles/              component profiles — pure data
  │
  ▼
scripts/hw_bridge.py         pyserial bridge, one request/response per invocation
  │  newline-delimited JSON over USB serial
  ▼
firmware/interrogation-agent PlatformIO sketch on the target ESP32
  │
  ▼
PHYSICAL COMPONENT (I2C / SPI / UART)
```

Two properties make this work:

**The engine is component-agnostic.** No file under `src/hardware/` other than
`profiles/` mentions any specific part. Supporting a new component means adding a
profile object.

**The transport is injectable.** `setTransportFactory()` replaces the serial path
with a mock, so the entire pipeline — identification, register decoding, capability
classification, experiments — runs in CI with no hardware attached.

---

## The interrogation pipeline

```
PHYSICAL TARGET
      ↓
ESP32 IDENTIFICATION          esp32_hardware_inventory
      ↓
INTERFACE DISCOVERY           esp32_interface_discovery
      ↓
BUS DISCOVERY                 esp32_i2c_scan / esp32_spi_discovery / esp32_uart_discovery
      ↓
DEVICE DETECTION              esp32_i2c_scan (ACK / no-response / bus-error / unstable / conflict)
      ↓
DEVICE FINGERPRINTING         esp32_i2c_scan (fingerprint: true) — safe plain reads
      ↓
COMPONENT IDENTIFICATION      esp32_component_identify
      ↓
REGISTER / PROTOCOL DISCOVERY esp32_component_probe (DEEP) / esp32_register_inspect
      ↓
CONFIGURATION INSPECTION      esp32_register_inspect
      ↓
CAPABILITY ENUMERATION        esp32_component_capabilities
      ↓
SAFE FUNCTIONAL TESTING       esp32_component_test
      ↓
TELEMETRY CAPTURE             every tool retains raw captures
      ↓
PERFORMANCE CHARACTERISATION  esp32_component_benchmark
      ↓
CAPABILITY MATRIX             esp32_component_capabilities
      ↓
DOCUMENTED vs OBSERVED vs VERIFIED   the matrix columns
      ↓
UNEXPLORED CAPABILITY ANALYSIS       the gap analysis
```

`esp32_hardware_experiment` orchestrates arbitrary slices of this with a full
lifecycle and reproducibility record.

---

## The interrogation agent

Physical access runs through an agent firmware on the target
(`firmware/interrogation-agent/`). It accepts newline-delimited JSON over the USB
serial link:

```
host   -> target : {"id":1,"op":"i2c.scan","params":{"start":8,"end":119,"repeats":3}}
target -> host   : {"id":1,"ok":true,"data":{"addresses":[{"address":36,"ackCount":3,...}]}}
```

### Operations

| Op | Purpose |
|----|---------|
| `sys.ping` | Agent presence and version |
| `sys.info` | Chip, revision, cores, frequency, flash, PSRAM, MAC, features, reset reason, app descriptor |
| `sys.interfaces` | Default bus pins as the running firmware sees them |
| `i2c.scan` | Address sweep with per-address ACK counts and timing |
| `i2c.read` | Plain read — no command byte emitted |
| `i2c.writeRead` | Register-pointer or command write followed by a read |
| `spi.transfer` | Full-duplex transfer with explicit mode, clock and bit order |
| `uart.listen` | Passive capture with per-byte inter-arrival gaps |
| `uart.writeRead` | Send declared bytes and capture the reply |
| `gpio.info` | Sample pin levels as inputs — never drives a pin |
| `adc.read` | Sampled ADC reads |

### Agent design rules

- **Passive at boot.** No bus is initialised and no GPIO is driven until a request names the pins.
- **No arbitrary register write op exists.** `i2c.writeRead` exists because addressed reads and documented identification commands require emitting bytes; the host gates it behind declared, justified probes.
- **Refuses unsafe pins.** GPIO6–11 on the classic ESP32 (SPI flash) are rejected outright.
- **Everything bounded.** Every operation has an explicit length and timeout ceiling.
- **No flash, NVS, credential or firmware readout.**

### Building and flashing the agent

```bash
cd firmware/interrogation-agent
pio run -e esp32dev -t upload        # or -e esp32-s3-devkitc-1, -e esp32-c3-devkitm-1
```

The host also needs pyserial: `pip install -r requirements.txt`.

---

## MCP tools

### `esp32_hardware_inventory`

Comprehensive ESP32 inventory. Combines three evidence tiers and labels each:

| Tier | Source | Confidence |
|------|--------|-----------|
| Live agent readings | `FIRMWARE_REPORT` | `HIGH` |
| Datasheet catalog | `ESP32_CATALOG` | `DOCUMENTED` |
| Host toolchain (platformio.ini, port enumeration) | `TOOLCHAIN_REPORT` | `MEDIUM` |

Every field is an `ObservedValue<T>`:

```json
{
  "value": "ESP32",
  "known": true,
  "confidence": "HIGH",
  "source": "FIRMWARE_REPORT",
  "evidence": "sys.info.family"
}
```

Anything no source answers comes back `{"value": null, "known": false, "confidence": "UNKNOWN"}`.
The tool never guesses.

Note the deliberate asymmetry: peripheral counts (I2C controllers, ADC channels,
DAC channels…) come from the catalog and are `DOCUMENTED`. Wi-Fi and Bluetooth are
marked `OBSERVED` only when the agent reads the corresponding silicon feature bit
out of the running chip.

### `esp32_interface_discovery`

Surveys I2C, SPI, UART, GPIO, ADC, DAC, PWM and TOUCH. Reports available
controllers, pins, current configuration, configured peripherals, conflicts and
warnings. Read-only — no GPIO is configured and no pin is driven. UART0 is flagged
as carrying the agent link and must not be reassigned.

### `esp32_i2c_scan`

Six distinct address outcomes, because collapsing them loses the most diagnostic
information on the bus:

| State | Meaning |
|-------|---------|
| `RESPONDS` | ACKed on every probe repeat |
| `NO_RESPONSE` | NACKed on every repeat |
| `UNSTABLE` | ACKed on some repeats but not all |
| `BUS_ERROR` | Bus-level error (timeout, arbitration) rather than a NACK |
| `ADDRESS_CONFLICT` | Stable ACK but inconsistent data across identical reads |
| `RESERVED_SKIPPED` | 0x00–0x07 or 0x78–0x7F, reserved by the I2C spec |

With `fingerprint: true`, each responder gets a **plain read** — no command byte, so
no device can interpret it as an instruction. Two reads are compared; differing data
under a stable ACK is what promotes a result to `ADDRESS_CONFLICT`.

Address-based profile matches are returned as `possibleMatches` with
`addressOnly: true` and `confidence: "LOW"`. An I2C address is a 7-bit number shared
by many unrelated parts and never identifies a device.

When nothing responds, the report says so explicitly:

> No device acknowledged in the scanned range. This means nothing responded — it does
> not establish that the bus is empty. Check pull-up resistors, wiring, power and the
> SDA/SCL pin assignment before concluding anything.

### `esp32_spi_discovery`

SPI has no addressing and no acknowledgement, so "a response" is whatever MISO
happens to hold. Probing is restricted to explicit named profiles:

| Profile | Bytes sent | Why it is safe |
|---------|-----------|----------------|
| `IDLE_READ` | `FF FF FF FF` | Idle bytes; no device interprets 0xFF as a command |
| `ZERO_READ` | `00 00 00 00` | Complements IDLE_READ — distinguishes a floating line from a held one |
| `JEDEC_ID` | `9F 00 00 00` | JEDEC standard read-only identification, modifies nothing |

Anything else is refused. Component-specific SPI probing goes through a named
component profile whose probes declare what they send and why.

All-0x00 and all-0xFF responses are flagged `degenerate: true` and confidence drops
to `LOW` — that is what an unconnected MISO line looks like, not data.

**A chip-select pin is required.** The tool will not assert an unspecified CS.

### `esp32_uart_discovery`

Passive by default. Captures raw bytes, hex, ASCII where valid, per-packet
timestamps and boundaries (split on a three-character-time idle gap), repeated
patterns, baud clues and protocol candidates (NMEA 0183, UBX, AT, PN532 framing).

`scanBauds: true` tries common rates passively and scores each capture on
printability and byte diversity. It is a heuristic and says so.

`mode: "ACTIVE"` requires a named `component` whose profile declares exactly what
may be transmitted. Sending unsolicited bytes to an unidentified UART peer is not
permitted.

### `esp32_component_identify`

Scores every candidate profile against the available evidence. Three rules keep it
honest:

1. A **contradicted** necessary rule disqualifies a profile. A necessary rule with
   **no evidence** does not — absence of evidence is not evidence of absence, and it
   is reported as reduced score plus reduced coverage instead.
2. An identification resting only on a bus address is capped at `LOW`.
3. Two candidates within 0.12 of each other are marked `ambiguous: true` and
   confidence is capped at `LOW`.

When nothing scores above the reporting threshold, `identified` is `null` — the
tool does not promote the least-bad candidate.

### `esp32_component_probe`

The core tool. Runs the pipeline at a chosen depth (see below), producing
identification, connectivity, probe results, register inspection, capability matrix,
consistency analysis, anomalies, modes, protocols, timing and a reproducibility
record.

### `esp32_register_inspect`

**READ-ONLY by construction.** There is no write path — not behind a flag, not
behind a depth. Registers that are write-only, clear-on-read, or marked unsafe are
skipped with the reason stated:

```json
{
  "name": "INT_STATUS",
  "read": false,
  "skipped": "Reading this register mutates device state (e.g. clear-on-read); skipped by default."
}
```

For each register actually read: address, name, raw value, hex, binary, decoded
bitfields with their documented meanings, reset value, whether it has changed from
reset, documentation reference and confidence.

Two read paths, both driven by profile data:
- **Direct** — I2C register-pointer write followed by a read, for flat register files.
- **Via probe** — for command-protocol parts (the PN532 has no addressable register
  file over I2C, so `readProbeId` names a probe that wraps its `ReadRegister` command).

Single-read confidence is capped at `HIGH`, never `CONFIRMED`: one sample proves the
value at the moment of reading, not that it is stable.

### `esp32_component_capabilities`

Builds the capability matrix and derives the gaps. Runs offline (`offline: true`)
against documentation alone when no hardware is attached, producing an honest
documentation-only matrix in which nothing is observed.

### `esp32_component_test`

Runs the profile's functional tests. Every result records objective, configuration,
procedure, expected result, observed result, pass/fail, evidence, confidence and
duration. A passing test promotes its capability to `VERIFIED` in the returned
matrix. A single passing run is `HIGH` confidence, never `CONFIRMED`.

If a test declares no expected pattern or minimum size, it **cannot pass** — the
result is recorded as an observation with an explanation, rather than a fabricated
verdict.

### `esp32_component_benchmark`

Measures latency, transaction time, throughput, polling rate, read consistency,
error rate and stability. The critical distinction:

```json
{
  "measuredMaximum": { "value": 312.5, "source": "DEVICE_RESPONSE", "confidence": "MEDIUM" },
  "documentedMaximum": { "value": 1000, "source": "DATASHEET", "confidence": "DOCUMENTED" },
  "interpretation": "Sustained polling rate through the full host-to-device path. The device itself will support a higher rate than this figure shows."
}
```

Every timing figure is an end-to-end round trip: host process, Python bridge, USB-UART
link, agent firmware and device. `measuredMaximum` is a **floor** on the hardware
capability, never a ceiling. The tool never claims a hardware limit from a measurement.

### `esp32_hardware_experiment`

See [Experiment model](#experiment-model).

---

## Interrogation depths

| Depth | What runs |
|-------|-----------|
| `BASIC` | Connectivity, identification, interface |
| `STANDARD` | + configuration, known registers, supported modes, protocols, capability matrix |
| `DEEP` | + every safe documented readable register, configuration and status state, feature discovery, timing |
| `FORENSIC` | + repeated measurements, consistency checks, response fingerprinting, undocumented-but-observed behaviour, anomaly detection, capability gap analysis |

**FORENSIC means deeper observation, not destructive action.** No depth enables a
register write, a firmware readout, or a protocol fuzz. Depth controls how much
observation happens, never how safe it is.

Profiles gate individual probes with `minDepth`, so a probe that takes a second to
run does not fire during a quick `BASIC` connectivity check.

---

## Capability model

```typescript
type CapabilityStatus =
  | 'DOCUMENTED' | 'INFERRED' | 'SOFTWARE_SUPPORTED' | 'FIRMWARE_EXPOSED'
  | 'OBSERVED' | 'TESTED' | 'VERIFIED'
  | 'UNTESTED' | 'UNKNOWN' | 'UNSUPPORTED';
```

Each record carries independent flags, plus two derived views:

```json
{
  "name": "example_capability",
  "documented": true,
  "softwareSupported": true,
  "firmwareExposed": false,
  "observed": false,
  "tested": false,
  "verified": false,
  "status": "UNTESTED",
  "tier": "SOFTWARE_SUPPORTED",
  "confidence": "DOCUMENTED",
  "evidence": [...],
  "source": ["COMPONENT_PROFILE"],
  "timestamp": "2026-08-16T12:00:00.000Z"
}
```

- **`status`** — the overall verdict. Documentation, software support and firmware
  exposure are all *claims*; until something is physically observed the verdict is
  `UNTESTED`, no matter how many claims agree.
- **`tier`** — the highest evidence level actually reached. `status` answers "how far
  along is this?"; `tier` answers "what is the strongest thing we can say?".

### Flag meanings

| Flag | Means |
|------|-------|
| `documented` | A datasheet or component profile says the part can do it |
| `softwareSupported` | A driver is known to exist that implements it |
| `firmwareExposed` | The firmware currently on the target offers it |
| `observed` | A physical response consistent with the capability was seen on this unit |
| `tested` | A functional test exercised it |
| `verified` | A functional test exercised it **and** it behaved as expected |
| `unsupported` | Positively determined not to be supported |

`firmwareExposed` cannot be discovered from the bus. It is only ever set from an
explicit statement via `firmwareCapabilities`, so the default of `false` means "not
established", not "proven absent". The interrogation agent is a generic bus bridge
and exposes no component-specific functionality, so probing never sets it.

### Confidence

```
UNKNOWN < LOW < DOCUMENTED < MEDIUM < HIGH < CONFIRMED
```

`DOCUMENTED` sits deliberately between `LOW` and `MEDIUM`: a datasheet claim is
stronger than a guess but weaker than a corroborated physical observation.

`confidenceForSources()` enforces the central rule — **without a physical
observation, confidence is capped at `DOCUMENTED`**, no matter how many paper
sources agree. Agreement between documents is not measurement.

| Evidence | Confidence |
|----------|-----------|
| Any number of `DATASHEET` / `COMPONENT_PROFILE` / `ESP32_CATALOG` sources | `DOCUMENTED` |
| One physical source | `MEDIUM` |
| Two physical sources, or one physical + documentation | `HIGH` |
| Two physical sources + documentation | `CONFIRMED` |

---

## Capability gap analysis

The analysis that keeps the system honest.

| Gap | Condition | What it means |
|-----|-----------|---------------|
| `POTENTIAL_EXTENSION` | documented + software + **not** firmware-exposed | A development opportunity. **Not a verified capability** — nothing has been physically demonstrated. |
| `SOFTWARE_GAP` | documented + **no** software support | Tooling availability only. Says nothing about whether the hardware performs it. |
| `UNDOCUMENTED_OBSERVATION` | observed + **not** documented | Behaviour seen but undescribed. May be incidental, version-specific, or a misread response. |
| `UNVERIFIED_CLAIM` | documented + firmware-exposed + never measured | "Two claims agreeing is still zero measurements." |
| `UNEXPLORED` | documented, nothing else at all | Unexplored means unknown, not unsupported. |

Each gap carries a `rationale`, an explicit `caveat` naming what it does **not**
mean, a confidence, and a concrete `suggestedNextStep`.

---

## Component profiles

Profiles are **data, not code paths**. The engine has no knowledge of any specific
part; adding support means adding a profile object.

```typescript
interface ComponentProfile {
  id: string;
  manufacturer: string;
  partNumber: string;
  aliases: string[];
  description: string;
  interfaces: ComponentInterfaceDescriptor[];  // I2C addresses, SPI mode, default baud…
  identification: IdentificationRule[];        // weighted, optionally `necessary`
  registers: RegisterDefinition[];             // with bitfields and reset values
  protocols: ProtocolDescriptor[];
  modes: OperatingMode[];
  capabilities: ProfileCapability[];           // the DOCUMENTED tier
  safeProbes: SafeProbe[];                     // declarative bus operations
  functionalTests: FunctionalTestDefinition[];
  benchmarks: BenchmarkDefinition[];
  limitations: string[];                       // what this profile cannot establish
  documentation: DocumentationReference[];
  confidence: ConfidenceLevel;
}
```

### Shipped profiles

Chosen to span component classes and prove the architecture is not shaped around
any one part:

| Profile | Class | Interface |
|---------|-------|-----------|
| `pn532` | NFC/RFID controller | I2C / SPI / UART |
| `mpu6050` | 6-axis IMU sensor | I2C |
| `ads1115` | 16-bit ADC | I2C |
| `mcp4725` | 12-bit DAC | I2C |
| `mcp23017` | GPIO expander | I2C |
| `ssd1306` | OLED display controller | I2C / SPI |
| `eeprom-24cxx` | Serial EEPROM | I2C |
| `nrf24l01` | 2.4 GHz radio module | SPI |
| `mcp2515` | CAN controller | SPI |
| `neo-6m` | GNSS receiver | UART |

### Safe probes

A probe is a declarative list of operations plus a safety declaration:

```typescript
{
  id: 'pn532.firmware_version',
  interface: 'I2C',
  justification: 'GetFirmwareVersion is a pure query. It reads identity data and changes no configuration, no RF field state and no stored data.',
  writes: true,
  writeJustification: 'The PN532 is a command-protocol device with no addressable register file over I2C. Obtaining identity requires transmitting the documented command frame. The command itself is read-only in effect and is reversible by doing nothing.',
  reversible: true,
  operations: [
    { op: 'I2C_WRITE_READ', address: 0x24, write: [0x00,0x00,0xFF,0x02,0xFE,0xD4,0x02,0x2A,0x00], readLength: 8, delayMs: 10 },
    { op: 'DELAY', ms: 20 },
    { op: 'I2C_READ', address: 0x24, length: 16 }
  ],
  expect: { pattern: 'D5 03', minBytes: 8 },
  minDepth: 'BASIC'
}
```

`registerProfile()` **rejects** a profile at registration time if:
- a probe emits bytes without `writes: true`
- a writing probe supplies no `writeJustification`
- an identification rule references a probe that does not exist
- a rule weight is outside `(0, 1]`
- a functional test or benchmark references a probe that does not exist

This is the safety contract that keeps "read first" from quietly becoming "write
whenever convenient".

---

## Experiment model

```
PREPARE
  ↓  resolve steps against the profile's safe probes
VERIFY CONFIGURATION
  ↓  check interface/address/pins are complete; ping the agent
EXECUTE
  ↓  run the procedure, honouring critical-step aborts
OBSERVE
  ↓  record every result with its raw capture
CAPTURE
  ↓  confirm telemetry requirements were satisfied
VALIDATE
  ↓  compare observations against declared probe expectations
ANALYSE
  ↓  findings, anomalies, capability implications
REPEAT
  ↓  consistency analysis across repetitions
REPORT
```

Every phase is recorded with start time, completion time, duration, ok/fail, detail,
warnings and errors. **The runner never throws** — a failed experiment is a result,
and the report is produced either way.

`validation.hypothesisSupported` is deliberately three-valued:

- `true` — every observation with a declared expectation matched it
- `false` — none matched, or only some did (a partial match is not support; it
  indicates an unstable or misconfigured setup)
- `null` — data was returned but no executed probe declared an objective pass
  criterion, so no verdict can be reached. The raw captures are retained for manual
  interpretation.

---

## Raw data and interpretation

Every observation preserves both, always:

```json
{
  "raw": "{\"id\":2,\"ok\":true,\"data\":{\"bytes\":[1,0,0,255,6,250,213,3,50,1,6,7]}}",
  "parsed": [1, 0, 0, 255, 6, 250, 213, 3, 50, 1, 6, 7],
  "interpretation": "GetFirmwareVersion: received 12 byte(s) [01 00 00 FF 06 FA D5 03 32 01 06 07]",
  "confidence": "HIGH",
  "source": "DEVICE_RESPONSE",
  "timestamp": "2026-08-16T12:00:00.000Z"
}
```

Raw hardware responses are never discarded after parsing — including when parsing
*fails*. A malformed response still carries its raw text so a later analysis can
re-interpret it without repeating the physical experiment.

---

## Reproducibility

Every probe report, test report, benchmark report and experiment report carries:

```json
{
  "mcpVersion": "1.2.0",
  "hardware": {
    "port":         { "value": "/dev/ttyUSB0", "known": true, "source": "USER_SUPPLIED" },
    "chip":         { "value": "ESP32", "known": true, "source": "FIRMWARE_REPORT" },
    "chipRevision": { "value": "3", "known": true, "source": "FIRMWARE_REPORT" },
    "mac":          { "value": "24:6F:28:AA:BB:CC", "known": true, "source": "FIRMWARE_REPORT" }
  },
  "firmware": {
    "agentVersion":       { "value": "1.0.0", "known": true },
    "applicationName":    { "value": "esp32-interrogation-agent", "known": true },
    "applicationVersion": { "value": "1.0.0", "known": true }
  },
  "configuration": { "interface": "I2C", "address": 36, "frequencyHz": 100000, "depth": "DEEP" },
  "profileId": "pn532",
  "profileConfidence": "DOCUMENTED",
  "timestamp": "2026-08-16T12:00:00.000Z"
}
```

Facts that could not be gathered are `known: false` rather than blank or invented.

---

## Safety model

The default philosophy:

```
DISCOVER FIRST
READ FIRST
MEASURE FIRST
WRITE ONLY WHEN EXPLICITLY JUSTIFIED
```

### What is not implemented, by design

- Credential or payment-credential extraction
- Arbitrary destructive operations
- Uncontrolled GPIO manipulation
- Arbitrary EEPROM writes
- Unrestricted register writes
- Firmware extraction
- Destructive protocol fuzzing

### Enforced constraints

| Constraint | Where |
|-----------|-------|
| GPIO6–11 (ESP32 SPI flash) rejected outright | `checkPins()` + agent `pinIsUsable()` |
| Input-only pins refused for output signals | `checkPins()` |
| The same pin refused for two signals | `checkPins()` |
| SPI chip-select must be named explicitly | `spiDiscovery()`, `validateBusOptions()` |
| UART RX must be named explicitly | `uartDiscovery()`, `validateBusOptions()` |
| UART0 refused (carries the agent link) | `uartDiscovery()` |
| UART active mode requires a declared component | `uartDiscovery()` |
| SPI restricted to named probe profiles | `SPI_PROBE_PROFILES` |
| Clear-on-read registers never read | `isSafeToInspect()` |
| Write-only registers never read | `isSafeToInspect()` |
| Probes emitting bytes must justify it | `validateProfile()` |
| Benchmark iterations capped at the profile limit | `componentBenchmark()` |
| Experiment repetitions capped | `MAX_REPETITIONS` |
| Every operation bounded by length and timeout | agent firmware |

**Voltage levels are never assumed.** The system reports what pins are configured
and refuses reserved ones; it makes no claim about logic levels, and level shifting
remains the operator's responsibility.

---

## Testing strategy

**No physical hardware is required for CI.** `setTransportFactory()` replaces the
serial transport with a `MockTransport` driven by a scripted handler table.

```bash
npm test      # compiles src + tests to .test-build/, runs node:test
```

200 tests across 31 suites cover:

| Area | Coverage |
|------|----------|
| I2C discovery | responds, silent, unstable, address conflict, bus error, reserved addresses, invalid frequency, inverted range, reserved pins, duplicate pins |
| SPI discovery | named profiles, floating MISO, unknown profile rejection, missing CS, invalid mode, input-only pin, profile probes |
| UART discovery | passive capture, packet splitting, NMEA detection, silence, baud scanning, ACTIVE-mode refusal, UART0 refusal, flow-control refusal |
| Component identification | signature match, address-only capping, ambiguity, contradicted necessary rule, unevaluable necessary rule, markings-only, no evidence |
| Register decoding | bitfield extraction, enumerated meanings, reset comparison, multi-byte assembly, missing reset value, invalid bit width |
| Register safety | write-only skipped, clear-on-read skipped, unsafe-marked skipped, never-read assertion |
| Capability classification | all status derivations, tier derivation, UNSUPPORTED override, merging, deduplication |
| Confidence handling | documentation capping, physical escalation, ordering, UNKNOWN propagation |
| Experiment lifecycle | phase order, critical abort, repetitions, consistency, safety constraints, reproducibility, rejected definitions |
| Capability gap analysis | all five gap kinds, no gap when verified, unsupported skipped |
| Failure paths | malformed responses, timeouts, absent agent, no device, unhandled op |

Every suite tests both success and failure paths.

---

## Worked example: PN532 on an ESP32 DevKitC-32

### Wiring

| PN532 | ESP32 DevKitC-32 |
|-------|------------------|
| VCC | 3V3 |
| GND | GND |
| SDA | GPIO21 |
| SCL | GPIO22 |

Set the PN532 breakout's interface selector to **I2C** (usually DIP switch 1=ON,
2=OFF). The interface is set by hardware strapping and cannot be read back over the
bus — the profile lists this under `limitations`.

### Procedure

```
1.  esp32_hardware_inventory
      → confirm ESP32, revision, MAC, 2 I2C controllers (DOCUMENTED)

2.  esp32_interface_discovery
      → confirm default SDA=21, SCL=22 as the firmware reports them

3.  esp32_i2c_scan { repeats: 3, fingerprint: true }
      → expect 0x24 RESPONDS, with a LOW-confidence address-only hint for pn532

4.  esp32_component_identify { interface: "I2C", address: 36 }
      → expect pn532, confidence HIGH, evidence "D5 03 32" signature + ACK frame

5.  esp32_component_probe { component: "pn532", depth: "DEEP" }
      → identification, connectivity, all safe probes, CIU register inspection,
        capability matrix, timing

6.  esp32_component_capabilities { component: "pn532", depth: "DEEP" }
      → the matrix + gap analysis

7.  esp32_component_test { component: "pn532", depth: "DEEP" }
      → identity, communication, status reporting, register readback

8.  esp32_component_benchmark { component: "pn532" }
      → latency, polling rate, response consistency

9.  esp32_hardware_experiment {
      objective: "Establish PN532 identity stability across power-cycle-free repeats",
      targetComponent: "pn532", address: 36, repetitions: 10 }
      → consistency analysis + full reproducibility record
```

### What a complete baseline establishes

Well beyond "I2C address detected":

- Exact communication interface and its working configuration
- Device identification with named evidence and a confidence level
- Firmware version, revision and supported-protocol mask from `GetFirmwareVersion`
- Readable configuration (CIU_TxMode, CIU_RxMode) and status (CIU_Status2) registers
- Documented capabilities — protocols, modes, features — from the profile
- Which of those were actually **observed** on this unit
- Which were **verified** by a functional test
- Response latency and polling rate, with the measurement's limits stated
- Error and edge-case behaviour
- **Capability gaps**: what the datasheet promises that this firmware does not expose
- **Unexplored areas**: what nothing has touched yet

Only after that baseline does proposing firmware development make sense.

---

## Adding a component profile

1. Create `src/hardware/profiles/<part>.ts` exporting a `ComponentProfile`.
2. Add it to `BUILT_IN_PROFILES` in `src/hardware/profiles/index.ts`.
3. Run `npm test` — `validateAllProfiles()` will reject a malformed profile.

No tool handler, identification code, register reader, test runner or benchmark
runner needs to change. That is the point.

For a third-party profile at runtime:

```typescript
import { registerProfile } from './hardware/registry.js';
registerProfile(myProfile);   // throws on a malformed profile
```

### Checklist for a good profile

- [ ] Every probe that emits bytes has a `writeJustification` explaining why it is read-only in effect
- [ ] Identification rules that would be decisive are marked `necessary`
- [ ] Registers with read side effects are marked `readHasSideEffects: true`
- [ ] Reset values come from the datasheet, with a `reference`
- [ ] `limitations` honestly states what the profile *cannot* establish
- [ ] Capabilities the hardware has but no driver implements are marked `softwareSupported: false` — that is what produces a `SOFTWARE_GAP`
- [ ] Deeper or slower probes carry a `minDepth`
