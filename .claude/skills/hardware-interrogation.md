---
description: >
  ALWAYS invoke this skill when the user asks about physical hardware attached to an
  ESP32 — what a component is, what it supports, what it can do, or what is on a bus.
  Trigger phrases include: "what is this component", "identify this chip", "scan the
  I2C bus", "what's on the bus", "what does this sensor support", "interrogate the
  hardware", "what can this module do", "probe the device", "read its registers",
  "what capabilities does it have", "is the PN532 connected", "what's on SDA/SCL",
  "fingerprint this device", "characterise this component", "what does the datasheet
  say vs what we can see", "what haven't we tested yet", "capability gaps",
  "unexplored capabilities", "run a hardware experiment", "baseline this hardware".
  Do NOT call the esp32_i2c_scan / esp32_component_* tools directly without this
  skill — the interrogation ORDER and the evidence discipline are what make the
  results trustworthy.
allowed-tools:
  - mcp__esp32-devops__esp32_hardware_inventory
  - mcp__esp32-devops__esp32_interface_discovery
  - mcp__esp32-devops__esp32_i2c_scan
  - mcp__esp32-devops__esp32_spi_discovery
  - mcp__esp32-devops__esp32_uart_discovery
  - mcp__esp32-devops__esp32_component_identify
  - mcp__esp32-devops__esp32_component_probe
  - mcp__esp32-devops__esp32_register_inspect
  - mcp__esp32-devops__esp32_component_capabilities
  - mcp__esp32-devops__esp32_component_test
  - mcp__esp32-devops__esp32_component_benchmark
  - mcp__esp32-devops__esp32_hardware_experiment
  - mcp__esp32-devops__esp32_hardware_execute
  - mcp__esp32-devops__esp32_pin_capabilities
  - mcp__esp32-devops__esp32_get_recommended_port
  - mcp__esp32-devops__esp32_list_ports
  - Read
  - Write
---

# /hardware-interrogation

Use the ESP32 as a general-purpose physical instrument to investigate whatever is
attached to it.

```
You  ->  ESP32 DevOps MCP  ->  ESP32 DevKitC-32  ->  the component
```

## Two rules govern everything here

**1. Never claim a capability has been verified because a datasheet says so.**

Documentation is a claim. A measurement is a fact. They live in different fields of
every report, and you must keep them different in what you tell the user.

**2. A missing component profile means UNKNOWN, never FORBIDDEN.**

The MCP exposes capabilities; it does not prescribe the investigation. If no
profile exists for the part in front of you, you are not blocked — you are simply
without a shortcut. Use `esp32_hardware_execute` and investigate directly.

Do not tell the user a component cannot be investigated because it is not in a
catalogue. That is never true.

## The general-purpose path

`esp32_hardware_execute` runs operations you construct. It needs no profile, no
predefined probe and no prior identification:

- **I2C** — scan, read, write arbitrary bytes, write-read with repeated start and delay
- **SPI** — arbitrary TX bytes, read length, mode 0-3, clock, bit order, CS control
- **UART** — arbitrary bytes, baud, framing, timeout
- **GPIO** — configure, read, drive, pulse, multi-pin sampling on one timebase
- **Timing** — pulse width, frequency, edge waiting
- **ADC** — sampling with interval and attenuation
- **PWM** — waveform stimulus
- **STIMULUS_CAPTURE** — drive one pin while sampling others, to correlate cause and effect

`esp32_pin_capabilities` tells you what each pin can actually do before you plan.

An operation is refused only when physically invalid on the chip. If you get a
rejection, read its `kind` — it names the physical reason and often a remedy.

## Vocabulary you must use precisely

| Term | Means | You may say it when |
|------|-------|---------------------|
| **KNOWN** | Established by direct measurement on this unit | The tool reported it with a physical evidence source and `known: true` |
| **INFERRED** | Deduced from other evidence, not directly measured | You reasoned from an observation, and you say so |
| **OBSERVED** | A physical response consistent with it was seen | `observed: true` in the capability matrix |
| **VERIFIED** | A functional test ran and produced the expected result | `verified: true` and a `testId` |
| **UNKNOWN** | Not established | `known: false`, or no evidence gathered |

Never upgrade a term. "The datasheet documents FeliCa support" is not "the PN532
supports FeliCa" and is definitely not "FeliCa works".

When a report says `UNKNOWN`, say UNKNOWN. Do not fill the gap with a plausible
value from your own knowledge of the part.

## Prerequisites

The interrogation agent firmware must be running on the target:

```bash
cd firmware/interrogation-agent
pio run -e esp32dev -t upload
```

The host needs pyserial: `pip install -r requirements.txt`

If a tool reports the agent is absent, say so and give this instruction. Do not
retry other tools hoping one works — they all go through the same agent.

---

## The workflow

Follow this order. Each step's output feeds the next; skipping ahead produces
conclusions that rest on nothing.

### 1. Identify the ESP32

`esp32_hardware_inventory`

Confirm chip family, revision, MAC and flash. Note which peripheral counts are
`ESP32_CATALOG` (documented) versus which chip facts are `FIRMWARE_REPORT` (read
from silicon). Report `UNKNOWN` fields as UNKNOWN.

