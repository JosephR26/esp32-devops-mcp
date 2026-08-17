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

/**
 * MCP Server instance
 */
const server = new Server(
  {
    name: 'esp32-devops-mcp',
    version: '1.2.0',
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
        profiles: {
          type: 'array',
          items: { type: 'string', enum: ['IDLE_READ', 'ZERO_READ', 'JEDEC_ID'] },
          description: 'Named probe profiles to run (default: ["IDLE_READ","ZERO_READ"])',
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
      'ACTIVE mode requires a named component whose profile declares exactly what may be sent.',
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
        dataBits: { type: 'number', description: 'Data bits, 7 or 8 (default: 8)', default: 8 },
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
          description: 'Flow control — only "none" is supported',
          default: 'none',
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
      'STAGE 7-8 (REGISTER DISCOVERY, CONFIGURATION INSPECTION). READ-ONLY inspection of the ' +
      'documented registers declared by a component profile. Returns register address, name, raw ' +
      'value, hex, binary, decoded bitfields with their meanings, documented reset value, current ' +
      'value, whether it has changed from reset, documentation reference and confidence. ' +
      'Registers that are write-only, clear-on-read, or marked unsafe are SKIPPED with the reason ' +
      'stated. This tool has no write path — not behind a flag, not behind a depth.',
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
            'Register names or addresses to read (optional — reads every safe register if omitted)',
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
      required: ['component'],
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
  console.error('Version: 1.2.0');
  console.error(`Tools registered: ${tools.length}`);
  console.error('Toolkit path:', process.env.FIRMWARE_TOOLKIT_PATH || '[NOT SET - required for benchmarking/testing features]');
  console.error('Hardware interrogation requires the agent firmware (firmware/interrogation-agent/) and pyserial.');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
