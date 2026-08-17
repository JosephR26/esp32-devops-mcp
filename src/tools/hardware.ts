/**
 * Hardware interrogation tools — target identification, interface discovery and
 * bus scanning.
 *
 * Pipeline position:
 *   PHYSICAL TARGET -> ESP32 IDENTIFICATION -> INTERFACE DISCOVERY
 *   -> BUS DISCOVERY -> DEVICE DETECTION -> DEVICE FINGERPRINTING
 *
 * Every handler returns a plain object; nothing throws.
 */

import { readFile } from 'fs/promises';
import { join, resolve } from 'path';
import { fileExists } from '../utils/exec.js';
import {
  validateComponentIdentifier,
  validateDurationMs,
  validateGpioPin,
  validateI2CAddress,
  validateI2CFrequency,
  validateProbeBaudRate,
  validateByteArray,
  validateProjectPath,
  validateSpiClock,
  validateSpiMode,
} from '../utils/validation.js';
import {
  getFamilySpec,
  identifyUsbBridge,
  normaliseFamily,
} from '../hardware/esp32-catalog.js';
import {
  knownValue,
  makeEvidence,
  rawInterpretation,
  unknownValue,
} from '../hardware/evidence.js';
import { buildCapabilityMatrix, makeCapability } from '../hardware/capability.js';
import {
  findRepeatedPatterns,
  hexValue,
  isDegenerateResponse,
  toHex,
  toPrintableAscii,
} from '../hardware/patterns.js';
import { identifyComponent } from '../hardware/identify.js';
import { executeProbes, shouldRunProbe } from '../hardware/probe.js';
import { findProfile, hintsForI2CAddress } from '../hardware/registry.js';
import { agentUnavailableHelp, checkPins, openSession } from '../hardware/session.js';
import type {
  CapabilityRecord,
  ComponentMatchHint,
  DiscoveredInterface,
  Esp32Family,
  HardwareInterfaceKind,
  HardwareInventoryReport,
  I2CAddressResult,
  I2CAddressState,
  I2CScanReport,
  InterfaceDiscoveryReport,
  ObservedValue,
  PinAssignment,
  RawInterpretation,
  SpiBitOrder,
  SpiDiscoveryReport,
  SpiProbeResult,
  UartCapturePacket,
  UartDiscoveryReport,
} from '../types/hardware.js';

/** I2C addresses the specification reserves; scanning them is meaningless. */
const I2C_RESERVED = (address: number): boolean =>
  (address >= 0x00 && address <= 0x07) || (address >= 0x78 && address <= 0x7f);

/** Baud rates tried when a UART capture is asked to scan for the right rate. */
const COMMON_BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 4800, 230400];

// ===========================================================================
// 1. esp32_hardware_inventory
// ===========================================================================

export interface HardwareInventoryOptions {
  port?: string;
  projectPath?: string;
}

/**
 * Comprehensive inventory of the ESP32 development environment.
 *
 * Combines three evidence tiers and never mixes them up:
 *   - live agent readings (FIRMWARE_REPORT, physical)
 *   - the datasheet catalog (ESP32_CATALOG, documentation only)
 *   - host toolchain files such as platformio.ini (TOOLCHAIN_REPORT)
 *
 * Anything none of them answers is returned as UNKNOWN.
 */
export async function hardwareInventory(
  options: HardwareInventoryOptions = {}
): Promise<HardwareInventoryReport> {
  const { port: portOption, projectPath } = options;

  if (projectPath && !validateProjectPath(projectPath)) {
    return emptyInventory(unknownValue<string>('Invalid project path'), [
      'Invalid project path',
    ]);
  }

  const session = await openSession({ ...(portOption !== undefined ? { port: portOption } : {}) });
  const raw: RawInterpretation[] = [];
  const warnings: string[] = [];
  const sources: HardwareInventoryReport['sources'] = [];

  // --- Source 1: the interrogation agent ---------------------------------
  let info: Record<string, unknown> | null = null;
  if (session.agentPresent) {
    const response = await session.transport.request<Record<string, unknown>>('sys.info');
    if (response.ok && response.data) {
      info = response.data;
      raw.push(
        rawInterpretation(
          response.raw,
          response.data,
          'Interrogation agent sys.info response',
          'FIRMWARE_REPORT',
          'HIGH'
        )
      );
    } else {
      warnings.push(`sys.info failed: ${response.error ?? 'unknown error'}`);
    }
  } else {
    warnings.push(...agentUnavailableHelp(session.agentDetail, session.agentErrorKind));
  }
  sources.push({
    name: 'interrogation-agent',
    available: info !== null,
    detail: info !== null ? 'Live chip and firmware readings' : session.agentDetail,
  });

  const agentString = (key: string): ObservedValue<string> =>
    info && typeof info[key] === 'string' && info[key] !== ''
      ? knownValue(info[key] as string, 'FIRMWARE_REPORT', `sys.info.${key}`, 'HIGH')
      : unknownValue<string>(`Not reported by the interrogation agent (${key})`);

  const agentNumber = (key: string): ObservedValue<number> =>
    info && typeof info[key] === 'number'
      ? knownValue(info[key] as number, 'FIRMWARE_REPORT', `sys.info.${key}`, 'HIGH')
      : unknownValue<number>(`Not reported by the interrogation agent (${key})`);

  // --- Source 2: the datasheet catalog -----------------------------------
  const family: Esp32Family = normaliseFamily(
    (info?.family as string | undefined) ?? null
  );
  const spec = getFamilySpec(family);
  const catalogAvailable = family !== 'UNKNOWN';
  sources.push({
    name: 'esp32-catalog',
    available: catalogAvailable,
    detail: catalogAvailable
      ? `Datasheet peripheral counts for ${family}. Documentation, not measurement.`
      : 'Chip family unknown, so no catalog entry applies.',
  });
  if (catalogAvailable) {
    raw.push(
      rawInterpretation(
        JSON.stringify(spec),
        spec,
        `Datasheet catalog entry for ${family}. These are documented figures; nothing here ` +
          'has been measured on this unit.',
        'ESP32_CATALOG',
        'DOCUMENTED'
      )
    );
  }

  const catalogValue = <T>(value: T, label: string): ObservedValue<T> =>
    catalogAvailable
      ? knownValue(value, 'ESP32_CATALOG', `${family} datasheet: ${label}`, 'DOCUMENTED')
      : unknownValue<T>('Chip family unknown — no catalog data');

  // --- Source 3: host toolchain ------------------------------------------
  const pio = await readPlatformIO(projectPath);
  sources.push({
    name: 'platformio.ini',
    available: pio.environment.known,
    detail: pio.detail,
  });
  if (pio.raw) {
    raw.push(
      rawInterpretation(
        pio.raw,
        { environments: pio.environments },
        'platformio.ini contents',
        'TOOLCHAIN_REPORT',
        'MEDIUM'
      )
    );
  }

  // --- Source 4: host serial port enumeration ----------------------------
  const serial = await describeSerialPort(session.port.value);
  sources.push({
    name: 'host-serial-enumeration',
    available: serial.description.known,
    detail: serial.detail,
  });

  const report: HardwareInventoryReport = {
    // False when the agent was never reached. The report is still returned and still
    // useful — datasheet values, pin map, host enumeration — but nothing in it was
    // measured on this unit, and a caller keying off `success` must not be told
    // otherwise. Reporting success for a run that never contacted the target is how a
    // busy serial port comes to look like a healthy interrogation.
    success: session.agentPresent,
    port: session.port,
    sources,
    chip: {
      family: catalogAvailable
        ? knownValue(family, 'FIRMWARE_REPORT', 'Reported by the interrogation agent', 'HIGH')
        : unknownValue<Esp32Family>('Chip family could not be determined'),
      model: agentString('family'),
      revision:
        info && typeof info.revision === 'number'
          ? knownValue(String(info.revision), 'FIRMWARE_REPORT', 'sys.info.revision', 'HIGH')
          : unknownValue<string>('Chip revision not reported'),
      architecture: catalogValue(spec.architecture, 'CPU architecture'),
      cores: agentNumber('cores'),
      cpuFrequencyMHz: agentNumber('cpuFrequencyMHz'),
      flashSizeBytes: agentNumber('flashSizeBytes'),
      psramBytes: agentNumber('psramBytes'),
      macAddress: agentString('mac'),
      features:
        info && Array.isArray(info.features)
          ? knownValue(info.features as string[], 'FIRMWARE_REPORT', 'sys.info.features', 'HIGH')
          : unknownValue<string[]>('Silicon feature bits not reported'),
      resetReason: agentString('resetReason'),
      bootInfo:
        info && typeof info.uptimeMs === 'number'
          ? knownValue(
              `Reset reason ${info.resetReason ?? 'UNKNOWN'}; up ${Math.round(
                (info.uptimeMs as number) / 1000
              )} s at time of query`,
              'FIRMWARE_REPORT',
              'Derived from sys.info reset reason and uptime',
              'HIGH'
            )
          : unknownValue<string>('Boot information not reported'),
    },
    firmware: {
      applicationName: agentString('appName'),
      applicationVersion: agentString('appVersion'),
      buildInfo: agentString('buildInfo'),
      sdkVersion: agentString('sdkVersion'),
      framework: agentString('framework'),
      agentVersion: agentString('agentVersion'),
    },
    toolchain: {
      platformioEnvironment: pio.environment,
      platformioBoard: pio.board,
    },
    serial: {
      port: session.port,
      description: serial.description,
      usbBridge: serial.bridge,
    },
    peripherals: {
      gpio: catalogValue(spec.gpioCount, 'GPIO count'),
      adcChannels: catalogValue(spec.adcChannels, 'ADC channels'),
      dacChannels: catalogValue(spec.dacChannels, 'DAC channels'),
      pwmChannels: catalogValue(spec.pwmChannels, 'LEDC/PWM channels'),
      touchChannels: catalogValue(spec.touchChannels, 'touch channels'),
      hardwareTimers: catalogValue(spec.hardwareTimers, 'hardware timers'),
      i2cControllers: catalogValue(spec.i2cControllers, 'I2C controllers'),
      spiControllers: catalogValue(spec.usableSpiControllers, 'user-usable SPI controllers'),
      uartControllers: catalogValue(spec.uartControllers, 'UART controllers'),
      wifi: catalogValue(spec.wifi, 'Wi-Fi radio'),
      bluetooth: spec.bluetooth
        ? catalogValue(spec.bluetooth, 'Bluetooth support')
        : catalogAvailable
          ? knownValue('none', 'ESP32_CATALOG', `${family} has no Bluetooth radio`, 'DOCUMENTED')
          : unknownValue<string>('Chip family unknown'),
    },
    capabilities: buildCapabilityMatrix(
      `esp32:${family}`,
      buildInventoryCapabilities(family, spec, info)
    ),
    raw,
    warnings,
  };

  if (catalogAvailable && spec.note) {
    report.warnings.push(`${family}: ${spec.note}`);
  }

  return report;
}