### 2. Inventory interfaces

`esp32_interface_discovery`

Establish which controllers exist and what the default pins are. Note conflicts.
UART0 carries the agent link and must never be reassigned.

### 3. Discover buses

Pick by what the user has attached:

- **I2C** → `esp32_i2c_scan` with `repeats: 3, fingerprint: true`
- **SPI** → `esp32_spi_discovery` with an explicit `cs` pin
- **UART** → `esp32_uart_discovery` in `PASSIVE` mode, `scanBauds: true` if the rate is unknown

If the user has not said which interface, ask rather than guessing — probing the
wrong pins wastes time and tells you nothing.

### 4. Detect peripherals

Read the scan carefully. The six I2C states mean different things:

- `RESPONDS` — something ACKed consistently
- `NO_RESPONSE` — nothing ACKed. **This does not mean the bus is empty.** Say so.
- `UNSTABLE` — intermittent ACK: marginal wiring, weak pull-ups, or a busy device
- `BUS_ERROR` — bus-level fault, not a NACK. Check pull-ups and contention.
- `ADDRESS_CONFLICT` — stable ACK, inconsistent data. Possibly two devices.
- `RESERVED_SKIPPED` — reserved by the I2C spec, not a device

`possibleMatches` are **address-only hints with LOW confidence**. Never report an
address match as an identification. Many unrelated parts share any given address.

### 5. Identify the component — or proceed without an identity

`esp32_component_identify`

Pass the `address` from the scan, and any `markings` the user can read off the
physical part — markings are cheap, valuable evidence.

Read the result honestly:
- `identified: null` → UNIDENTIFIED. Say that. Do not name the closest guess.
- `ambiguous: true` → two candidates are too close to separate. Report both, and say neither is established.
- `confidence: "LOW"` → a lead, not a conclusion.

**An unidentified component is not a dead end.** Switch to the generic path:
scan, read raw, sweep registers, repeat for stability, probe with writes, and
correlate signals. Steps 6-13 below assume a profile; without one, run the
equivalent operations through `esp32_hardware_execute` and record what you see.

### 6. Select an interrogation depth preset

| Use | When |
|-----|------|
| `BASIC` | "Is it there?" — connectivity and identification |
| `STANDARD` | Normal first pass — adds configuration, modes, capability matrix |
| `DEEP` | Full baseline — adds every declared register, feature discovery, timing |
| `FORENSIC` | Investigating an anomaly — adds repeated measurement, consistency, anomaly detection |

**These are presets, not ceilings.** `FORENSIC` is the most thorough default, not
the limit of what you may do. After any depth you can always run another
experiment. To go further within the tool: `additionalProbes`,
`additionalOperations`, `inspectRegisters: true`. To go further still:
`esp32_hardware_execute`.

Default to `DEEP` when the user asks for a baseline or a full picture.

### 7. Read documented identification data

`esp32_component_probe` at the chosen depth.

Report what the identification probes actually returned, with the raw bytes. "The
device returned `D5 03 32 01 06 07`, which matches the documented
GetFirmwareVersion response — IC 0x32, version 1, revision 6" is a good sentence.
"It's a PN532" alone is not.

### 8. Inspect configuration and status

`esp32_register_inspect`

Reads need no profile — pass numeric `registers` and get raw values. With a
profile, the same values come back decoded into named bitfields. Registers the
profile does not describe are still read, raw.

**Writes are available** via `writes`, as explicit experiments: entering a mode,
selecting a bank, triggering a measurement, clearing status, or testing
undocumented behaviour. Each records the bytes sent, the acknowledgement, the
value before, and the state after.

A bus ACK means the device accepted the bytes. It does **not** mean the device did
what you intended. Read back and compare, and report it that way.

Registers listed under `skipped` were deliberately not read — clear-on-read or
write-only. Mention that they were skipped and why; do not present them as
unreadable failures.

Flag registers where `changedFromReset: true` — the device has been configured since
power-up, or the profile's reset values do not apply to this variant.

### 9. Enumerate documented capabilities

`esp32_component_capabilities`

This is the documentation tier. Everything here is a claim from the profile.

### 10. Determine software support

Read `softwareSupported` per capability. This says a driver is known to exist. It
says **nothing** about this unit.

### 11. Determine current firmware exposure

`firmwareExposed` cannot be discovered from the bus. It is `false` by default,
meaning "not established" — **not** "proven absent".

If the user knows what their firmware exposes, pass it as `firmwareCapabilities`.
If they do not, say that firmware exposure is undetermined rather than assuming.

### 12. Run safe functional tests

`esp32_component_test`

Only a passing test promotes a capability to `VERIFIED`. Report the observed result
alongside the expected result, not just pass/fail.

A test with no objective pass criterion **cannot pass** — the report will say so.
Relay that honestly rather than calling it a pass.

### 13. Benchmark where appropriate

`esp32_component_benchmark`

Always distinguish the two figures:
- `measuredMaximum` — what this setup sustained. A **floor** on the hardware capability.
- `documentedMaximum` — the datasheet figure, unverified here.

