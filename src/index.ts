#!/usr/bin/env node

/**
 * ESP32 DevOps MCP Server
 * AI-powered ESP32 development automation for Claude Code
 *
 * @author JosephR26
 * @license MIT
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// Import tool modules
import * as serialTools from './tools/serial.js';
import * as buildTools from './tools/build.js';
import * as benchmarkTools from './tools/benchmark.js';
import * as testTools from './tools/test.js';
import * as projectTools from './tools/project.js';
import * as logTools from './tools/logs.js';
import * as otaTools from './tools/ota.js';
import * as hardwareTools from './tools/hardware.js';
import * as componentTools from './tools/component.js';
import * as executeTools from './tools/execute.js';
import { buildSummary } from './utils/build-info.js';

/**
 * MCP Server instance
 */
const server = new Server(
  {
    name: 'esp32-devops-mcp',
    version: '1.3.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

/**
 * Tool definitions
 */
const tools = [
  // Serial Port Management Tools
  {
    name: 'esp32_list_ports',
    description: 'List all available ESP32 serial ports with detection, favorites, and recommendations',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'esp32_detect_ports',
    description: 'Auto-detect ESP32 devices on serial ports',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'esp32_set_default_port',
    description: 'Set default serial port for ESP32 development',
    inputSchema: {
      type: 'object',
      properties: {
        port: {
          type: 'string',
          description: 'Serial port name (e.g., COM3, /dev/ttyUSB0)',
        },
      },
      required: ['port'],
    },
  },
  {
    name: 'esp32_add_favorite_port',
    description: 'Add a serial port to favorites with optional custom name',
    inputSchema: {
      type: 'object',
      properties: {
        port: {
          type: 'string',
          description: 'Serial port name',
        },
        name: {
          type: 'string',
          description: 'Custom name for this port (optional)',
        },
      },
      required: ['port'],
    },
  },
  {
    name: 'esp32_get_recommended_port',
    description: 'Get recommended serial port (default > last used > auto-detected)',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  // Build & Flash Tools
  {
    name: 'esp32_build',
    description: 'Build ESP32 firmware using PlatformIO with detailed output including memory usage',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Path to PlatformIO project (optional, uses current directory if not specified)',
        },
        environment: {
          type: 'string',
          description: 'PlatformIO environment name (optional, uses default if not specified)',
        },
      },
      required: [],
    },
  },
  {
    name: 'esp32_flash',
    description: 'Flash compiled firmware to ESP32 device',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Path to PlatformIO project (optional)',
        },
        port: {
          type: 'string',
          description: 'Serial port to flash to (optional, uses recommended port if not specified)',
        },
      },
      required: [],
    },
  },
  {
    name: 'esp32_full_cycle',
    description: 'Complete development cycle: build, flash, and monitor in one command',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Path to PlatformIO project (optional)',
        },
        port: {
          type: 'string',
          description: 'Serial port (optional)',
        },
      },
      required: [],
    },
  },
  {
    name: 'esp32_clean',
    description: 'Clean build artifacts and cache',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Path to PlatformIO project (optional)',
        },
      },
      required: [],
    },
  },

  // Performance & Benchmarking Tools
  {
    name: 'esp32_benchmark',
    description: 'Run comprehensive performance benchmark on ESP32 firmware (memory, loop timing, WiFi)',
    inputSchema: {
      type: 'object',
      properties: {
        port: {
          type: 'string',
          description: 'Serial port (optional)',
        },
        duration: {
          type: 'number',
          description: 'Benchmark duration in seconds (default: 60, max: 3600)',
          default: 60,
        },
        baudRate: {
          type: 'number',
          description: 'Baud rate (default: 115200)',
          default: 115200,
        },
      },
      required: [],
    },
  },
  {
    name: 'esp32_quick_benchmark',
    description: 'Quick 30-second performance check',
    inputSchema: {
      type: 'object',
      properties: {
        port: {
          type: 'string',
          description: 'Serial port (optional)',
        },
      },
      required: [],
    },
  },
  {
    name: 'esp32_detect_memory_leaks',
    description: 'Run extended test to detect memory leaks (5 minute default)',
    inputSchema: {
      type: 'object',
      properties: {
        port: {
          type: 'string',
          description: 'Serial port (optional)',
        },
        duration: {
          type: 'number',
          description: 'Test duration in seconds (default: 300)',
          default: 300,
        },
      },
      required: [],
    },
  },

  // Project Lifecycle Tools
  {
    name: 'esp32_create_project',
    description: 'Scaffold a new PlatformIO ESP32 project with a starter template',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Project name (letters, numbers, underscores, hyphens)',
        },
        projectPath: {
          type: 'string',
          description: 'Parent directory for the new project (optional, defaults to cwd)',
        },
        board: {
          type: 'string',
          description: 'PlatformIO board ID (default: esp32dev)',
          default: 'esp32dev',
        },
        template: {
          type: 'string',
          description: 'Starter template: bare | wifi | ble | mqtt (default: bare)',
          enum: ['bare', 'wifi', 'ble', 'mqtt'],
          default: 'bare',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'esp32_validate_project',
    description: 'Validate a PlatformIO project structure and report missing files or misconfigurations',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Path to PlatformIO project (optional, uses cwd)',
        },
      },
      required: [],
    },
  },
  {
    name: 'esp32_list_libraries',
    description: 'Search the PlatformIO library registry or list installed libraries',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search term (optional)',
        },
        installed: {
          type: 'boolean',
          description: 'List installed libraries instead of searching registry (default: false)',
          default: false,
        },
      },
      required: [],
    },
  },
  {
    name: 'esp32_run_tests',
    description: 'Run PlatformIO unit tests and return structured pass/fail results',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Path to PlatformIO project (optional)',
        },
        environment: {
          type: 'string',
          description: 'PlatformIO environment to test (optional)',
        },
        filter: {
          type: 'string',
          description: 'Test name filter pattern (optional, e.g. "test_sensor*")',
        },
      },
      required: [],
    },
  },

  // Log Analysis Tools
  {
    name: 'esp32_parse_logs',
    description: 'Parse a saved ESP32 serial log file into structured entries with severity, tag, timestamp, and panic detection',
    inputSchema: {
      type: 'object',
      properties: {
        logPath: {
          type: 'string',
          description: 'Absolute or relative path to the log file',
        },
      },
      required: ['logPath'],
    },
  },

  // OTA & Network Tools
  {
    name: 'esp32_generate_ota_image',
    description: 'Package the built firmware.bin for OTA deployment — returns path, size, MD5, and SHA-256',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Path to PlatformIO project (optional)',
        },
        environment: {
          type: 'string',
          description: 'PlatformIO environment whose firmware to package (optional, auto-detected)',
        },
        outputPath: {
          type: 'string',
          description: 'Directory to copy the OTA image into (optional)',
        },
      },
      required: [],
    },
  },
  {
    name: 'esp32_list_network_devices',
    description: 'Discover ESP32 devices on the local network via mDNS (avahi/dns-sd) with ARP fallback',
    inputSchema: {
      type: 'object',
      properties: {
        timeout: {
          type: 'number',
          description: 'Discovery timeout in milliseconds (default: 5000)',
          default: 5000,
        },
      },
      required: [],
    },
  },

  // Firmware Testing Tools
  {
    name: 'esp32_test_firmware',
    description: 'Run automated firmware tests (boot, heartbeat, memory stability)',
    inputSchema: {
      type: 'object',
      properties: {
        port: {
          type: 'string',
          description: 'Serial port (optional)',
        },
        baudRate: {
          type: 'number',
          description: 'Baud rate (default: 115200)',
          default: 115200,
        },
      },
      required: [],
    },
  },
  {
    name: 'esp32_validate_deployment',
    description: 'Pre-deployment validation - run all tests and report deployment readiness',
    inputSchema: {
      type: 'object',
      properties: {
        port: {
          type: 'string',
          description: 'Serial port (optional)',
        },
      },
      required: [],
    },
  },

  // ==========================================================================
  // Hardware Interrogation Tools (v1.2.0)
  //
  // Pipeline: ESP32 IDENTIFICATION -> INTERFACE DISCOVERY -> BUS DISCOVERY
  // -> DEVICE DETECTION -> FINGERPRINTING -> COMPONENT IDENTIFICATION
  // -> REGISTER/PROTOCOL DISCOVERY -> CONFIGURATION INSPECTION
  // -> CAPABILITY ENUMERATION -> SAFE FUNCTIONAL TESTING -> TELEMETRY CAPTURE
  // -> PERFORMANCE CHARACTERISATION -> CAPABILITY MATRIX
  // -> DOCUMENTED vs OBSERVED vs VERIFIED -> UNEXPLORED CAPABILITY ANALYSIS
  //
  // All of these require the interrogation agent firmware
  // (firmware/interrogation-agent/) running on the target.
  // ==========================================================================
  {
    name: 'esp32_hardware_inventory',
    description:
      'STAGE 1 (ESP32 IDENTIFICATION). Comprehensive inventory of the ESP32 target: chip family, ' +
      'model, revision, architecture, cores, CPU frequency, flash, PSRAM, MAC, silicon features, ' +
      'reset reason, boot info, firmware/app identity and version, SDK/framework, PlatformIO ' +
      'environment, serial interface, USB-UART bridge, GPIO/ADC/DAC/PWM/touch/timer/I2C/SPI/UART ' +
      'counts, Wi-Fi and Bluetooth. Every field carries its confidence and evidence source, and ' +
      'anything that cannot be determined is returned as UNKNOWN rather than guessed. ' +
      'Datasheet-derived values are labelled DOCUMENTED and are never presented as measurements.',
    inputSchema: {
      type: 'object',
      properties: {
        port: { type: 'string', description: 'Serial port (optional, uses recommended port)' },
        projectPath: {
          type: 'string',
          description: 'PlatformIO project directory to read platformio.ini from (optional)',
        },
      },
      required: [],
    },
  },
  {
    name: 'esp32_interface_discovery',
    description:
      'STAGE 2 (INTERFACE DISCOVERY). Survey the interfaces the target offers — I2C, SPI, UART, ' +
      'GPIO, ADC, DAC, PWM, TOUCH — reporting available controllers, pins, current configuration, ' +
      'configured peripherals, conflicts, availability and warnings. Read-only: no GPIO is ' +
      'configured and no unknown pin is driven.',
    inputSchema: {
      type: 'object',
      properties: {
        port: { type: 'string', description: 'Serial port (optional)' },
        interfaces: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Restrict the survey to these interface kinds (optional, e.g. ["I2C","SPI"])',
        },
      },
      required: [],
    },
  },
  {
    name: 'esp32_i2c_scan',
    description:
      'STAGE 3-5 (BUS DISCOVERY, DEVICE DETECTION, FINGERPRINTING). Comprehensive I2C scan. ' +
      'Returns every responding address in hex and decimal, ACK result, response timing, scan ' +
      'duration, errors and bus errors. Distinguishes RESPONDS / NO_RESPONSE / BUS_ERROR / ' +
      'UNSTABLE / ADDRESS_CONFLICT / RESERVED_SKIPPED. Optionally performs a safe fingerprint ' +
      '(a plain read, no command bytes) on each responder. Address-based profile matches are ' +
      'returned as LOW-confidence hints only — an I2C address never identifies a device.',
    inputSchema: {
      type: 'object',
      properties: {
        port: { type: 'string', description: 'Serial port (optional)' },
        controller: { type: 'number', description: 'I2C controller index (default: 0)', default: 0 },
        sda: { type: 'number', description: 'SDA GPIO (optional, uses the board default)' },
        scl: { type: 'number', description: 'SCL GPIO (optional, uses the board default)' },
        frequencyHz: {
          type: 'number',
          description: 'Bus frequency in Hz, 1000-1000000 (default: 100000)',
          default: 100000,
        },
        startAddress: { type: 'number', description: 'First address to probe (default: 8)', default: 8 },
        endAddress: { type: 'number', description: 'Last address to probe (default: 119)', default: 119 },
        repeats: {
          type: 'number',
          description: 'Probes per address, 1-8. More repeats detect unstable devices (default: 3)',
          default: 3,
        },
        fingerprint: {
          type: 'boolean',
          description: 'Perform a safe read-only fingerprint of each responder (default: true)',
          default: true,
        },
        timeoutMs: { type: 'number', description: 'Request timeout in ms (optional)' },
      },
      required: [],
    },
  },
  {
    name: 'esp32_spi_discovery',
    description:
      'STAGE 3-5 for SPI. Probes an SPI device using explicit, named profiles only — IDLE_READ ' +
      '(clocks 0xFF), ZERO_READ (clocks 0x00), JEDEC_ID (standard read-only 0x9F identification) ' +
      '— or the safe probes of a named component profile. Arbitrary command sequences are not ' +
      'supported by design. Returns raw bytes, hex, repeated patterns, protocol signatures, ' +
      'timing and confidence. All-0x00/all-0xFF responses are flagged as degenerate (a floating ' +
      'MISO line), not reported as data. A chip-select pin is REQUIRED — this tool never asserts ' +
      'an unspecified CS.',
    inputSchema: {
      type: 'object',
      properties: {
        port: { type: 'string', description: 'Serial port (optional)' },
        mosi: { type: 'number', description: 'MOSI GPIO' },
        miso: { type: 'number', description: 'MISO GPIO' },
        sclk: { type: 'number', description: 'SCLK GPIO' },
        cs: { type: 'number', description: 'Chip-select GPIO (REQUIRED)' },
        mode: { type: 'number', description: 'SPI mode 0-3 (default: 0)', default: 0 },
        clockHz: {
          type: 'number',
          description: 'Clock in Hz, 10000-40000000 (default: 1000000)',
          default: 1000000,
        },
        bitOrder: {
          type: 'string',
          enum: ['MSB_FIRST', 'LSB_FIRST'],
          description: 'Bit order (default: MSB_FIRST)',
          default: 'MSB_FIRST',
        },
        tx: {
          type: 'array',
          items: { type: 'number' },
          description:
            'Arbitrary bytes to clock out. Any values are accepted — this is the ' +
            'general-purpose path and needs no preset and no component profile. Supplying ' +
            'this suppresses the default presets.',
        },
        readLength: {
          type: 'number',
          description: 'Extra bytes to clock in after `tx`, filled with `padByte`',
        },
        padByte: {
          type: 'number',
          description: 'Filler byte clocked out during the read phase (default: 0x00)',
        },
        profiles: {
          type: 'array',
          items: { type: 'string', enum: ['IDLE_READ', 'ZERO_READ', 'JEDEC_ID'] },
          description:
            'Convenience presets for common opening moves (default: ["IDLE_READ","ZERO_READ"] ' +
            'when no `tx` is given). These are shortcuts, not a restriction — use `tx` for ' +
            'anything else.',
        },
        component: {
          type: 'string',
          description: 'Component profile id whose SPI safe probes should also run (optional)',
        },
        transactionSize: {
          type: 'number',
          description: 'Bytes per transaction, 1-256 (default: 4)',
          default: 4,
        },
        timeoutMs: { type: 'number', description: 'Request timeout in ms (optional)' },
      },
      required: ['cs'],
    },
  },
  {
    name: 'esp32_uart_discovery',
    description:
      'STAGE 3-5 for UART. Passive-first interrogation: captures raw bytes, hex, ASCII where ' +
      'valid, per-packet timestamps and boundaries, repeated patterns, baud clues and protocol ' +
      'candidates (NMEA 0183, UBX, AT, PN532 framing). Optionally scans common baud rates ' +
      'passively to find the working rate. Defaults to PASSIVE mode — nothing is transmitted. ' +
      'ACTIVE mode sends whatever you put in `transmit` (any bytes), or the UART probes of a ' +
      'named component profile.',
    inputSchema: {
      type: 'object',
      properties: {
        port: { type: 'string', description: 'Serial port (optional)' },
        controller: {
          type: 'number',
          description: 'UART controller 1 or 2 (UART0 carries the agent link) (default: 1)',
          default: 1,
        },
        rx: { type: 'number', description: 'RX GPIO (REQUIRED)' },
        tx: { type: 'number', description: 'TX GPIO (optional, only needed for ACTIVE mode)' },
        baud: { type: 'number', description: 'Baud rate, 300-3000000 (default: 9600)', default: 9600 },
        dataBits: { type: 'number', description: 'Data bits, 5-8 (default: 8)', default: 8 },
        parity: {
          type: 'string',
          enum: ['none', 'even', 'odd'],
          description: 'Parity (default: none)',
          default: 'none',
        },
        stopBits: { type: 'number', description: 'Stop bits, 1 or 2 (default: 1)', default: 1 },
        flowControl: {
          type: 'string',
          enum: ['none'],
          description:
            'Flow control. Only "none" is available — the agent does not implement RTS/CTS.',
          default: 'none',
        },
        transmit: {
          type: 'array',
          items: { type: 'number' },
          description:
            'Arbitrary bytes to send in ACTIVE mode. Any byte sequence is accepted — no ' +
            'component profile or documented command set is required.',
        },
        readLength: {
          type: 'number',
          description: 'Bytes to read back after transmitting (default: 64)',
        },
        durationMs: {
          type: 'number',
          description: 'Capture duration in ms, up to 30000 (default: 3000)',
          default: 3000,
        },
        mode: {
          type: 'string',
          enum: ['PASSIVE', 'ACTIVE'],
          description: 'PASSIVE listens only; ACTIVE also runs profile probes (default: PASSIVE)',
          default: 'PASSIVE',
        },
        component: { type: 'string', description: 'Component profile id (required for ACTIVE mode)' },
        scanBauds: {
          type: 'boolean',
          description: 'Passively try common baud rates and pick the most structured (default: false)',
          default: false,
        },
        timeoutMs: { type: 'number', description: 'Request timeout in ms (optional)' },
      },
      required: ['rx'],
    },
  },
  {
    name: 'esp32_component_identify',
    description:
      'STAGE 6 (COMPONENT IDENTIFICATION). Identifies a component from bus address, safe probe ' +
      'responses, chip/manufacturer/part/revision IDs, register signatures, protocol signatures, ' +
      'response patterns and user-supplied markings. Returns the likely component, alternatives, ' +
      'evidence, confidence and identification method. An identification resting only on a bus ' +
      'address is capped at LOW confidence, and two close candidates are reported as AMBIGUOUS — ' +
      'an uncertain identification is never reported as certain.',
    inputSchema: {
      type: 'object',
      properties: {
        port: { type: 'string', description: 'Serial port (optional)' },
        interface: {
          type: 'string',
          enum: ['I2C', 'SPI', 'UART'],
          description: 'Interface to interrogate (default: I2C)',
          default: 'I2C',
        },
        address: { type: 'number', description: 'I2C address the device responded on (optional)' },
        candidates: {
          type: 'array',
          items: { type: 'string' },
          description: 'Restrict identification to these component profile ids (optional)',
        },
        markings: {
          type: 'array',
          items: { type: 'string' },
          description: 'Text printed on the physical part or board (optional but valuable)',
        },
        depth: {
          type: 'string',
          enum: ['BASIC', 'STANDARD', 'DEEP', 'FORENSIC'],
          description: 'How many identification probes to run (default: BASIC)',
          default: 'BASIC',
        },
        sda: { type: 'number', description: 'SDA GPIO (I2C)' },
        scl: { type: 'number', description: 'SCL GPIO (I2C)' },
        frequencyHz: { type: 'number', description: 'I2C frequency in Hz' },
        mosi: { type: 'number', description: 'MOSI GPIO (SPI)' },
        miso: { type: 'number', description: 'MISO GPIO (SPI)' },
        sclk: { type: 'number', description: 'SCLK GPIO (SPI)' },
        cs: { type: 'number', description: 'Chip-select GPIO (SPI, required for SPI)' },
        mode: { type: 'number', description: 'SPI mode 0-3' },
        clockHz: { type: 'number', description: 'SPI clock in Hz' },
        rx: { type: 'number', description: 'RX GPIO (UART, required for UART)' },
        tx: { type: 'number', description: 'TX GPIO (UART)' },
        baud: { type: 'number', description: 'UART baud rate' },
        timeoutMs: { type: 'number', description: 'Request timeout in ms (optional)' },
      },
      required: [],
    },
  },
  {
    name: 'esp32_component_probe',
    description:
      'CORE INTERROGATION TOOL (stages 6-11). Runs the full pipeline against one component at a ' +
      'chosen depth. BASIC: connectivity, identification, interface. STANDARD: + configuration, ' +
      'known registers, supported modes, protocols, capability matrix. DEEP: + every safe ' +
      'documented readable register, configuration and status state, feature discovery, timing. ' +
      'FORENSIC: + repeated measurements, consistency checks, response fingerprinting, ' +
      'undocumented-but-observed behaviour, anomaly detection and capability gap analysis. ' +
      'FORENSIC means deeper observation, NOT destructive action — no depth enables a register ' +
      'write. Raw bytes are preserved alongside every interpretation, and the report includes a ' +
      'full reproducibility record.',
    inputSchema: {
      type: 'object',
      properties: {
        port: { type: 'string', description: 'Serial port (optional)' },
        component: {
          type: 'string',
          description:
            'Component profile id, part number or alias (optional — identification runs if omitted)',
        },
        interface: {
          type: 'string',
          enum: ['I2C', 'SPI', 'UART'],
          description: 'Interface to interrogate (default: I2C)',
          default: 'I2C',
        },
        depth: {
          type: 'string',
          enum: ['BASIC', 'STANDARD', 'DEEP', 'FORENSIC'],
          description: 'Interrogation depth (default: STANDARD)',
          default: 'STANDARD',
        },
        address: { type: 'number', description: 'I2C address (optional, uses the profile default)' },
        markings: {
          type: 'array',
          items: { type: 'string' },
          description: 'Text printed on the physical part (optional)',
        },
        sda: { type: 'number', description: 'SDA GPIO (I2C)' },
        scl: { type: 'number', description: 'SCL GPIO (I2C)' },
        frequencyHz: { type: 'number', description: 'I2C frequency in Hz' },
        mosi: { type: 'number', description: 'MOSI GPIO (SPI)' },
        miso: { type: 'number', description: 'MISO GPIO (SPI)' },
        sclk: { type: 'number', description: 'SCLK GPIO (SPI)' },
        cs: { type: 'number', description: 'Chip-select GPIO (SPI, required for SPI)' },
        mode: { type: 'number', description: 'SPI mode 0-3' },
        clockHz: { type: 'number', description: 'SPI clock in Hz' },
        bitOrder: { type: 'string', enum: ['MSB_FIRST', 'LSB_FIRST'], description: 'SPI bit order' },
        rx: { type: 'number', description: 'RX GPIO (UART, required for UART)' },
        tx: { type: 'number', description: 'TX GPIO (UART)' },
        baud: { type: 'number', description: 'UART baud rate' },
        timeoutMs: { type: 'number', description: 'Request timeout in ms (optional)' },
      },
      required: [],
    },
  },
  {
    name: 'esp32_register_inspect',
    description:
      'Register inspection and controlled register writing. Reads are the default and need NO ' +
      'component profile: name numeric `registers` and get raw values back. Supply a ' +
      '`component` and the same values are decoded into named bitfields with reset-value ' +
      'comparison — a profile is a decoder, not a permission. Registers a profile does not ' +
      'describe are still read, raw. WRITES: supply `writes` to perform explicit register ' +
      'writes as experiments — entering a mode, selecting a bank, triggering a measurement, ' +
      'clearing status, or testing undocumented behaviour. Each write records the bytes sent, ' +
      'the bus acknowledgement, the value read immediately before, and (unless disabled) the ' +
      'state read back afterwards. A bus ACK confirms the device accepted the bytes; it does ' +
      'NOT establish that the device did what you intended — read back and compare.',
    inputSchema: {
      type: 'object',
      properties: {
        component: { type: 'string', description: 'Component profile id, part number or alias' },
        port: { type: 'string', description: 'Serial port (optional)' },
        interface: {
          type: 'string',
          enum: ['I2C', 'SPI', 'UART'],
          description: 'Interface to read over (default: I2C)',
          default: 'I2C',
        },
        address: { type: 'number', description: 'I2C address (optional, uses the profile default)' },
        registers: {
          type: 'array',
          items: { type: ['string', 'number'] },
          description:
            'Register names (needs a profile) or numeric addresses (needs nothing). Omit to read ' +
            'every register the profile declares.',
        },
        writes: {
          type: 'array',
          description:
            'Explicit register writes to perform. Each is executed as requested and recorded ' +
            'with before/after state.',
          items: {
            type: 'object',
            properties: {
              register: { type: 'number', description: 'Register address 0-255' },
              value: {
                type: 'array',
                items: { type: 'number' },
                description: 'Value bytes to write after the register address',
              },
              justification: {
                type: 'string',
                description: 'Why this write is being made. Recorded verbatim in the report.',
              },
            },
            required: ['register', 'value'],
          },
        },
        readBackAfterWrite: {
          type: 'boolean',
          description: 'Re-read the written registers afterwards (default: true)',
          default: true,
        },
        sda: { type: 'number', description: 'SDA GPIO (I2C)' },
        scl: { type: 'number', description: 'SCL GPIO (I2C)' },
        frequencyHz: { type: 'number', description: 'I2C frequency in Hz' },
        mosi: { type: 'number', description: 'MOSI GPIO (SPI)' },
        miso: { type: 'number', description: 'MISO GPIO (SPI)' },
        sclk: { type: 'number', description: 'SCLK GPIO (SPI)' },
        cs: { type: 'number', description: 'Chip-select GPIO (SPI, required for SPI)' },
        mode: { type: 'number', description: 'SPI mode 0-3' },
        clockHz: { type: 'number', description: 'SPI clock in Hz' },
        timeoutMs: { type: 'number', description: 'Request timeout in ms (optional)' },
      },
      required: [],
    },
  },
  {
    name: 'esp32_component_capabilities',
    description:
      'STAGE 14-16 (CAPABILITY MATRIX, DOCUMENTED vs OBSERVED vs VERIFIED, GAP ANALYSIS). Builds ' +
      'the capability matrix: for every capability, whether it is DOCUMENTED, SOFTWARE ' +
      'SUPPORTED, FIRMWARE EXPOSED, OBSERVED, TESTED and VERIFIED, with confidence and evidence. ' +
      'Derives the gaps: POTENTIAL_EXTENSION (documented + software + not exposed by firmware — ' +
      'a development opportunity, NOT a verified capability), SOFTWARE_GAP (documented, no ' +
      'driver), UNDOCUMENTED_OBSERVATION (seen but undocumented), UNVERIFIED_CLAIM and ' +
      'UNEXPLORED. Runs offline against documentation alone when no hardware is attached.',
    inputSchema: {
      type: 'object',
      properties: {
        component: { type: 'string', description: 'Component profile id, part number or alias' },
        port: { type: 'string', description: 'Serial port (optional)' },
        interface: {
          type: 'string',
          enum: ['I2C', 'SPI', 'UART'],
          description: 'Interface to interrogate (default: I2C)',
          default: 'I2C',
        },
        depth: {
          type: 'string',
          enum: ['BASIC', 'STANDARD', 'DEEP', 'FORENSIC'],
          description: 'Depth used for the live probe pass (default: DEEP)',
          default: 'DEEP',
        },
        offline: {
          type: 'boolean',
          description:
            'Skip all hardware access and report the documentation tier only (default: false)',
          default: false,
        },
        firmwareCapabilities: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Capability names the target firmware is known to expose. Firmware exposure cannot ' +
            'be discovered from the bus, so it is only ever set from this explicit statement.',
        },
        address: { type: 'number', description: 'I2C address (optional)' },
        sda: { type: 'number', description: 'SDA GPIO (I2C)' },
        scl: { type: 'number', description: 'SCL GPIO (I2C)' },
        frequencyHz: { type: 'number', description: 'I2C frequency in Hz' },
        cs: { type: 'number', description: 'Chip-select GPIO (SPI, required for SPI)' },
        mosi: { type: 'number', description: 'MOSI GPIO (SPI)' },
        miso: { type: 'number', description: 'MISO GPIO (SPI)' },
        sclk: { type: 'number', description: 'SCLK GPIO (SPI)' },
        mode: { type: 'number', description: 'SPI mode 0-3' },
        clockHz: { type: 'number', description: 'SPI clock in Hz' },
        rx: { type: 'number', description: 'RX GPIO (UART)' },
        tx: { type: 'number', description: 'TX GPIO (UART)' },
        baud: { type: 'number', description: 'UART baud rate' },
        timeoutMs: { type: 'number', description: 'Request timeout in ms (optional)' },
      },
      required: ['component'],
    },
  },
  {
    name: 'esp32_component_test',
    description:
      'STAGE 11-12 (SAFE FUNCTIONAL TESTING, TELEMETRY CAPTURE). Runs the capability-specific ' +
      'functional tests declared by a component profile — identification, communication, status ' +
      'reporting, sensor reads, protocol detection, register readback and so on. Every test ' +
      'records its objective, configuration, procedure, expected result, observed result, ' +
      'pass/fail, evidence, confidence and duration, and returns an updated capability matrix in ' +
      'which passing tests promote capabilities to VERIFIED.',
    inputSchema: {
      type: 'object',
      properties: {
        component: { type: 'string', description: 'Component profile id, part number or alias' },
        port: { type: 'string', description: 'Serial port (optional)' },
        interface: {
          type: 'string',
          enum: ['I2C', 'SPI', 'UART'],
          description: 'Interface to test over (default: I2C)',
          default: 'I2C',
        },
        tests: {
          type: 'array',
          items: { type: 'string' },
          description: 'Test ids or names to run (optional — runs every applicable test if omitted)',
        },
        depth: {
          type: 'string',
          enum: ['BASIC', 'STANDARD', 'DEEP', 'FORENSIC'],
          description: 'Depth gate for which tests may run (default: STANDARD)',
          default: 'STANDARD',
        },
        address: { type: 'number', description: 'I2C address (optional)' },
        sda: { type: 'number', description: 'SDA GPIO (I2C)' },
        scl: { type: 'number', description: 'SCL GPIO (I2C)' },
        frequencyHz: { type: 'number', description: 'I2C frequency in Hz' },
        cs: { type: 'number', description: 'Chip-select GPIO (SPI, required for SPI)' },
        mosi: { type: 'number', description: 'MOSI GPIO (SPI)' },
        miso: { type: 'number', description: 'MISO GPIO (SPI)' },
        sclk: { type: 'number', description: 'SCLK GPIO (SPI)' },
        mode: { type: 'number', description: 'SPI mode 0-3' },
        clockHz: { type: 'number', description: 'SPI clock in Hz' },
        rx: { type: 'number', description: 'RX GPIO (UART)' },
        tx: { type: 'number', description: 'TX GPIO (UART)' },
        baud: { type: 'number', description: 'UART baud rate' },
        timeoutMs: { type: 'number', description: 'Request timeout in ms (optional)' },
      },
      required: ['component'],
    },
  },
  {
    name: 'esp32_component_benchmark',
    description:
      'STAGE 13 (PERFORMANCE CHARACTERISATION). Measures response latency, transaction time, ' +
      'throughput, polling rate, repeated-read consistency, error rate and communication ' +
      'stability for a component. Reports min/max/mean/median/standard deviation and separates ' +
      'the MEASURED maximum (what this setup actually sustained, a floor on the hardware) from ' +
      'the DOCUMENTED maximum (the datasheet figure, unverified). It never claims a hardware ' +
      'limit from a measurement.',
    inputSchema: {
      type: 'object',
      properties: {
        component: { type: 'string', description: 'Component profile id, part number or alias' },
        port: { type: 'string', description: 'Serial port (optional)' },
        interface: {
          type: 'string',
          enum: ['I2C', 'SPI', 'UART'],
          description: 'Interface to benchmark over (default: I2C)',
          default: 'I2C',
        },
        benchmarks: {
          type: 'array',
          items: { type: 'string' },
          description: 'Benchmark ids or names to run (optional — runs all if omitted)',
        },
        iterations: {
          type: 'number',
          description:
            'Iterations per benchmark, 1-200. Capped at the profile limit for the component.',
        },
        address: { type: 'number', description: 'I2C address (optional)' },
        sda: { type: 'number', description: 'SDA GPIO (I2C)' },
        scl: { type: 'number', description: 'SCL GPIO (I2C)' },
        frequencyHz: { type: 'number', description: 'I2C frequency in Hz' },
        cs: { type: 'number', description: 'Chip-select GPIO (SPI, required for SPI)' },
        mosi: { type: 'number', description: 'MOSI GPIO (SPI)' },
        miso: { type: 'number', description: 'MISO GPIO (SPI)' },
        sclk: { type: 'number', description: 'SCLK GPIO (SPI)' },
        mode: { type: 'number', description: 'SPI mode 0-3' },
        clockHz: { type: 'number', description: 'SPI clock in Hz' },
        rx: { type: 'number', description: 'RX GPIO (UART)' },
        tx: { type: 'number', description: 'TX GPIO (UART)' },
        baud: { type: 'number', description: 'UART baud rate' },
        timeoutMs: { type: 'number', description: 'Request timeout in ms (optional)' },
      },
      required: ['component'],
    },
  },
  {
    name: 'esp32_hardware_experiment',
    description:
      'EXPERIMENT ORCHESTRATOR. Runs a complete experiment lifecycle — PREPARE, VERIFY ' +
      'CONFIGURATION, EXECUTE, OBSERVE, CAPTURE, VALIDATE, ANALYSE, REPEAT, REPORT — and returns ' +
      'a machine-readable report containing the objective, hypothesis, expected result, safety ' +
      'constraints, per-phase records, every raw observation, telemetry status, consistency ' +
      'analysis across repetitions, validation against the hypothesis, findings, anomalies, ' +
      'capability implications, conclusion, confidence, and a full reproducibility record ' +
      '(hardware, firmware version, MCP version, configuration, pins, bus, frequency, timestamp).',
    inputSchema: {
      type: 'object',
      properties: {
        objective: { type: 'string', description: 'What this experiment is meant to establish' },
        experimentId: { type: 'string', description: 'Stable id for the experiment (optional)' },
        targetComponent: {
          type: 'string',
          description: 'Component profile id whose safe probes the procedure draws on',
        },
        hypothesis: { type: 'string', description: 'What you expect and why (optional)' },
        expectedResult: { type: 'string', description: 'The concrete expected observation (optional)' },
        procedure: {
          type: 'array',
          description:
            'Ordered steps. Each names a safe probe from the target component profile. ' +
            'Defaults to every applicable probe when omitted.',
          items: {
            type: 'object',
            properties: {
              probeId: { type: 'string', description: 'Safe probe id from the component profile' },
              description: { type: 'string', description: 'What this step is for' },
              critical: {
                type: 'boolean',
                description: 'Abort the experiment if this step fails (default: false)',
              },
            },
            required: ['probeId'],
          },
        },
        safetyConstraints: {
          type: 'array',
          items: { type: 'string' },
          description: 'Additional constraints to record with the experiment',
        },
        telemetry: {
          type: 'array',
          description: 'Telemetry the experiment requires',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              required: { type: 'boolean' },
            },
            required: ['name'],
          },
        },
        repetitions: {
          type: 'number',
          description: 'How many times to run the procedure, 1-50 (default: 1)',
          default: 1,
        },
        interface: {
          type: 'string',
          enum: ['I2C', 'SPI', 'UART'],
          description: 'Interface under test (default: I2C)',
          default: 'I2C',
        },
        port: { type: 'string', description: 'Serial port (optional)' },
        address: { type: 'number', description: 'I2C address (optional)' },
        sda: { type: 'number', description: 'SDA GPIO (I2C)' },
        scl: { type: 'number', description: 'SCL GPIO (I2C)' },
        frequencyHz: { type: 'number', description: 'I2C frequency in Hz' },
        cs: { type: 'number', description: 'Chip-select GPIO (SPI, required for SPI)' },
        mosi: { type: 'number', description: 'MOSI GPIO (SPI)' },
        miso: { type: 'number', description: 'MISO GPIO (SPI)' },
        sclk: { type: 'number', description: 'SCLK GPIO (SPI)' },
        mode: { type: 'number', description: 'SPI mode 0-3' },
        clockHz: { type: 'number', description: 'SPI clock in Hz' },
        rx: { type: 'number', description: 'RX GPIO (UART)' },
        tx: { type: 'number', description: 'TX GPIO (UART)' },
        baud: { type: 'number', description: 'UART baud rate' },
        timeoutMs: { type: 'number', description: 'Request timeout in ms (optional)' },
      },
      required: ['objective'],
    },
  },
  {
    name: 'esp32_hardware_execute',
    description:
      'GENERAL-PURPOSE HARDWARE EXECUTION. Runs arbitrary operations you construct against the ' +
      'ESP32 as a physical instrument. Requires NO component profile, NO predefined probe and ' +
      'NO prior identification — this is the path for investigating a component beyond anything ' +
      'anticipated by this MCP. Supports: I2C scan/read/write/write-read with arbitrary bytes, ' +
      'repeated start and inter-phase delay; SPI transfer with arbitrary TX bytes, read length, ' +
      'mode, clock, bit order and CS control; UART write/read/write-read with arbitrary bytes ' +
      'and framing; GPIO configure/read/write/pulse/multi-pin sampling; pulse-width, frequency ' +
      'and edge-timing measurement; ADC sampling with interval and attenuation; PWM stimulus ' +
      'generation; and STIMULUS_CAPTURE, which drives one pin while sampling others on a shared ' +
      'timebase. An operation is refused ONLY when physically invalid on this chip (pin does ' +
      'not exist, is wired to flash, cannot drive an output, parameter out of the silicon\'s ' +
      'range, conflicting or malformed) — never because it was unanticipated. Raw agent ' +
      'responses are retained verbatim on every operation. A successful operation is OBSERVED ' +
      'evidence: it records what the device did, not what the device is.',
    inputSchema: {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          description:
            'Operations to run in order. Each has an `op` field selecting the kind. See the ' +
            'RawOperation type for the full shape of each.',
          items: {
            type: 'object',
            properties: {
              op: {
                type: 'string',
                enum: [
                  'I2C_SCAN', 'I2C_READ', 'I2C_WRITE', 'I2C_WRITE_READ',
                  'SPI_TRANSFER',
                  'UART_WRITE', 'UART_READ', 'UART_WRITE_READ',
                  'GPIO_CONFIGURE', 'GPIO_READ', 'GPIO_WRITE', 'GPIO_PULSE', 'GPIO_SAMPLE',
                  'GPIO_MEASURE_PULSE', 'GPIO_MEASURE_FREQUENCY', 'GPIO_WAIT_EDGE',
                  'ADC_READ',
                  'PWM_START', 'PWM_STOP',
                  'STIMULUS_CAPTURE',
                  'DELAY',
                ],
                description: 'Which operation to perform',
              },
              bus: {
                type: 'object',
                description: 'Per-operation bus configuration (pins, clock, mode, baud)',
              },
              address: { type: 'number', description: 'I2C address, 0x00-0x7F' },
              register: { type: 'number', description: 'Register pointer for I2C_READ' },
              length: { type: 'number', description: 'Bytes to read (I2C_READ)' },
              write: {
                type: 'array',
                items: { type: 'number' },
                description: 'Arbitrary bytes to send. Any values are accepted.',
              },
              readLength: { type: 'number', description: 'Bytes to read back' },
              delayMs: { type: 'number', description: 'Delay between write and read phases' },
              repeatedStart: {
                type: 'boolean',
                description: 'Emit a repeated START instead of a STOP between I2C phases',
              },
              tx: {
                type: 'array',
                items: { type: 'number' },
                description: 'Arbitrary SPI bytes to clock out',
              },
              padByte: { type: 'number', description: 'Filler byte for the SPI read phase' },
              keepCsAsserted: {
                type: 'boolean',
                description: 'Hold CS low across the whole SPI transfer (default true)',
              },
              pin: { type: 'number', description: 'Target GPIO for pin-oriented operations' },
              pins: {
                type: 'array',
                items: { type: 'number' },
                description: 'GPIOs to read or sample',
              },
              mode: {
                type: 'string',
                description: 'GPIO mode: INPUT, INPUT_PULLUP, INPUT_PULLDOWN, OUTPUT, OUTPUT_OPEN_DRAIN',
              },
              level: { type: 'number', description: 'Logic level 0 or 1' },
              durationUs: { type: 'number', description: 'Pulse width in microseconds' },
              returnToLevel: { type: 'number', description: 'Level to return to after a pulse' },
              samples: { type: 'number', description: 'Number of samples to take' },
              intervalUs: { type: 'number', description: 'Interval between samples' },
              timeoutUs: { type: 'number', description: 'Timeout for pulse measurement' },
              timeoutMs: { type: 'number', description: 'Timeout in milliseconds' },
              windowMs: { type: 'number', description: 'Measurement window for frequency counting' },
              edge: { type: 'string', enum: ['RISING', 'FALLING', 'CHANGE'] },
              durationMs: { type: 'number', description: 'Capture or output duration' },
              maxBytes: { type: 'number', description: 'Cap on captured UART bytes' },
              attenuationDb: {
                type: 'number',
                description: 'ADC attenuation: 0, 2.5, 6 or 11 dB (selects the input range)',
              },
              frequencyHz: { type: 'number', description: 'PWM frequency' },
              duty: { type: 'number', description: 'PWM duty as a fraction, 0.0-1.0' },
              resolutionBits: { type: 'number', description: 'PWM resolution, 1-20 bits' },
              stimulus: {
                type: 'object',
                description: 'Stimulus spec for STIMULUS_CAPTURE: pin, kind, level, durationUs, cycles',
              },
              capturePins: {
                type: 'array',
                items: { type: 'number' },
                description: 'Pins to sample while the stimulus runs',
              },
              ms: { type: 'number', description: 'Delay duration for DELAY' },
            },
            required: ['op'],
          },
        },
        defaults: {
          type: 'object',
          description:
            'Bus defaults merged into any operation omitting its own `bus`. Keys: i2c, spi, uart.',
          properties: {
            i2c: { type: 'object', description: 'controller, sda, scl, frequencyHz' },
            spi: { type: 'object', description: 'mosi, miso, sclk, cs, mode, clockHz, bitOrder' },
            uart: { type: 'object', description: 'controller, tx, rx, baud, dataBits, parity, stopBits' },
          },
        },
        repetitions: {
          type: 'number',
          description:
            'Run the whole sequence this many times, 1-100. Use this to judge stability — a ' +
            'single run cannot establish it.',
          default: 1,
        },
        stopOnError: {
          type: 'boolean',
          description: 'Stop at the first failure instead of continuing (default: false)',
          default: false,
        },
        port: { type: 'string', description: 'Serial port (optional)' },
        timeoutMs: { type: 'number', description: 'Per-operation timeout in ms (optional)' },
      },
      required: ['operations'],
    },
  },
  {
    name: 'esp32_pin_capabilities',
    description:
      'Report what every pin on this ESP32 can actually do — digital input/output, ADC, DAC, ' +
      'touch, PWM and GPIO-matrix routability — plus which pins are reserved and why, which are ' +
      'strapping pins, what the running firmware currently has allocated, and which agent ' +
      'capabilities are unavailable on this firmware build. Use this to plan an experiment ' +
      'instead of guessing pin assignments. The ESP32 GPIO matrix routes most peripheral ' +
      'signals to most pins, so bus assignments are far more flexible than a board silkscreen ' +
      'suggests. Pin capabilities are DOCUMENTED (datasheet-derived), not measured.',
    inputSchema: {
      type: 'object',
      properties: {
        port: { type: 'string', description: 'Serial port (optional)' },
        pins: {
          type: 'array',
          items: { type: 'number' },
          description: 'Restrict the report to these GPIOs (optional)',
        },
        filter: {
          type: 'string',
          enum: ['OUTPUT', 'ADC', 'DAC', 'TOUCH', 'PWM', 'USABLE'],
          description: 'Only report pins supporting this capability (optional)',
        },
      },
      required: [],
    },
  },
];