function emptyInventory(
  port: ObservedValue<string>,
  warnings: string[]
): HardwareInventoryReport {
  const unknownStr = () => unknownValue<string>('Not determined');
  const unknownNum = () => unknownValue<number>('Not determined');
  return {
    success: false,
    port,
    sources: [],
    chip: {
      family: unknownValue<Esp32Family>('Not determined'),
      model: unknownStr(),
      revision: unknownStr(),
      architecture: unknownStr(),
      cores: unknownNum(),
      cpuFrequencyMHz: unknownNum(),
      flashSizeBytes: unknownNum(),
      psramBytes: unknownNum(),
      macAddress: unknownStr(),
      features: unknownValue<string[]>('Not determined'),
      resetReason: unknownStr(),
      bootInfo: unknownStr(),
    },
    firmware: {
      applicationName: unknownStr(),
      applicationVersion: unknownStr(),
      buildInfo: unknownStr(),
      sdkVersion: unknownStr(),
      framework: unknownStr(),
      agentVersion: unknownStr(),
    },
    toolchain: { platformioEnvironment: unknownStr(), platformioBoard: unknownStr() },
    serial: { port, description: unknownStr(), usbBridge: unknownStr() },
    peripherals: {
      gpio: unknownNum(),
      adcChannels: unknownNum(),
      dacChannels: unknownNum(),
      pwmChannels: unknownNum(),
      touchChannels: unknownNum(),
      hardwareTimers: unknownNum(),
      i2cControllers: unknownNum(),
      spiControllers: unknownNum(),
      uartControllers: unknownNum(),
      wifi: unknownValue<boolean>('Not determined'),
      bluetooth: unknownStr(),
    },
    capabilities: buildCapabilityMatrix('esp32:UNKNOWN', []),
    raw: [],
    warnings,
    error: warnings[0],
  };
}

/**
 * Build the ESP32-level capability matrix.
 *
 * Catalog entries are DOCUMENTED. A peripheral is only OBSERVED when the agent
 * reported something that actually demonstrates it — a Wi-Fi feature bit read
 * out of the silicon, for example, rather than a datasheet saying the part has
 * a radio.
 */
function buildInventoryCapabilities(
  family: Esp32Family,
  spec: ReturnType<typeof getFamilySpec>,
  info: Record<string, unknown> | null
): CapabilityRecord[] {
  if (family === 'UNKNOWN') return [];

  const features = Array.isArray(info?.features) ? (info!.features as string[]) : [];
  const catalogEvidence = (what: string) =>
    makeEvidence('ESP32_CATALOG', `${family} datasheet declares ${what}`, {
      reference: `${family} datasheet`,
      confidence: 'DOCUMENTED',
    });
  const siliconEvidence = (bit: string) =>
    makeEvidence('FIRMWARE_REPORT', `Silicon feature bit ${bit} read from the running chip`, {
      confidence: 'HIGH',
    });

  const records: CapabilityRecord[] = [];

  const addPeripheral = (
    name: string,
    count: number,
    description: string,
    category: CapabilityRecord['category'] = 'INTERFACE'
  ) => {
    records.push(
      makeCapability({
        name,
        category,
        description,
        documented: count > 0,
        unsupported: count === 0,
        // Software support is asserted because arduino-esp32 exposes these
        // peripherals; it is a claim about tooling, not about this unit.
        softwareSupported: count > 0,
        evidence: [catalogEvidence(description)],
      })
    );
  };

  addPeripheral('peripheral.i2c', spec.i2cControllers, `${spec.i2cControllers} I2C controller(s)`);
  addPeripheral('peripheral.spi', spec.usableSpiControllers, `${spec.usableSpiControllers} user-usable SPI controller(s)`);
  addPeripheral('peripheral.uart', spec.uartControllers, `${spec.uartControllers} UART controller(s)`);
  addPeripheral('peripheral.adc', spec.adcChannels, `${spec.adcChannels} ADC channel(s)`, 'MEASUREMENT');
  addPeripheral('peripheral.dac', spec.dacChannels, `${spec.dacChannels} DAC channel(s)`, 'MEASUREMENT');
  addPeripheral('peripheral.pwm', spec.pwmChannels, `${spec.pwmChannels} LEDC/PWM channel(s)`, 'FEATURE');
  addPeripheral('peripheral.touch', spec.touchChannels, `${spec.touchChannels} touch channel(s)`, 'FEATURE');
  addPeripheral('peripheral.timers', spec.hardwareTimers, `${spec.hardwareTimers} hardware timer(s)`, 'FEATURE');
  addPeripheral('peripheral.gpio', spec.gpioCount, `${spec.gpioCount} GPIO`, 'INTERFACE');

  const wifiObserved = features.includes('WIFI_BGN');
  records.push(
    makeCapability({
      name: 'radio.wifi',
      category: 'INTERFACE',
      description: spec.wifi ? 'IEEE 802.11 b/g/n radio' : 'No Wi-Fi radio',
      documented: spec.wifi,
      unsupported: !spec.wifi,
      softwareSupported: spec.wifi,
      observed: wifiObserved,
      evidence: [
        catalogEvidence(spec.wifi ? 'a Wi-Fi radio' : 'no Wi-Fi radio'),
        ...(wifiObserved ? [siliconEvidence('CHIP_FEATURE_WIFI_BGN')] : []),
      ],
    })
  );

  const bleObserved = features.includes('BLE');
  const btObserved = features.includes('BT_CLASSIC');
  records.push(
    makeCapability({
      name: 'radio.bluetooth',
      category: 'INTERFACE',
      description: spec.bluetooth ?? 'No Bluetooth radio',
      documented: spec.bluetooth !== null,
      unsupported: spec.bluetooth === null,
      softwareSupported: spec.bluetooth !== null,
      observed: bleObserved || btObserved,
      evidence: [
        catalogEvidence(spec.bluetooth ?? 'no Bluetooth radio'),
        ...(bleObserved ? [siliconEvidence('CHIP_FEATURE_BLE')] : []),
        ...(btObserved ? [siliconEvidence('CHIP_FEATURE_BT')] : []),
      ],
    })
  );

  const psramReported = typeof info?.psramBytes === 'number' && (info.psramBytes as number) > 0;
  records.push(
    makeCapability({
      name: 'memory.psram',
      category: 'FEATURE',
      description: spec.psramCapable
        ? 'External PSRAM supported by this family'
        : 'This family does not support external PSRAM',
      documented: spec.psramCapable,
      unsupported: !spec.psramCapable,
      softwareSupported: spec.psramCapable,
      observed: psramReported,
      firmwareExposed: psramReported,
      evidence: [
        catalogEvidence(spec.psramCapable ? 'PSRAM support' : 'no PSRAM support'),
        ...(psramReported
          ? [
              makeEvidence(
                'FIRMWARE_REPORT',
                `Running firmware reports ${info!.psramBytes} bytes of PSRAM`,
                { confidence: 'HIGH' }
              ),
            ]
          : []),
      ],
    })
  );

  const otaObserved = typeof info?.appName === 'string';
  records.push(
    makeCapability({
      name: 'feature.ota_app_descriptor',
      category: 'DIAGNOSTIC',
      description: 'Application descriptor readable at runtime (name, version, build date)',
      documented: true,
      softwareSupported: true,
      firmwareExposed: otaObserved,
      observed: otaObserved,
      evidence: otaObserved
        ? [
            makeEvidence(
              'FIRMWARE_REPORT',
              `Application descriptor read: ${info!.appName} ${info!.appVersion ?? ''}`.trim(),
              { confidence: 'HIGH' }
            ),
          ]
        : [catalogEvidence('an application descriptor in the OTA partition header')],
    })
  );

  return records;
}

