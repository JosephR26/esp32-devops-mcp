# Hardware Interrogation Subsystem

> The ESP32 as a general-purpose physical instrument.

```
Claude  ->  ESP32 DevOps MCP  ->  ESP32 DevKitC-32  ->  physical component
```

The MCP does not know what is attached, and does not need to. It exposes the
ESP32's real capabilities — buses, pins, timing, stimulus, measurement — and lets
the caller construct whatever investigation the component's externally observable
behaviour allows.

## The two rules

**1. A datasheet claim is never a verified capability.**

Every value carries its evidence source and confidence. "The datasheet says this
part supports FeliCa" and "we exchanged FeliCa frames with this unit" are
different facts, stored in different fields, and the first never masquerades as
the second.

**2. The MCP exposes capabilities; it does not prescribe the investigation.**

An operation is refused only when it is *physically* invalid on this chip — a pin
that does not exist, a pin wired to flash, an input-only pin asked to drive, a
parameter outside the silicon's range, a resource conflict, or malformed
arguments. An operation is never refused because nobody anticipated it.

There is no allow-list of permitted commands. Arbitrary bytes are arbitrary.

## Component profiles are optional

A profile is **knowledge, not permission**. When one exists it accelerates
investigation by naming registers, decoding bitfields, supplying expected
responses and suggesting probes. When one does not exist, everything is still
reachable through the generic primitives.

> A missing profile entry means **UNKNOWN**, not **FORBIDDEN**.

---

## Contents