/**
 * List available tools
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools,
  };
});

/**
 * Handle tool execution
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    // Serial Port Tools
    if (name === 'esp32_list_ports') {
      const result = await serialTools.listSerialPorts();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === 'esp32_detect_ports') {
      const result = await serialTools.detectESP32Ports();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === 'esp32_set_default_port') {
      const result = await serialTools.setDefaultPort(args.port as string);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === 'esp32_add_favorite_port') {
      const result = await serialTools.addFavoritePort(
        args.port as string,
        args.name as string | undefined
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === 'esp32_get_recommended_port') {
      const result = await serialTools.getRecommendedPort();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    // Build & Flash Tools
    if (name === 'esp32_build') {
      const result = await buildTools.buildFirmware(
        args.projectPath as string | undefined,
        args.environment as string | undefined
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === 'esp32_flash') {
      const result = await buildTools.flashFirmware(
        args.projectPath as string | undefined,
        args.port as string | undefined
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === 'esp32_full_cycle') {
      const result = await buildTools.fullCycle(
        args.projectPath as string | undefined,
        args.port as string | undefined
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === 'esp32_clean') {
      const result = await buildTools.cleanBuild(
        args.projectPath as string | undefined
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    // Benchmark Tools
    if (name === 'esp32_benchmark') {
      const result = await benchmarkTools.runBenchmark(
        args.port as string | undefined,
        args.duration as number | undefined,
        args.baudRate as number | undefined
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === 'esp32_quick_benchmark') {
      const result = await benchmarkTools.quickBenchmark(
        args.port as string | undefined
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === 'esp32_detect_memory_leaks') {
      const result = await benchmarkTools.detectMemoryLeaks(
        args.port as string | undefined,
        args.duration as number | undefined
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    // Testing Tools
    if (name === 'esp32_test_firmware') {
      const result = await testTools.runFirmwareTests(
        args.port as string | undefined,
        args.baudRate as number | undefined
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === 'esp32_validate_deployment') {
      const result = await testTools.validateForDeployment(
        args.port as string | undefined
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

      // Project Lifecycle Tools
    if (name === 'esp32_create_project') {
      const result = await projectTools.createProject(
        args.name as string,
        args.projectPath as string | undefined,
        args.board as string | undefined,
        args.template as string | undefined
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    if (name === 'esp32_validate_project') {
      const result = await projectTools.validateProject(args.projectPath as string | undefined);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    if (name === 'esp32_list_libraries') {
      const result = await projectTools.listLibraries(
        args.query as string | undefined,
        args.installed as boolean | undefined
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    if (name === 'esp32_run_tests') {
      const result = await projectTools.runPlatformIOTests(
        args.projectPath as string | undefined,
        args.environment as string | undefined,
        args.filter as string | undefined
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    // Log Analysis Tools
    if (name === 'esp32_parse_logs') {
      const result = await logTools.parseSerialLogs(args.logPath as string);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    // OTA & Network Tools
    if (name === 'esp32_generate_ota_image') {
      const result = await otaTools.generateOTAImage(
        args.projectPath as string | undefined,
        args.environment as string | undefined,
        args.outputPath as string | undefined
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    if (name === 'esp32_list_network_devices') {
      const result = await otaTools.listNetworkDevices(args.timeout as number | undefined);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    // Hardware Interrogation Tools
    // Arguments are forwarded as-is; every handler validates its own inputs and
    // returns { success, error } rather than throwing.
    if (name === 'esp32_hardware_inventory') {
      const result = await hardwareTools.hardwareInventory(args as hardwareTools.HardwareInventoryOptions);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    if (name === 'esp32_interface_discovery') {
      const result = await hardwareTools.interfaceDiscovery(
        args as hardwareTools.InterfaceDiscoveryOptions
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    if (name === 'esp32_i2c_scan') {
      const result = await hardwareTools.i2cScan(args as hardwareTools.I2CScanOptions);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    if (name === 'esp32_spi_discovery') {
      const result = await hardwareTools.spiDiscovery(args as hardwareTools.SpiDiscoveryOptions);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    if (name === 'esp32_uart_discovery') {
      const result = await hardwareTools.uartDiscovery(args as hardwareTools.UartDiscoveryOptions);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    if (name === 'esp32_component_identify') {
      const result = await componentTools.componentIdentify(
        args as componentTools.ComponentIdentifyOptions
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    if (name === 'esp32_component_probe') {
      const result = await componentTools.componentProbe(
        args as componentTools.ComponentProbeOptions
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    if (name === 'esp32_register_inspect') {
      const result = await componentTools.registerInspect(
        args as unknown as componentTools.RegisterInspectOptions
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    if (name === 'esp32_component_capabilities') {
      const result = await componentTools.componentCapabilities(
        args as unknown as componentTools.ComponentCapabilitiesOptions
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    if (name === 'esp32_component_test') {
      const result = await componentTools.componentTest(
        args as unknown as componentTools.ComponentTestOptions
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    if (name === 'esp32_component_benchmark') {
      const result = await componentTools.componentBenchmark(
        args as unknown as componentTools.ComponentBenchmarkOptions
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    if (name === 'esp32_hardware_experiment') {
      const result = await componentTools.hardwareExperiment(
        args as unknown as componentTools.HardwareExperimentOptions
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    if (name === 'esp32_hardware_execute') {
      const result = await executeTools.hardwareExecute(
        args as unknown as executeTools.HardwareExecuteOptions
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    if (name === 'esp32_pin_capabilities') {
      const result = await executeTools.pinCapabilityReport(
        args as executeTools.PinCapabilityOptions
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    // Unknown tool
    throw new Error(`Unknown tool: ${name}`);

  } catch (error: any) {
    return {
      content: [
        {
            type: 'text',
          text: JSON.stringify({
            success: false,
            error: error.message,
          }, null, 2),
        },
      ],
      isError: true,
    };
  }
});

/**
 * Start the server
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('ESP32 DevOps MCP Server started');
  // Report the build that is RUNNING, not a hardcoded string. A compiled server keeps
  // serving the dist it loaded at startup, so after a rebuild the process can still be
  // executing old code — and an already-fixed bug reproduces, looking like a new one.
  console.error(`Build: ${buildSummary()}`);
  console.error(`Tools registered: ${tools.length}`);
  console.error('Toolkit path:', process.env.FIRMWARE_TOOLKIT_PATH || '[NOT SET - required for benchmarking/testing features]');
  console.error('Hardware interrogation requires the agent firmware (firmware/interrogation-agent/) and pyserial.');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