async function readPlatformIO(projectPath?: string): Promise<{
  environment: ObservedValue<string>;
  board: ObservedValue<string>;
  environments: string[];
  raw: string | null;
  detail: string;
}> {
  const dir = projectPath ? resolve(projectPath) : process.cwd();
  const iniPath = join(dir, 'platformio.ini');

  if (!(await fileExists(iniPath))) {
    return {
      environment: unknownValue<string>('No platformio.ini found'),
      board: unknownValue<string>('No platformio.ini found'),
      environments: [],
      raw: null,
      detail: `No platformio.ini at ${dir}`,
    };
  }

  try {
    const content = await readFile(iniPath, 'utf8');
    const environments = [...content.matchAll(/^\[env:([^\]]+)\]/gm)].map((m) => m[1]);
    const boardMatch = content.match(/^board\s*=\s*(.+)$/m);

    return {
      environment:
        environments.length > 0
          ? knownValue(
              environments[0],
              'TOOLCHAIN_REPORT',
              environments.length > 1
                ? `First of ${environments.length} environments: ${environments.join(', ')}`
                : 'Only environment declared in platformio.ini',
              'MEDIUM'
            )
          : unknownValue<string>('platformio.ini declares no [env:*] section'),
      board: boardMatch
        ? knownValue(boardMatch[1].trim(), 'TOOLCHAIN_REPORT', 'platformio.ini board=', 'MEDIUM')
        : unknownValue<string>('platformio.ini declares no board'),
      environments,
      raw: content,
      detail: `Read ${iniPath}`,
    };
  } catch (error: any) {
    return {
      environment: unknownValue<string>(`Cannot read platformio.ini: ${error?.message}`),
      board: unknownValue<string>(`Cannot read platformio.ini: ${error?.message}`),
      environments: [],
      raw: null,
      detail: `Failed to read ${iniPath}`,
    };
  }
}

async function describeSerialPort(port: string | null): Promise<{
  description: ObservedValue<string>;
  bridge: ObservedValue<string>;
  detail: string;
}> {
  if (!port) {
    return {
      description: unknownValue<string>('No port resolved'),
      bridge: unknownValue<string>('No port resolved'),
      detail: 'No port to describe',
    };
  }

  try {
    const serialTools = await import('./serial.js');
    const listing = await serialTools.listSerialPorts();
    const match = listing.ports.find((p) => p.port === port);
    if (!match) {
      return {
        description: unknownValue<string>(`Port ${port} not present in the host enumeration`),
        bridge: unknownValue<string>('Port not enumerated'),
        detail: `Port ${port} was not returned by the host port enumeration`,
      };
    }
    const bridge = identifyUsbBridge(match.description);
    return {
      description: knownValue(match.description, 'TOOLCHAIN_REPORT', 'Host serial enumeration', 'MEDIUM'),
      bridge: bridge
        ? knownValue(bridge, 'TOOLCHAIN_REPORT', `Matched against the port description "${match.description}"`, 'MEDIUM')
        : unknownValue<string>(`No known USB-UART bridge matches "${match.description}"`),
      detail: `Enumerated as: ${match.description}`,
    };
  } catch (error: any) {
    return {
      description: unknownValue<string>('Host port enumeration unavailable'),
      bridge: unknownValue<string>('Host port enumeration unavailable'),
      detail: `Port enumeration unavailable (FirmwareToolkit not configured): ${error?.message ?? error}`,
    };
  }
}

// ===========================================================================
// 2. esp32_interface_discovery
// ===========================================================================

export interface InterfaceDiscoveryOptions {
  port?: string;
  interfaces?: string[];
}

/**
 * Discover which interfaces the target offers and how they are configured.
 *
 * Read-only: no GPIO is configured or driven. Availability of a controller is
 * DOCUMENTED from the catalog; only the pins the running firmware actually
 * reports are treated as observed.
 */
export async function interfaceDiscovery(
  options: InterfaceDiscoveryOptions = {}
): Promise<InterfaceDiscoveryReport> {
  const session = await openSession({ ...(options.port !== undefined ? { port: options.port } : {}) });
  const raw: RawInterpretation[] = [];
  const warnings: string[] = [];
  const notes: string[] = [
    'This is a read-only survey. No GPIO was configured and no pin was driven.',
    'Controller counts come from the chip datasheet (DOCUMENTED). A controller listed ' +
      'as available has not been proven functional on this unit.',
  ];

  let ifaceData: Record<string, unknown> | null = null;
  if (session.agentPresent) {
    const response = await session.transport.request<Record<string, unknown>>('sys.interfaces');
    if (response.ok && response.data) {
      ifaceData = response.data;
      raw.push(
        rawInterpretation(
          response.raw,
          response.data,
          'Interrogation agent sys.interfaces response',
          'FIRMWARE_REPORT',
          'HIGH'
        )
      );
    } else {
      warnings.push(`sys.interfaces failed: ${response.error ?? 'unknown error'}`);
    }
  } else {
    warnings.push(...agentUnavailableHelp(session.agentDetail, session.agentErrorKind));
  }

  const family = session.family;
  const spec = getFamilySpec(family);
  const chip =
    family === 'UNKNOWN'
      ? unknownValue<string>('Chip family could not be determined')
      : knownValue(family, 'FIRMWARE_REPORT', 'Reported by the interrogation agent', 'HIGH');

  const requested = (options.interfaces ?? []).map((i) => i.toUpperCase());
  const wanted = (kind: HardwareInterfaceKind) =>
    requested.length === 0 || requested.includes(kind);

  const agentPin = (key: string): number | null =>
    ifaceData && typeof ifaceData[key] === 'number' ? (ifaceData[key] as number) : null;

  const interfaces: DiscoveredInterface[] = [];
  const availability = (count: number, label: string): ObservedValue<boolean> =>
    family === 'UNKNOWN'
      ? unknownValue<boolean>('Chip family unknown — controller availability not established')
      : knownValue(
          count > 0,
          'ESP32_CATALOG',
          `${family} datasheet: ${label}`,
          'DOCUMENTED'
        );

  const pin = (signal: string, gpio: number | null, note?: string): PinAssignment => ({
    signal,
    gpio,
    known: gpio !== null,
    ...(note !== undefined ? { note } : gpio === null ? { note: 'Not reported by the running firmware' } : {}),
  });

  if (wanted('I2C')) {
    for (let index = 0; index < Math.max(spec.i2cControllers, 1); index++) {
      const isDefault = index === 0;
      interfaces.push({
        kind: 'I2C',
        controller: `I2C${index}`,
        available: availability(spec.i2cControllers, `${spec.i2cControllers} I2C controller(s)`),
        pins: isDefault
          ? [pin('SDA', agentPin('defaultI2CSda')), pin('SCL', agentPin('defaultI2CScl'))]
          : [pin('SDA', null, 'No default assignment — supply pins explicitly'), pin('SCL', null, 'No default assignment — supply pins explicitly')],
        configuration: isDefault
          ? { defaultFrequencyHz: 100000, note: 'Arduino core default pins for this board' }
          : { note: 'Secondary controller — pins must be supplied per call' },
        configuredPeripherals: [],
        conflicts: [],
        warnings:
          index >= spec.i2cControllers
            ? [`${family} declares ${spec.i2cControllers} I2C controller(s); this one may not exist.`]
            : [],
        confidence: family === 'UNKNOWN' ? 'UNKNOWN' : 'DOCUMENTED',
        source: 'ESP32_CATALOG',
      });
    }
  }

  if (wanted('SPI')) {
    for (let index = 0; index < Math.max(spec.usableSpiControllers, 1); index++) {
      const isDefault = index === 0;
      interfaces.push({
        kind: 'SPI',
        controller: index === 0 ? 'HSPI' : 'VSPI',
        available: availability(
          spec.usableSpiControllers,
          `${spec.usableSpiControllers} user-usable SPI controller(s) (flash controllers excluded)`
        ),
        pins: isDefault
          ? [
              pin('SCLK', agentPin('defaultSpiSclk')),
              pin('MISO', agentPin('defaultSpiMiso')),
              pin('MOSI', agentPin('defaultSpiMosi')),
              pin('CS', agentPin('defaultSpiCs')),
            ]
          : [pin('SCLK', null), pin('MISO', null), pin('MOSI', null), pin('CS', null)],
        configuration: { defaultMode: 0, defaultClockHz: 1000000 },
        configuredPeripherals: [],
        conflicts: [],
        warnings: [],
        confidence: family === 'UNKNOWN' ? 'UNKNOWN' : 'DOCUMENTED',
        source: 'ESP32_CATALOG',
      });
    }
  }

  if (wanted('UART')) {
    for (let index = 0; index < Math.max(spec.uartControllers, 1); index++) {
      const inUse = index === 0;
      interfaces.push({
        kind: 'UART',
        controller: `UART${index}`,
        available: availability(spec.uartControllers, `${spec.uartControllers} UART controller(s)`),
        pins: inUse
          ? [pin('TX', null, 'USB console'), pin('RX', null, 'USB console')]
          : [pin('TX', null, 'Assignable — supply pins explicitly'), pin('RX', null, 'Assignable — supply pins explicitly')],
        configuration: inUse ? { baud: 115200, role: 'console' } : { assignable: true },
        configuredPeripherals: inUse ? ['USB console / interrogation agent link'] : [],
        conflicts: inUse
          ? ['UART0 carries the interrogation agent link and must not be reassigned.']
          : [],
        warnings: inUse ? ['Reconfiguring UART0 would sever the interrogation session.'] : [],
        confidence: family === 'UNKNOWN' ? 'UNKNOWN' : 'DOCUMENTED',
        source: inUse ? 'FIRMWARE_REPORT' : 'ESP32_CATALOG',
      });
    }
  }

  const simple: [HardwareInterfaceKind, number, string][] = [
    ['GPIO', spec.gpioCount, `${spec.gpioCount} GPIO`],
    ['ADC', spec.adcChannels, `${spec.adcChannels} ADC channel(s)`],
    ['DAC', spec.dacChannels, `${spec.dacChannels} DAC channel(s)`],
    ['PWM', spec.pwmChannels, `${spec.pwmChannels} LEDC/PWM channel(s)`],
    ['TOUCH', spec.touchChannels, `${spec.touchChannels} touch channel(s)`],
  ];

  for (const [kind, count, label] of simple) {
    if (!wanted(kind)) continue;
    interfaces.push({
      kind,
      controller: kind,
      available: availability(count, label),
      pins: [],
      configuration: { channels: count },
      configuredPeripherals: [],
      conflicts:
        kind === 'GPIO' && spec.note
          ? [spec.note]
          : count === 0
            ? [`${family} has no ${kind} hardware.`]
            : [],
      warnings:
        kind === 'GPIO'
          ? ['Unknown GPIO are never driven automatically. Every pin used must be named explicitly.']
          : [],
      confidence: family === 'UNKNOWN' ? 'UNKNOWN' : 'DOCUMENTED',
      source: 'ESP32_CATALOG',
    });
  }

  // Pin conflicts across the default assignments the firmware actually reported.
  const assigned = new Map<number, string[]>();
  for (const iface of interfaces) {
    for (const p of iface.pins) {
      if (p.gpio === null) continue;
      const owners = assigned.get(p.gpio) ?? [];
      owners.push(`${iface.controller}.${p.signal}`);
      assigned.set(p.gpio, owners);
    }
  }
  for (const [gpio, owners] of assigned) {
    if (owners.length > 1) {
      const conflict = `GPIO${gpio} is the default for ${owners.join(' and ')}.`;
      for (const iface of interfaces) {
        if (iface.pins.some((p) => p.gpio === gpio)) iface.conflicts.push(conflict);
      }
    }
  }

  if (family === 'UNKNOWN') {
    warnings.push(
      'Chip family is UNKNOWN. Interface availability is reported as UNKNOWN rather than guessed.'
    );
  }

  return {
    success: true,
    target: session.port.value ?? 'unresolved-port',
    chip,
    interfaces,
    warnings,
    notes,
    raw,
  };
}