- [The general-purpose layer](#the-general-purpose-layer)
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
- [Worked examples](#worked-examples)
- [Adding a component profile](#adding-a-component-profile)

---

## The general-purpose layer

### `esp32_hardware_execute`

The core tool. Runs a sequence of operations you construct, against hardware the
MCP knows nothing about.

```json
{
  "operations": [
    { "op": "I2C_SCAN", "bus": { "sda": 21, "scl": 22 } },
    { "op": "I2C_WRITE", "address": 66, "write": [222, 173, 190, 239] },
    { "op": "I2C_WRITE_READ", "address": 66, "write": [127], "readLength": 16,
      "delayMs": 20, "repeatedStart": true },
    { "op": "GPIO_PULSE", "pin": 25, "level": 1, "durationUs": 500 },
    { "op": "ADC_READ", "pin": 34, "samples": 64, "intervalUs": 100 }
  ],
  "repetitions": 5
}
```

Available operations:

| Interface | Operations |
|-----------|-----------|
| I2C | `I2C_SCAN`, `I2C_READ`, `I2C_WRITE`, `I2C_WRITE_READ` (arbitrary bytes, repeated start, inter-phase delay) |
| SPI | `SPI_TRANSFER` (arbitrary TX, read length, mode 0-3, clock, bit order, pad byte, CS control) |
| UART | `UART_WRITE`, `UART_READ`, `UART_WRITE_READ` (arbitrary bytes, baud, data bits, parity, stop bits, timeout) |
| GPIO | `GPIO_CONFIGURE`, `GPIO_READ`, `GPIO_WRITE`, `GPIO_PULSE`, `GPIO_SAMPLE` (multi-pin, one timebase) |
| Timing | `GPIO_MEASURE_PULSE`, `GPIO_MEASURE_FREQUENCY`, `GPIO_WAIT_EDGE` |
| Analogue | `ADC_READ` (sample count, interval, attenuation) |
| Stimulus | `PWM_START`, `PWM_STOP` (frequency, duty, resolution, duration) |
| Multi-signal | `STIMULUS_CAPTURE` — drive one pin while sampling others on a shared timebase |
| Control | `DELAY` |

Every operation returns raw bytes, derived statistics, the verbatim agent
response, the exact request echoed back, timing, and any warnings.

### `esp32_pin_capabilities`

What each pin on *this* chip can actually do, so an experiment can be planned
rather than guessed:

- digital input / output, PWM, ADC, DAC, touch, GPIO-matrix routability
- which pins are reserved, and why
- which are strapping pins (usable — reported as a note, never a refusal)
- what the running firmware currently has allocated
- which agent capabilities this firmware build does not implement

The ESP32 GPIO matrix routes most peripheral signals to most pins, so bus
assignments are far more flexible than a board silkscreen suggests. The system
reports; the caller decides. No pin is ever chosen implicitly.

### Register writes

`esp32_register_inspect` reads by default and writes when asked:

```json
{
  "address": 104,
  "writes": [
    { "register": 107, "value": [0],
      "justification": "Attempt to clear the sleep bit and observe the effect" }
  ]
}
```

A write is a legitimate investigative act — entering a mode, selecting a bank,
triggering a measurement, clearing status, or testing undocumented behaviour.
Each write records the bytes sent, the bus acknowledgement, the value read
immediately before, and the state read back afterwards.

> A bus ACK confirms the device accepted the bytes. It does **not** establish
> that the device did what you intended. Read back and compare.

### Adaptive investigation

The MCP performs no reasoning. It provides expressive primitives and returns rich
observations; the caller closes the loop:

```
OBSERVE -> HYPOTHESISE -> EXPERIMENT -> OBSERVE -> COMPARE -> HYPOTHESISE -> ...
```

Results from one `esp32_hardware_execute` call inform the operations of the next.
Nothing requires the whole investigation to be known before it begins.

---

## Architecture

```
Claude
  │  MCP tool call
  ▼
src/tools/execute.ts         GENERAL PATH: arbitrary operations, pin capability reporting
src/tools/hardware.ts        inventory, interface discovery, I2C/SPI/UART discovery
src/tools/component.ts       identify, probe, registers, capabilities, test, benchmark, experiment
  │
  ▼
src/hardware/                the engine — knows nothing about any specific component
  ├── operations.ts          arbitrary operations, validated against real silicon
  ├── session.ts             port resolution, agent detection, pin-safety checks
  ├── transport.ts           injectable HardwareTransport (replaced wholesale in tests)
  ├── probe.ts               executes declarative ProbeOperations
  ├── identify.ts            evidence-weighted identification scoring
  ├── capability.ts          capability model + gap analysis
  ├── registers.ts           register decoding
  ├── patterns.ts            byte patterns, ASCII, statistics
  ├── evidence.ts            confidence derivation, UNKNOWN handling
  ├── experiment.ts          experiment lifecycle orchestration
  ├── esp32-catalog.ts       datasheet data + per-pin capability map
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
profile object — and a component with no profile is still fully investigable
through `src/hardware/operations.ts`.

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
| `sys.capabilities` | Which operations this build implements, its limits, and what it does not provide |
| `i2c.scan` | Address sweep with per-address ACK counts and timing |
| `i2c.read` | Plain read — no command byte emitted |
| `i2c.write` | Arbitrary write with no read phase, including register writes |
| `i2c.writeRead` | Write then read, with optional repeated START and inter-phase delay |
| `spi.transfer` | Full-duplex transfer: arbitrary TX, mode, clock, bit order, pad byte, CS control |
| `uart.listen` | Passive capture with per-byte inter-arrival gaps |
| `uart.writeRead` | Send arbitrary bytes and capture the reply |
| `gpio.read` | Read pin levels without reconfiguring them |
| `gpio.configure` | Set a pin mode (input, pull-up, pull-down, output, open-drain) |
| `gpio.write` | Drive a pin to a level |
| `gpio.pulse` | Drive a timed pulse and report the achieved width |
| `gpio.sample` | Sample several pins repeatedly on one timebase |
| `gpio.measurePulse` | Measure a single pulse width |
| `gpio.measureFrequency` | Count edges over a window and derive frequency |
| `gpio.waitEdge` | Block until an edge, reporting elapsed time |
| `gpio.stimulusCapture` | Drive one pin while sampling others on a shared timebase |
| `adc.read` | Sampled ADC reads with interval and attenuation |
| `pwm.start` / `pwm.stop` | LEDC waveform generation as an experimental stimulus |

### Agent design rules

- **Passive at boot.** No bus is initialised and no GPIO is driven until a request names the pins. Once a request names a pin, the agent drives it — this is an instrument, not a read-only observer.
- **General purpose.** Arbitrary bytes may be written to any bus and any pin the caller names. The agent maintains no list of permitted commands and does not know what is attached.
- **Refusals are physical.** GPIO6–11 on the classic ESP32 (SPI flash) are rejected outright, as are out-of-range pins and parameters. Nothing is rejected for being unanticipated.
- **Everything bounded.** Every operation has an explicit length and timeout ceiling so one request cannot hang the agent.
- **No flash, NVS, credential or firmware readout.**
- **Self-describing.** `sys.capabilities` reports what this build implements and, explicitly, what it does not.

### Capabilities the agent does not provide

Reported by `sys.capabilities` rather than left to fail obscurely:

| Capability | Why |
|-----------|-----|
| `i2s.*` | Needs continuous DMA streaming the JSON link cannot carry |
| `can.*` (TWAI) | Not implemented; also needs an external transceiver |
| `dac.write`, `touch.read` | Not implemented in this build |
| High-speed logic capture | GPIO sampling is a polling loop, so the rate is bounded well below the pin's switching limit. Use an external logic analyser for fast signals. |

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

**Depths are presets, not ceilings.**

`FORENSIC` is the most thorough default — it is not the maximum possible
investigation. Claude can always formulate another experiment after any depth
completes.

To go beyond a preset:

| Want | Use |
|------|-----|
| A probe the preset skipped | `additionalProbes: ["probe.id"]` |
| Register inspection below DEEP | `inspectRegisters: true` |
| Something no probe covers | `additionalOperations: [...]` |
| Anything at all | `esp32_hardware_execute` |

`minDepth` on a profile probe is scheduling guidance — it keeps a slow probe out
of a quick connectivity check — not a permission boundary.

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

The constraints that remain are the ones that are physically real.

### What is enforced, and why

| Constraint | Reason |
|-----------|--------|
| GPIO6-11 (ESP32) refused | Wired to SPI flash; driving them corrupts execution |
| Pins outside the family's range refused | They do not exist |
| Input-only pins refused for output roles | No output driver in the silicon |
| A pin in two conflicting roles refused | Physical resource conflict |
| PWM frequency x resolution bounded | The LEDC timer divides an 80 MHz source |
| Bus clocks bounded | Outside the peripheral's supported range |
| Payloads bounded to 512 bytes | The agent's fixed buffer |
| Samples bounded to 1024 | The agent's capture buffer |
| SPI chip-select must be named | An unspecified CS would select an unknown device |
| UART RX/TX must be named | Nothing to listen on or talk to otherwise |
| UART0 refused | It carries the agent link; reassigning it severs the session |
| Malformed arguments refused | Not representable as a hardware operation |

Every one of these is a fact about the ESP32 or the request. None is a judgement
about what the caller ought to be investigating.

### What is reported, not refused

- **Strapping pins** are usable. Their level at reset selects boot mode, so
  holding one may prevent a normal reboot — a note, not a block.
- **A pin driven in one operation and sampled in another** is a legitimate
  technique. It is flagged so the caller knows a self-read returns the drive
  level, then it runs.
- **Unknown chip family** means the host cannot check pins, so it defers to the
  agent, which checks on-target. It does not refuse.

### What is not implemented, by design

These are outside what a hardware interrogation instrument needs, and are absent
from both the agent and the host:

- Credential or payment-credential extraction
- Firmware readout from the target
- Flash and NVS access
- Mass or automated targeting

Note what is **not** on this list: register writes, arbitrary bus transactions,
GPIO driving and stimulus generation are all supported, because they are how a
component is actually investigated.

### Voltage

**Voltage levels are never assumed.** The system reports which pins are
configured and refuses the ones that are electrically reserved; it makes no claim
about logic levels. Level shifting and supply compatibility remain the operator's
responsibility, and the MCP cannot detect a mismatch.

## Testing strategy

**No physical hardware is required for CI.** `setTransportFactory()` replaces the
serial transport with a `MockTransport` driven by a scripted handler table.

```bash
npm test      # compiles src + tests to .test-build/, runs node:test
```

269 tests across 43 suites cover:

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

## Worked examples

No component is canonical. The two examples below show the same instrument used
on a part with a profile and a part without one.

### A. An unknown component on I2C — no profile, no identity

The case the system is built for.

```
1.  esp32_pin_capabilities
      -> which pins can do what; what is reserved; what the firmware has allocated

2.  esp32_hardware_execute
      { "operations": [{ "op": "I2C_SCAN", "bus": { "sda": 21, "scl": 22 } }] }
      -> which addresses acknowledge

3.  esp32_hardware_execute
      { "operations": [{ "op": "I2C_READ", "address": <found>, "length": 8 }] }
      -> what a plain read returns, if anything

4.  esp32_register_inspect
      { "address": <found>, "registers": [0, 1, 2, ... ] }
      -> raw values across a register sweep, undecoded

5.  esp32_hardware_execute  (repetitions: 10)
      -> which values are stable and which change

6.  esp32_register_inspect
      { "address": <found>,
        "writes": [{ "register": <r>, "value": [<v>],
                     "justification": "Test whether <r> is writable" }] }
      -> whether the write is acknowledged and whether the read-back changes

7.  esp32_hardware_execute
      { "operations": [{ "op": "STIMULUS_CAPTURE", ... }] }
      -> whether an interrupt line moves in response to a stimulus
```

Each step's result shapes the next. Nothing here requires knowing what the part
is, and step 6 can discover a writable register no datasheet mentions.

### B. A component with a profile — accelerated, not constrained

```
1.  esp32_hardware_inventory        -> confirm the ESP32 itself
2.  esp32_i2c_scan                  -> find responders, with LOW-confidence address hints
3.  esp32_component_identify        -> score the evidence against known profiles
4.  esp32_component_probe (DEEP)    -> profile-driven probes, registers, capability matrix
5.  esp32_component_capabilities    -> DOCUMENTED vs OBSERVED vs VERIFIED, plus gaps
6.  esp32_component_test            -> promote capabilities to VERIFIED where tests pass
7.  esp32_component_benchmark       -> measured vs documented maxima
8.  esp32_hardware_execute          -> investigate anything the profile does not cover
```

Step 8 is the point. A profile accelerates steps 3-7; it does not bound step 8.

### What a complete baseline establishes

- exact communication interface and working configuration
- device identification with named evidence and a confidence level — or an
  honest UNIDENTIFIED
- readable configuration and status
- what was actually **observed** on this unit, separate from what is documented
- what was **verified** by a test that met a stated expectation
- performance characteristics, with the measurement's limits stated
- error and edge-case behaviour
- capability gaps: what is claimed but unproven, and what is unexplored
- undocumented behaviour found by experiment

## Adding a component profile

A profile is optional. Add one when you want to *accelerate* repeated work on a
part — decoded bitfields, named probes, expected responses, a capability matrix.
You never need one to investigate.

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
- [ ] Deeper or slower probes carry a `minDepth` (scheduling guidance, not a limit)
- [ ] No identification rule is entirely wildcards — such a rule matches any
      response of that length and manufactures confidence out of nothing
      (rejected at registration)