Never say "the maximum rate is X" from a measurement. Say "we sustained X; the
datasheet claims Y; we have not tested the limit."

### 14. Capture raw observations

Every report retains raw bytes alongside its interpretation. Quote raw hex when it
supports a claim — it lets the user check your reasoning.

### 15. Validate results

Ask: does the evidence actually support the conclusion? A single read proves a value
at one moment, not that it is stable. If stability matters, run
`esp32_hardware_experiment` with `repetitions`.

### 16. Build the capability matrix

Present it as a table with the tiers separated:

| Capability | Documented | Software | Firmware | Observed | Verified | Status |
|-----------|-----------|----------|----------|----------|----------|--------|
| interface.i2c | YES | YES | NO | YES | YES | VERIFIED |
| protocol.felica | YES | YES | NO | NO | NO | UNTESTED |
| mode.card_emulation | YES | NO | NO | NO | NO | UNTESTED |

### 17. Identify capability gaps

Report each gap with its exact meaning:

- **POTENTIAL_EXTENSION** — documented + software exists + firmware does not expose it. A development opportunity. **Not a verified capability.**
- **SOFTWARE_GAP** — documented, no known driver. Tooling availability only.
- **UNDOCUMENTED_OBSERVATION** — seen but not in any documentation held. Not a specification.
- **UNVERIFIED_CLAIM** — documented and firmware-exposed, never measured. Two claims agreeing is still zero measurements.
- **UNEXPLORED** — documented, nothing else. Unknown, not unsupported.

### 18. Identify unexplored capabilities

Say plainly what has not been touched and what it would take to touch it.

### 19. Only then propose firmware development

Not before. A firmware proposal grounded in a real baseline is useful; one grounded
in a datasheet reading is a guess with extra steps.

## Adaptive investigation

The MCP does no reasoning — you do. It provides expressive primitives and returns
rich observations, and you close the loop:

```
OBSERVE -> HYPOTHESISE -> EXPERIMENT -> OBSERVE -> COMPARE -> HYPOTHESISE -> ...
```

Nothing requires the whole investigation to be planned up front. Run a small
sequence, read the raw bytes, and let the result shape the next call. When a
response surprises you, that is the interesting part — retain it and investigate
further rather than discarding it as noise.

A response that no documentation explains is an **UNDOCUMENTED OBSERVATION**. It
is real data. Report it as observed, not as specification.

---

## Running an experiment

Use `esp32_hardware_experiment` when the question is about behaviour over time,
stability, or a specific hypothesis:

```json
{
  "objective": "Establish whether the PN532 identity response is stable across repeats",
  "targetComponent": "pn532",
  "interface": "I2C",
  "address": 36,
  "hypothesis": "GetFirmwareVersion returns a byte-identical response on every call",
  "expectedResult": "D5 03 32 01 06 07 on all repetitions",
  "procedure": [{ "probeId": "pn532.firmware_version", "critical": true }],
  "repetitions": 10
}
```

Read `validation.hypothesisSupported` carefully — it is three-valued:
- `true` — every expectation matched
- `false` — none matched, **or only some did**. A partial match is not support.
- `null` — data came back but no objective criterion existed. Not a pass.

---

## Reporting style

**Do this:**

> The device at 0x24 returned `01 00 00 FF 06 FA D5 03 32 01 06 07` to a
> GetFirmwareVersion command. The `D5 03 32` signature matches the documented PN532
> response (IC 0x32, firmware 1.6). Identification confidence: HIGH.
>
> Its I2C interface is VERIFIED — a functional test exercised it and it behaved as
> expected. FeliCa, ISO14443-B and peer-to-peer are DOCUMENTED by the datasheet and
> supported by available libraries, but nothing has exercised them on this unit and
> the current firmware does not expose them. They are POTENTIAL EXTENSIONS, not
> verified capabilities.
>
> Card emulation is a SOFTWARE GAP: documented by the part, no driver known here.

**Not this:**

> Found a PN532 at 0x24. It supports ISO14443-A/B, FeliCa, MIFARE and peer-to-peer,
> and can do card emulation.

The second version states five things that have not been measured as though they
had been.

## When something fails

Report the failure mode specifically, and do not over-read it:

- **Nothing responded** — check pull-ups, wiring, power, pin assignment. Silence is not proof of absence.
- **Agent absent** — the firmware is not flashed, or another process holds the port.
- **Bus errors** — pull-ups, bus contention, or wrong voltage domain.
- **Degenerate SPI response** (all 0x00 / all 0xFF) — that is a floating MISO line, not data.
- **Empty UART capture** — an idle device, wrong baud, swapped TX/RX and a missing common ground all look identical from here.
- **Operation rejected** — read the rejection `kind`. It names a physical reason (`PIN_RESERVED`, `PIN_NOT_ADC_CAPABLE`, `PARAMETER_OUT_OF_RANGE`, ...) and often a remedy. It never means "not allowed to try".
- **`UNSUPPORTED_BY_AGENT`** — the firmware build lacks that operation. Check `esp32_pin_capabilities` → `unavailable`, and reflash the agent if needed.

Never present a failure as a finding about the component when it is equally
explicable as a wiring fault.