// ===========================================================================
// 3. esp32_i2c_scan
// ===========================================================================

export interface I2CScanOptions {
  port?: string;
  controller?: number;
  sda?: number;
  scl?: number;
  frequencyHz?: number;
  startAddress?: number;
  endAddress?: number;
  repeats?: number;
  fingerprint?: boolean;
  timeoutMs?: number;
}

/**
 * Comprehensive I2C bus scan.
 *
 * Distinguishes a device that responds, a device that does not, a bus error, an
 * unstable response and a probable address conflict — collapsing those into
 * "found/not found" would throw away the most diagnostic information on the bus.
 */
export async function i2cScan(options: I2CScanOptions = {}): Promise<I2CScanReport> {
  const {
    controller = 0,
    frequencyHz = 100000,
    startAddress = 0x08,
    endAddress = 0x77,
    repeats = 3,
    fingerprint = true,
    timeoutMs,
  } = options;

  const errors: string[] = [];
  if (options.sda !== undefined && !validateGpioPin(options.sda)) errors.push(`Invalid SDA pin: ${options.sda}`);
  if (options.scl !== undefined && !validateGpioPin(options.scl)) errors.push(`Invalid SCL pin: ${options.scl}`);
  if (!validateI2CFrequency(frequencyHz)) errors.push(`I2C frequency out of range (1 kHz - 1 MHz): ${frequencyHz}`);
  if (!validateI2CAddress(startAddress) || !validateI2CAddress(endAddress)) {
    errors.push('Address range must lie within 0x00-0x7F');
  }
  if (startAddress > endAddress) errors.push('startAddress must not exceed endAddress');
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 8) errors.push('repeats must be 1-8');

  if (errors.length > 0) {
    return failedScan(controller, options, frequencyHz, startAddress, endAddress, errors);
  }

  const session = await openSession({ ...(options.port !== undefined ? { port: options.port } : {}) });

  const pinCheck = checkPins(session.family, [
    { signal: 'SDA', gpio: options.sda, mustOutput: true },
    { signal: 'SCL', gpio: options.scl, mustOutput: true },
  ]);
  if (!pinCheck.ok) {
    return failedScan(controller, options, frequencyHz, startAddress, endAddress, pinCheck.errors);
  }

  if (!session.agentPresent) {
    return failedScan(
      controller,
      options,
      frequencyHz,
      startAddress,
      endAddress,
      agentUnavailableHelp(session.agentDetail, session.agentErrorKind)
    );
  }

  const raw: RawInterpretation[] = [];
  const warnings: string[] = [...pinCheck.warnings];
  const busErrors: string[] = [];
  const started = Date.now();

  const response = await session.transport.request<{
    addresses?: { address: number; ackCount: number; probeCount: number; busErrors: number; responseTimeUs?: number }[];
    scanDurationMs?: number;
  }>(
    'i2c.scan',
    {
      controller,
      ...(options.sda !== undefined ? { sda: options.sda } : {}),
      ...(options.scl !== undefined ? { scl: options.scl } : {}),
      frequencyHz,
      start: startAddress,
      end: endAddress,
      repeats,
    },
    { ...(timeoutMs !== undefined ? { timeoutMs } : { timeoutMs: 20000 }) }
  );

  raw.push(
    rawInterpretation(
      response.raw,
      response.data,
      response.ok ? 'Raw I2C scan response from the interrogation agent' : `I2C scan failed: ${response.error}`,
      response.ok ? 'BUS_SCAN' : 'NONE',
      response.ok ? 'HIGH' : 'UNKNOWN'
    )
  );

  if (!response.ok) {
    return failedScan(controller, options, frequencyHz, startAddress, endAddress, [
      response.error ?? 'I2C scan failed',
    ], raw);
  }

  const reported = response.data?.addresses ?? [];
  const results: I2CAddressResult[] = [];

  for (let address = startAddress; address <= endAddress; address++) {
    const entry = reported.find((a) => a.address === address);

    if (I2C_RESERVED(address)) {
      results.push(
        baseAddressResult(address, 'RESERVED_SKIPPED', 0, repeats, [
          'Address is reserved by the I2C specification; a response here is not a normal device.',
        ])
      );
      continue;
    }

    if (!entry) {
      results.push(baseAddressResult(address, 'NO_RESPONSE', 0, repeats, []));
      continue;
    }

    const state: I2CAddressState =
      entry.busErrors > 0 && entry.ackCount === 0
        ? 'BUS_ERROR'
        : entry.ackCount === 0
          ? 'NO_RESPONSE'
          : entry.ackCount < entry.probeCount
            ? 'UNSTABLE'
            : 'RESPONDS';

    if (state === 'BUS_ERROR') {
      busErrors.push(
        `0x${address.toString(16).toUpperCase().padStart(2, '0')}: ${entry.busErrors} bus error(s) ` +
          'across the probe repeats. Check pull-ups, wiring and shared-bus contention.'
      );
    }

    const result = baseAddressResult(
      address,
      state,
      entry.ackCount,
      entry.probeCount,
      entry.busErrors > 0 ? [`${entry.busErrors} bus error(s) during probing`] : []
    );

    if (typeof entry.responseTimeUs === 'number') {
      result.responseTimeMs = knownValue(
        entry.responseTimeUs / 1000,
        'BUS_SCAN',
        'Measured on the target between transmission start and ACK',
        'HIGH'
      );
    }

    if (state === 'RESPONDS' || state === 'UNSTABLE') {
      result.possibleMatches = hintsForI2CAddress(address);
      result.confidence = state === 'RESPONDS' ? 'HIGH' : 'MEDIUM';
    }

    results.push(result);
  }

  const responding = results.filter((r) => r.state === 'RESPONDS' || r.state === 'UNSTABLE');

  // --- Safe fingerprinting -----------------------------------------------
  if (fingerprint && responding.length > 0) {
    for (const result of responding) {
      const captures: number[][] = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        // A plain read emits no command byte, so it cannot select a register,
        // trigger a measurement or alter configuration on any device.
        const read = await session.transport.request<{ bytes?: number[] }>(
          'i2c.read',
          {
            controller,
            ...(options.sda !== undefined ? { sda: options.sda } : {}),
            ...(options.scl !== undefined ? { scl: options.scl } : {}),
            frequencyHz,
            address: result.address,
            length: 4,
          },
          { timeoutMs: 4000 }
        );
        if (read.ok && Array.isArray(read.data?.bytes)) {
          captures.push(read.data!.bytes!.map((b) => b & 0xff));
          if (attempt === 0) {
            raw.push(
              rawInterpretation(
                read.raw,
                read.data,
                `Fingerprint read at ${result.hex}`,
                'DEVICE_RESPONSE',
                'HIGH'
              )
            );
          }
        }
      }

      if (captures.length === 0) {
        result.errors.push('Device ACKed its address but returned no data to a plain read.');
        continue;
      }

      const first = toHex(captures[0]);
      const consistent = captures.every((c) => toHex(c) === first);

      result.fingerprint = rawInterpretation(
        captures.map((c) => toHex(c)).join(' | '),
        captures[0],
        consistent
          ? `Plain read returns ${first}` +
            (isDegenerateResponse(captures[0])
              ? ' — a uniform 0x00/0xFF pattern, which often means the device needs a register pointer before it returns data.'
              : '.')
          : `Plain read returned differing data across repeats (${captures
              .map((c) => toHex(c))
              .join(' vs ')}). This is either a device with changing state or two devices sharing the address.`,
        'DEVICE_RESPONSE',
        consistent ? 'HIGH' : 'MEDIUM'
      );

      if (!consistent && result.state === 'RESPONDS') {
        result.state = 'ADDRESS_CONFLICT';
        result.errors.push(
          'Stable ACK but inconsistent data across identical reads — consistent with two ' +
            'devices on the same address, or with a device whose registers change between reads.'
        );
        result.confidence = 'MEDIUM';
      }
    }
  }

  if (responding.length === 0) {
    warnings.push(
      'No device acknowledged in the scanned range. This means nothing responded — it does ' +
        'not establish that the bus is empty. Check pull-up resistors, wiring, power and the ' +
        'SDA/SCL pin assignment before concluding anything.'
    );
  }

  for (const result of results) {
    if (result.possibleMatches.length > 1) {
      warnings.push(
        `${result.hex} matches ${result.possibleMatches.length} profile addresses. An I2C ` +
          'address alone never identifies a device — run esp32_component_identify.'
      );
    }
  }

  return {
    success: true,
    controller: `I2C${controller}`,
    sda: options.sda ?? null,
    scl: options.scl ?? null,
    frequencyHz,
    addressRange: { start: startAddress, end: endAddress },
    scanDurationMs: response.data?.scanDurationMs ?? Date.now() - started,
    responding: results.filter((r) =>
      ['RESPONDS', 'UNSTABLE', 'ADDRESS_CONFLICT'].includes(r.state)
    ),
    results,
    busErrors,
    errors: [],
    warnings,
    raw,
  };
}

function baseAddressResult(
  address: number,
  state: I2CAddressState,
  ackCount: number,
  probeCount: number,
  errors: string[]
): I2CAddressResult {
  return {
    address,
    hex: hexValue(address),
    decimal: address,
    state,
    ack: ackCount > 0,
    responseTimeMs: unknownValue<number>('Not measured'),
    ackCount,
    probeCount,
    errors,
    possibleMatches: [],
    confidence: state === 'NO_RESPONSE' ? 'HIGH' : 'UNKNOWN',
  };
}

function failedScan(
  controller: number,
  options: I2CScanOptions,
  frequencyHz: number,
  start: number,
  end: number,
  errors: string[],
  raw: RawInterpretation[] = []
): I2CScanReport {
  return {
    success: false,
    controller: `I2C${controller}`,
    sda: options.sda ?? null,
    scl: options.scl ?? null,
    frequencyHz,
    addressRange: { start, end },
    scanDurationMs: 0,
    responding: [],
    results: [],
    busErrors: [],
    errors,
    warnings: [],
    raw,
    error: errors[0],
  };
}

// ===========================================================================
// 4. esp32_spi_discovery
// ===========================================================================

/**
 * Convenience SPI presets.
 *
 * These are shortcuts for common opening moves, NOT a restriction: `tx` accepts
 * any byte sequence, and a preset is simply a named starting point. Anything a
 * preset can do, an explicit `tx` can do too.
 */
export const SPI_PROBE_PROFILES = {
  IDLE_READ: {
    description:
      'Clocks idle 0xFF bytes and observes MISO. Emits no command opcode, so no device ' +
      'can interpret it as an instruction.',
    tx: [0xff, 0xff, 0xff, 0xff],
  },
  ZERO_READ: {
    description:
      'Clocks 0x00 bytes and observes MISO. Complements IDLE_READ: comparing the two ' +
      'distinguishes a floating MISO line from a device holding it.',
    tx: [0x00, 0x00, 0x00, 0x00],
  },
  JEDEC_ID: {
    description:
      'JEDEC Read Identification (0x9F). A standardised read-only command implemented by ' +
      'SPI flash and EEPROM devices; it returns manufacturer and device ID and modifies nothing.',
    tx: [0x9f, 0x00, 0x00, 0x00],
  },
} as const;

export type SpiProbeProfileName = keyof typeof SPI_PROBE_PROFILES;

export interface SpiDiscoveryOptions {
  port?: string;
  mosi?: number;
  miso?: number;
  sclk?: number;
  cs?: number;
  mode?: number;
  clockHz?: number;
  bitOrder?: SpiBitOrder;
  profiles?: string[];
  /**
   * Arbitrary bytes to clock out. Any value is permitted — this is the
   * general-purpose path, and it needs no preset and no component profile.
   */
  tx?: number[];
  /** Extra bytes to clock in after `tx`, filled with `padByte`. */
  readLength?: number;
  padByte?: number;
  component?: string;
  transactionSize?: number;
  timeoutMs?: number;
}

/**
 * Generic SPI discovery.
 *
 * SPI has no addressing and no acknowledgement, so a "response" is whatever the
 * MISO line happens to hold. All-0x00 and all-0xFF captures are flagged as
 * degenerate rather than reported as data.
 */
export async function spiDiscovery(
  options: SpiDiscoveryOptions = {}
): Promise<SpiDiscoveryReport> {
  const {
    mode = 0,
    clockHz = 1000000,
    bitOrder = 'MSB_FIRST',
    transactionSize = 4,
    timeoutMs,
  } = options;

  const errors: string[] = [];

  // CS has no safe default: asserting an unknown chip-select could select any
  // device on the board. The caller must name it.
  if (options.cs === undefined) {
    errors.push(
      'A chip-select (cs) pin is required. This tool will not assert an unspecified CS line.'
    );
  }
  for (const [signal, value] of [
    ['mosi', options.mosi],
    ['miso', options.miso],
    ['sclk', options.sclk],
    ['cs', options.cs],
  ] as const) {
    if (value !== undefined && !validateGpioPin(value)) errors.push(`Invalid ${signal} pin: ${value}`);
  }
  if (!validateSpiMode(mode)) errors.push(`Invalid SPI mode: ${mode} (must be 0-3)`);
  if (!validateSpiClock(clockHz)) errors.push(`SPI clock out of range (10 kHz - 40 MHz): ${clockHz}`);
  if (!Number.isInteger(transactionSize) || transactionSize < 1 || transactionSize > 256) {
    errors.push('transactionSize must be 1-256');
  }
  if (options.component !== undefined && !validateComponentIdentifier(options.component)) {
    errors.push(`Invalid component identifier: ${options.component}`);
  }

  // Presets are the default opening move only when the caller has not supplied
  // explicit bytes. An explicit `tx` takes precedence over any preset.
  const defaultProfiles = options.tx !== undefined ? [] : ['IDLE_READ', 'ZERO_READ'];
  const requestedProfiles = (options.profiles ?? defaultProfiles).map((p) => p.toUpperCase());
  const unknownProfiles = requestedProfiles.filter((p) => !(p in SPI_PROBE_PROFILES));
  if (unknownProfiles.length > 0) {
    errors.push(
      `Unknown SPI preset(s): ${unknownProfiles.join(', ')}. ` +
        `Available presets: ${Object.keys(SPI_PROBE_PROFILES).join(', ')}. ` +
        'To send bytes no preset covers, pass them directly as `tx` — any byte sequence is ' +
        'accepted.'
    );
  }
  if (options.tx !== undefined && !validateByteArray(options.tx)) {
    errors.push('tx must be an array of 1-512 integers in the range 0-255.');
  }
  if (options.readLength !== undefined && (options.readLength < 0 || options.readLength > 512)) {
    errors.push('readLength must be 0-512.');
  }

  if (errors.length > 0) return failedSpi(options, errors);

  const session = await openSession({ ...(options.port !== undefined ? { port: options.port } : {}) });

  const pinCheck = checkPins(session.family, [
    { signal: 'SCLK', gpio: options.sclk, mustOutput: true },
    { signal: 'MOSI', gpio: options.mosi, mustOutput: true },
    { signal: 'MISO', gpio: options.miso },
    { signal: 'CS', gpio: options.cs, mustOutput: true },
  ]);
  if (!pinCheck.ok) return failedSpi(options, pinCheck.errors);

  if (!session.agentPresent) {
    return failedSpi(options, agentUnavailableHelp(session.agentDetail, session.agentErrorKind));
  }

  const raw: RawInterpretation[] = [];
  const warnings: string[] = [...pinCheck.warnings];
  const probes: SpiProbeResult[] = [];
  const spiParams = {
    ...(options.sclk !== undefined ? { sclk: options.sclk } : {}),
    ...(options.miso !== undefined ? { miso: options.miso } : {}),
    ...(options.mosi !== undefined ? { mosi: options.mosi } : {}),
    ...(options.cs !== undefined ? { cs: options.cs } : {}),
    mode,
    clockHz,
    lsbFirst: bitOrder === 'LSB_FIRST',
  };

  // --- Arbitrary caller-supplied bytes -----------------------------------
  if (options.tx !== undefined) {
    const response = await session.transport.request<{ bytes?: number[]; durationUs?: number }>(
      'spi.transfer',
      {
        ...spiParams,
        tx: options.tx,
        ...(options.readLength !== undefined ? { readLength: options.readLength } : {}),
        ...(options.padByte !== undefined ? { padByte: options.padByte } : {}),
      },
      { ...(timeoutMs !== undefined ? { timeoutMs } : {}) }
    );

    const rx =
      response.ok && Array.isArray(response.data?.bytes)
        ? response.data!.bytes!.map((b) => b & 0xff)
        : [];
    const degenerate = isDegenerateResponse(rx);

    raw.push(
      rawInterpretation(
        response.raw,
        rx,
        response.ok
          ? `SPI arbitrary transfer: TX ${toHex(options.tx)} -> RX ${toHex(rx)}`
          : `SPI arbitrary transfer failed: ${response.error}`,
        response.ok ? 'DEVICE_RESPONSE' : 'NONE',
        response.ok && !degenerate ? 'HIGH' : 'LOW'
      )
    );

    if (response.ok) {
      probes.push({
        probeId: 'ARBITRARY',
        description: `Caller-supplied transfer of ${options.tx.length} byte(s)`,
        mode: mode as 0 | 1 | 2 | 3,
        clockHz,
        bitOrder,
        tx: options.tx,
        rx,
        rxHex: toHex(rx),
        degenerate,
        repeated: rx.length > 1 && new Set(rx).size === 1,
        durationMs: response.durationMs,
        raw: rawInterpretation(
          response.raw,
          rx,
          degenerate
            ? `Uniform ${toHex([rx[0] ?? 0])} response — consistent with a floating MISO line.`
            : `Received ${toHex(rx)}`,
          'DEVICE_RESPONSE',
          degenerate ? 'LOW' : 'HIGH'
        ),
      });
    } else {
      warnings.push(`Arbitrary SPI transfer failed: ${response.error ?? 'unknown error'}`);
    }
  }

  for (const name of requestedProfiles as SpiProbeProfileName[]) {
    const profile = SPI_PROBE_PROFILES[name];
    const tx = [...profile.tx];
    while (tx.length < transactionSize) tx.push(name === 'JEDEC_ID' ? 0x00 : tx[0]);

    const response = await session.transport.request<{ bytes?: number[]; durationUs?: number }>(
      'spi.transfer',
      { ...spiParams, tx: tx.slice(0, transactionSize) },
      { ...(timeoutMs !== undefined ? { timeoutMs } : {}) }
    );

    const rx = response.ok && Array.isArray(response.data?.bytes)
      ? response.data!.bytes!.map((b) => b & 0xff)
      : [];
    const degenerate = isDegenerateResponse(rx);

    raw.push(
      rawInterpretation(
        response.raw,
        rx,
        response.ok
          ? `SPI ${name}: TX ${toHex(tx.slice(0, transactionSize))} -> RX ${toHex(rx)}`
          : `SPI ${name} failed: ${response.error}`,
        response.ok ? 'DEVICE_RESPONSE' : 'NONE',
        response.ok && !degenerate ? 'HIGH' : 'LOW'
      )
    );

    if (!response.ok) {
      warnings.push(`SPI probe ${name} failed: ${response.error ?? 'unknown error'}`);
      continue;
    }

    probes.push({
      probeId: name,
      description: profile.description,
      mode: mode as 0 | 1 | 2 | 3,
      clockHz,
      bitOrder,
      tx: tx.slice(0, transactionSize),
      rx,
      rxHex: toHex(rx),
      degenerate,
      repeated: rx.length > 1 && new Set(rx).size === 1,
      durationMs: response.durationMs,
      raw: rawInterpretation(
        response.raw,
        rx,
        degenerate
          ? `Uniform ${toHex([rx[0] ?? 0])} response — consistent with a floating MISO line or no device selected.`
          : `Received ${toHex(rx)}`,
        'DEVICE_RESPONSE',
        degenerate ? 'LOW' : 'HIGH'
      ),
    });
  }

  // --- Component-profile probes ------------------------------------------
  const componentProfile = options.component ? findProfile(options.component) : null;
  if (options.component && !componentProfile) {
    warnings.push(
      `No registered component profile matches "${options.component}". Profile probes skipped.`
    );
  }

  if (componentProfile) {
    const spiProbes = componentProfile.safeProbes.filter((p) => p.interface === 'SPI');
    const results = await executeProbes(
      spiProbes,
      {
        transport: session.transport,
        spi: {
          ...(options.sclk !== undefined ? { sclk: options.sclk } : {}),
          ...(options.miso !== undefined ? { miso: options.miso } : {}),
          ...(options.mosi !== undefined ? { mosi: options.mosi } : {}),
          ...(options.cs !== undefined ? { cs: options.cs } : {}),
          mode: mode as 0 | 1 | 2 | 3,
          clockHz,
          bitOrder,
        },
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      },
      'STANDARD'
    );

    for (const result of results) {
      raw.push(result.raw);
      if (!result.executed) continue;
      probes.push({
        probeId: result.probeId,
        description: result.name,
        mode: mode as 0 | 1 | 2 | 3,
        clockHz,
        bitOrder,
        tx: [],
        rx: result.bytes,
        rxHex: result.hex,
        degenerate: isDegenerateResponse(result.bytes),
        repeated: result.bytes.length > 1 && new Set(result.bytes).size === 1,
        durationMs: result.durationMs,
        raw: result.raw,
      });
    }
  }

  // --- Analysis -----------------------------------------------------------
  const allBytes = probes.flatMap((p) => p.rx);
  const patterns = findRepeatedPatterns(allBytes).map(
    (p) => `${p.pattern} (x${p.count})`
  );
  const protocolSignatures: string[] = [];

  const jedec = probes.find((p) => p.probeId === 'JEDEC_ID');
  if (jedec && !jedec.degenerate && jedec.rx.length >= 4) {
    protocolSignatures.push(
      `JEDEC identification responded: manufacturer 0x${jedec.rx[1]
        .toString(16)
        .toUpperCase()
        .padStart(2, '0')}, device type/capacity 0x${jedec.rx[2]
        .toString(16)
        .toUpperCase()
        .padStart(2, '0')}${jedec.rx[3].toString(16).toUpperCase().padStart(2, '0')}. ` +
        'Consistent with a JEDEC-compliant SPI memory. The ID bytes are not decoded against a ' +
        'manufacturer table by this system.'
    );
  }

  const allDegenerate = probes.length > 0 && probes.every((p) => p.degenerate);
  if (allDegenerate) {
    warnings.push(
      'Every probe returned a uniform 0x00 or 0xFF pattern. That is what an unconnected MISO ' +
        'line looks like — it is not evidence of a device. Check MISO wiring, CS polarity and ' +
        'whether the device requires a specific SPI mode.'
    );
  }

  const identification =
    probes.length > 0 && !allDegenerate
      ? identifyComponent(
          {
            probeResults: probes.map((p) => ({
              probeId: p.probeId,
              name: p.description,
              executed: true,
              success: !p.degenerate,
              writes: true,
              operations: [],
              bytes: p.rx,
              hex: p.rxHex,
              matchedExpectation: null,
              durationMs: p.durationMs,
              raw: p.raw,
            })),
            streamBytes: allBytes,
            ...(componentProfile ? { candidateIds: [componentProfile.id] } : {}),
          },
          raw
        )
      : null;

  return {
    success: true,
    controller: 'HSPI',
    pins: [
      { signal: 'SCLK', gpio: options.sclk ?? null, known: options.sclk !== undefined },
      { signal: 'MISO', gpio: options.miso ?? null, known: options.miso !== undefined },
      { signal: 'MOSI', gpio: options.mosi ?? null, known: options.mosi !== undefined },
      { signal: 'CS', gpio: options.cs ?? null, known: options.cs !== undefined },
    ],
    probes,
    patterns,
    protocolSignatures,
    identification,
    confidence: allDegenerate ? 'LOW' : probes.length > 0 ? 'MEDIUM' : 'UNKNOWN',
    warnings,
    errors: [],
    raw,
  };
}

function failedSpi(options: SpiDiscoveryOptions, errors: string[]): SpiDiscoveryReport {
  return {
    success: false,
    controller: 'HSPI',
    pins: [
      { signal: 'SCLK', gpio: options.sclk ?? null, known: options.sclk !== undefined },
      { signal: 'MISO', gpio: options.miso ?? null, known: options.miso !== undefined },
      { signal: 'MOSI', gpio: options.mosi ?? null, known: options.mosi !== undefined },
      { signal: 'CS', gpio: options.cs ?? null, known: options.cs !== undefined },
    ],
    probes: [],
    patterns: [],
    protocolSignatures: [],
    identification: null,
    confidence: 'UNKNOWN',
    warnings: [],
    errors,
    raw: [],
    error: errors[0],
  };
}

// ===========================================================================
// 5. esp32_uart_discovery
// ===========================================================================

export interface UartDiscoveryOptions {
  port?: string;
  controller?: number;
  rx?: number;
  tx?: number;
  baud?: number;
  dataBits?: number;
  parity?: 'none' | 'even' | 'odd';
  stopBits?: 1 | 2;
  flowControl?: 'none' | 'rtscts';
  durationMs?: number;
  mode?: 'PASSIVE' | 'ACTIVE';
  component?: string;
  scanBauds?: boolean;
  /**
   * Arbitrary bytes to transmit in ACTIVE mode. Any byte sequence is accepted —
   * no component profile and no documented command set is required.
   */
  transmit?: number[];
  /** Bytes to read back after transmitting. */
  readLength?: number;
  timeoutMs?: number;
}

/**
 * UART interrogation.
 *
 * Defaults to passive observation: listen before speaking. An unknown UART peer
 * may be a device where an unsolicited byte changes its state, so ACTIVE mode
 * requires an explicit component profile whose probes declare what they send.
 */
export async function uartDiscovery(
  options: UartDiscoveryOptions = {}
): Promise<UartDiscoveryReport> {
  const {
    controller = 1,
    baud = 9600,
    dataBits = 8,
    parity = 'none',
    stopBits = 1,
    flowControl = 'none',
    durationMs = 3000,
    mode = 'PASSIVE',
    scanBauds = false,
    timeoutMs,
  } = options;

  const errors: string[] = [];
  if (options.rx === undefined) {
    errors.push('An rx pin is required — there is nothing to listen on otherwise.');
  } else if (!validateGpioPin(options.rx)) {
    errors.push(`Invalid rx pin: ${options.rx}`);
  }
  if (options.tx !== undefined && !validateGpioPin(options.tx)) errors.push(`Invalid tx pin: ${options.tx}`);
  if (!validateProbeBaudRate(baud)) errors.push(`Baud out of range (300 - 3000000): ${baud}`);
  if (!validateDurationMs(durationMs, 30000)) errors.push('durationMs must be 1-30000');
  if (![5, 6, 7, 8].includes(dataBits)) errors.push('dataBits must be 5, 6, 7 or 8');
  if (![1, 2].includes(stopBits)) errors.push('stopBits must be 1 or 2');
  if (!['none', 'even', 'odd'].includes(parity)) errors.push('parity must be none, even or odd');
  if (flowControl !== 'none') {
    errors.push(
      'Hardware flow control is not supported by the interrogation agent; only flowControl: "none" is accepted.'
    );
  }
  if (controller !== 1 && controller !== 2) {
    errors.push('controller must be 1 or 2 — UART0 carries the interrogation agent link.');
  }
  if (mode === 'ACTIVE' && options.transmit === undefined && !options.component) {
    errors.push(
      'ACTIVE mode needs something to send: supply `transmit` bytes, or name a `component` ' +
        'whose profile carries UART probes.'
    );
  }
  if (options.transmit !== undefined && !validateByteArray(options.transmit)) {
    errors.push('transmit must be an array of 1-512 integers in the range 0-255.');
  }
  if (mode === 'ACTIVE' && options.transmit !== undefined && options.tx === undefined) {
    errors.push('Transmitting requires a `tx` pin.');
  }
  if (options.component !== undefined && !validateComponentIdentifier(options.component)) {
    errors.push(`Invalid component identifier: ${options.component}`);
  }

  if (errors.length > 0) return failedUart(options, baud, mode, errors);

  const session = await openSession({ ...(options.port !== undefined ? { port: options.port } : {}) });

  const pinCheck = checkPins(session.family, [
    { signal: 'RX', gpio: options.rx },
    { signal: 'TX', gpio: options.tx, mustOutput: true },
  ]);
  if (!pinCheck.ok) return failedUart(options, baud, mode, pinCheck.errors);

  if (!session.agentPresent) {
    return failedUart(options, baud, mode, agentUnavailableHelp(session.agentDetail, session.agentErrorKind));
  }

  const raw: RawInterpretation[] = [];
  const warnings: string[] = [...pinCheck.warnings];
  const baudClues: string[] = [];

  const uartParams = {
    controller,
    rx: options.rx,
    ...(options.tx !== undefined ? { tx: options.tx } : {}),
    dataBits,
    parity,
    stopBits,
  };

  // --- Baud scan (passive) ------------------------------------------------
  let effectiveBaud = baud;
  if (scanBauds) {
    const candidates = [baud, ...COMMON_BAUD_RATES.filter((b) => b !== baud)];
    let best: { baud: number; score: number; bytes: number } | null = null;

    for (const candidate of candidates) {
      const listen = await session.transport.request<{ bytes?: number[] }>(
        'uart.listen',
        { ...uartParams, baud: candidate, durationMs: 800 },
        { timeoutMs: 6000 }
      );
      const bytes = listen.ok && Array.isArray(listen.data?.bytes) ? listen.data!.bytes! : [];
      const score = scoreCapture(bytes);
      baudClues.push(
        `${candidate} baud: ${bytes.length} byte(s), printable-structure score ${score.toFixed(2)}`
      );
      if (bytes.length > 0 && (best === null || score > best.score)) {
        best = { baud: candidate, score, bytes: bytes.length };
      }
    }

    if (best && best.baud !== baud) {
      effectiveBaud = best.baud;
      warnings.push(
        `Baud scan selected ${best.baud} over the requested ${baud} (higher structure score). ` +
          'The scan is heuristic: a high score means the capture looks like framed text, not ' +
          'that the rate is confirmed.'
      );
    } else if (!best) {
      baudClues.push('No candidate baud rate produced any bytes.');
    }
  }

  // --- Passive capture ----------------------------------------------------
  const listen = await session.transport.request<{
    bytes?: number[];
    gapsUs?: number[];
    truncated?: boolean;
  }>(
    'uart.listen',
    { ...uartParams, baud: effectiveBaud, durationMs },
    { ...(timeoutMs !== undefined ? { timeoutMs } : { timeoutMs: durationMs + 6000 }) }
  );

  raw.push(
    rawInterpretation(
      listen.raw,
      listen.data,
      listen.ok
        ? `Passive UART capture, ${durationMs} ms at ${effectiveBaud} baud`
        : `UART capture failed: ${listen.error}`,
      listen.ok ? 'DEVICE_RESPONSE' : 'NONE',
      listen.ok ? 'HIGH' : 'UNKNOWN'
    )
  );

  if (!listen.ok) {
    return failedUart(options, effectiveBaud, mode, [listen.error ?? 'UART capture failed'], raw);
  }

  const bytes = (listen.data?.bytes ?? []).map((b) => b & 0xff);
  const gaps = listen.data?.gapsUs ?? [];

  if (listen.data?.truncated) {
    warnings.push(
      'Capture hit the agent byte limit before the duration elapsed; the stream continued beyond ' +
        'what is shown here.'
    );
  }

  // --- Active probing (profile-declared only) ----------------------------
  const componentProfile = options.component ? findProfile(options.component) : null;
  if (options.component && !componentProfile) {
    warnings.push(`No registered component profile matches "${options.component}".`);
  }

  if (mode === 'ACTIVE' && options.transmit !== undefined) {
    const response = await session.transport.request<{ bytes?: number[] }>(
      'uart.writeRead',
      {
        ...uartParams,
        baud: effectiveBaud,
        write: options.transmit,
        readLength: options.readLength ?? 64,
        timeoutMs: options.timeoutMs ?? 1000,
      },
      { timeoutMs: (options.timeoutMs ?? 1000) + 4000 }
    );

    raw.push(
      rawInterpretation(
        response.raw,
        response.data,
        response.ok
          ? `Sent ${toHex(options.transmit)}; received ${
              Array.isArray(response.data?.bytes) ? response.data!.bytes!.length : 0
            } byte(s)`
          : `Active transmit failed: ${response.error}`,
        response.ok ? 'DEVICE_RESPONSE' : 'NONE',
        response.ok ? 'HIGH' : 'UNKNOWN'
      )
    );

    if (response.ok && Array.isArray(response.data?.bytes)) {
      bytes.push(...response.data!.bytes!.map((b) => b & 0xff));
    } else if (!response.ok) {
      warnings.push(`Active transmit failed: ${response.error ?? 'unknown error'}`);
    }
  }

  if (mode === 'ACTIVE' && componentProfile) {
    const uartProbes = componentProfile.safeProbes.filter(
      (p) => p.interface === 'UART' && shouldRunProbe(p, 'STANDARD')
    );
    const results = await executeProbes(
      uartProbes,
      {
        transport: session.transport,
        uart: {
          controller,
          ...(options.rx !== undefined ? { rx: options.rx } : {}),
          ...(options.tx !== undefined ? { tx: options.tx } : {}),
          baud: effectiveBaud,
          dataBits,
          parity,
          stopBits: stopBits as 1 | 2,
        },
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      },
      'STANDARD'
    );
    for (const result of results) {
      raw.push(result.raw);
      if (result.executed && result.bytes.length > 0) bytes.push(...result.bytes);
    }
  }

  // --- Analysis -----------------------------------------------------------
  const packets = splitPackets(bytes, gaps, effectiveBaud);
  const ascii = toPrintableAscii(bytes);
  const repeatedPatterns = findRepeatedPatterns(bytes, 2, 6, 3);
  const protocolCandidates = detectUartProtocols(bytes, ascii);

  if (bytes.length === 0) {
    warnings.push(
      'No bytes were captured. That does not establish silence — an idle device, a wrong baud ' +
        'rate, swapped TX/RX, or a missing common ground all look identical from here.'
    );
    baudClues.push('Zero bytes captured; the configured baud rate could not be assessed.');
  } else {
    const printableRatio = bytes.filter((b) => b >= 0x20 && b <= 0x7e).length / bytes.length;
    if (printableRatio < 0.3) {
      baudClues.push(
        `Only ${(printableRatio * 100).toFixed(0)}% of bytes are printable ASCII. If the peer is ` +
          'expected to emit text, the baud rate is probably wrong — try scanBauds: true.'
      );
    } else if (printableRatio > 0.85) {
      baudClues.push(
        `${(printableRatio * 100).toFixed(0)}% printable ASCII — consistent with a correct baud ` +
          'rate on a text protocol.'
      );
    }
  }

  const identification =
    bytes.length > 0
      ? identifyComponent(
          {
            streamBytes: bytes,
            ...(componentProfile ? { candidateIds: [componentProfile.id] } : {}),
          },
          raw
        )
      : null;

  if (identification?.identified) {
    protocolCandidates.push({
      componentId: identification.identified.componentId,
      partNumber: identification.identified.partNumber,
      reason: `Identification engine scored ${identification.identified.score.toFixed(2)} on the capture`,
      confidence: identification.confidence,
      addressOnly: false,
    });
  }

  return {
    success: true,
    controller: `UART${controller}`,
    pins: [
      { signal: 'RX', gpio: options.rx ?? null, known: options.rx !== undefined },
      { signal: 'TX', gpio: options.tx ?? null, known: options.tx !== undefined },
    ],
    baud: effectiveBaud,
    dataBits,
    parity,
    stopBits: stopBits as 1 | 2,
    flowControl: 'none',
    mode,
    captureDurationMs: durationMs,
    totalBytes: bytes.length,
    packets,
    hex: toHex(bytes),
    ascii,
    repeatedPatterns,
    baudClues,
    protocolCandidates,
    confidence: bytes.length === 0 ? 'UNKNOWN' : ascii !== null ? 'HIGH' : 'MEDIUM',
    warnings,
    errors: [],
    raw,
  };
}

/** Heuristic score for how much a capture looks like framed, meaningful data. */
function scoreCapture(bytes: number[]): number {
  if (bytes.length === 0) return 0;
  const printable = bytes.filter(
    (b) => (b >= 0x20 && b <= 0x7e) || b === 0x0a || b === 0x0d
  ).length;
  const distinct = new Set(bytes).size;
  const printableRatio = printable / bytes.length;
  // Reward printability and byte diversity; a stream of one repeated value scores
  // near zero even if that value is printable.
  const diversity = Math.min(distinct / 16, 1);
  return printableRatio * 0.7 + diversity * 0.3;
}

/**
 * Split a byte stream into packets on inter-byte gaps.
 * The boundary is three character times, the conventional idle-line threshold.
 */
function splitPackets(bytes: number[], gapsUs: number[], baud: number): UartCapturePacket[] {
  if (bytes.length === 0) return [];

  const charTimeUs = (10 / baud) * 1_000_000;
  const boundaryUs = charTimeUs * 3;
  const packets: UartCapturePacket[] = [];

  let current: number[] = [];
  let startOffset = 0;
  let elapsedUs = 0;
  let packetStartUs = 0;

  const flush = () => {
    if (current.length === 0) return;
    const ascii = toPrintableAscii(current);
    packets.push({
      offset: startOffset,
      timestampMs: Math.round(packetStartUs / 1000),
      bytes: [...current],
      hex: toHex(current),
      ascii,
      printable: ascii !== null,
    });
    current = [];
  };

  for (let i = 0; i < bytes.length; i++) {
    const gap = gapsUs[i] ?? 0;
    elapsedUs += gap;
    if (i > 0 && gap > boundaryUs) {
      flush();
      startOffset = i;
      packetStartUs = elapsedUs;
    }
    current.push(bytes[i]);
  }
  flush();

  // Cap the packet list so a long capture cannot produce an unbounded report.
  return packets.slice(0, 200);
}

/** Recognise well-known UART framing without claiming a specific part. */
function detectUartProtocols(bytes: number[], ascii: string | null): ComponentMatchHint[] {
  const hints: ComponentMatchHint[] = [];

  if (ascii) {
    if (/\$[A-Z]{5},/.test(ascii)) {
      hints.push({
        componentId: 'protocol:nmea0183',
        partNumber: 'NMEA 0183 talker',
        reason: 'Capture contains "$" followed by a five-character sentence identifier and a comma',
        confidence: 'MEDIUM',
        addressOnly: false,
      });
    }
    if (/\bAT[\r\n+]/.test(ascii) || /\bOK\r?\n/.test(ascii)) {
      hints.push({
        componentId: 'protocol:at-commands',
        partNumber: 'AT command modem',
        reason: 'Capture contains AT command or OK response framing',
        confidence: 'LOW',
        addressOnly: false,
      });
    }
    if (/<\?xml|\{"|\}\s*$/.test(ascii)) {
      hints.push({
        componentId: 'protocol:structured-text',
        partNumber: 'Structured text (JSON/XML)',
        reason: 'Capture contains JSON or XML delimiters',
        confidence: 'LOW',
        addressOnly: false,
      });
    }
  }

  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === 0xb5 && bytes[i + 1] === 0x62) {
      hints.push({
        componentId: 'protocol:ubx',
        partNumber: 'u-blox UBX binary protocol',
        reason: 'Capture contains the UBX sync sequence B5 62',
        confidence: 'MEDIUM',
        addressOnly: false,
      });
      break;
    }
  }

  if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0xff) {
    hints.push({
      componentId: 'protocol:pn532-frame',
      partNumber: 'PN532 normal information frame',
      reason: 'Capture begins with the 00 00 FF preamble and start code',
      confidence: 'MEDIUM',
      addressOnly: false,
    });
  }

  return hints;
}

function failedUart(
  options: UartDiscoveryOptions,
  baud: number,
  mode: 'PASSIVE' | 'ACTIVE',
  errors: string[],
  raw: RawInterpretation[] = []
): UartDiscoveryReport {
  return {
    success: false,
    controller: `UART${options.controller ?? 1}`,
    pins: [
      { signal: 'RX', gpio: options.rx ?? null, known: options.rx !== undefined },
      { signal: 'TX', gpio: options.tx ?? null, known: options.tx !== undefined },
    ],
    baud,
    dataBits: options.dataBits ?? 8,
    parity: options.parity ?? 'none',
    stopBits: options.stopBits ?? 1,
    flowControl: 'none',
    mode,
    captureDurationMs: 0,
    totalBytes: 0,
    packets: [],
    hex: '',
    ascii: null,
    repeatedPatterns: [],
    baudClues: [],
    protocolCandidates: [],
    confidence: 'UNKNOWN',
    warnings: [],
    errors,
    raw,
    error: errors[0],
  };
}
