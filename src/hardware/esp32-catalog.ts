/**
 * Static ESP32 family data, sourced from Espressif datasheets and technical
 * reference manuals.
 *
 * Everything here is DOCUMENTED evidence, never observation. The inventory tool
 * combines it with live agent readings and always labels which is which — a
 * catalog entry saying a part has two I2C controllers is not proof that the unit
 * on the bench has two working I2C controllers.
 */

import type { Esp32Family, Esp32FamilySpec } from '../types/hardware.js';

export const ESP32_FAMILY_SPECS: Record<Esp32Family, Esp32FamilySpec> = {
  ESP32: {
    family: 'ESP32',
    architecture: 'Xtensa LX6 (dual-core)',
    cores: 2,
    maxCpuMHz: 240,
    i2cControllers: 2,
    spiControllers: 4,
    usableSpiControllers: 2, // SPI0/SPI1 serve flash; HSPI + VSPI are user-usable
    uartControllers: 3,
    hardwareTimers: 4,
    adcChannels: 18,
    dacChannels: 2,
    touchChannels: 10,
    pwmChannels: 16,
    gpioCount: 34,
    wifi: true,
    bluetooth: 'Bluetooth Classic + BLE 4.2',
    psramCapable: true,
    note: 'GPIO6-11 are wired to SPI flash and must never be driven. GPIO34-39 are input-only.',
  },
  'ESP32-S2': {
    family: 'ESP32-S2',
    architecture: 'Xtensa LX7 (single-core)',
    cores: 1,
    maxCpuMHz: 240,
    i2cControllers: 2,
    spiControllers: 4,
    usableSpiControllers: 2,
    uartControllers: 2,
    hardwareTimers: 4,
    adcChannels: 20,
    dacChannels: 2,
    touchChannels: 14,
    pwmChannels: 8,
    gpioCount: 43,
    wifi: true,
    bluetooth: null,
    psramCapable: true,
    note: 'No Bluetooth radio. Native USB OTG.',
  },
  'ESP32-S3': {
    family: 'ESP32-S3',
    architecture: 'Xtensa LX7 (dual-core)',
    cores: 2,
    maxCpuMHz: 240,
    i2cControllers: 2,
    spiControllers: 4,
    usableSpiControllers: 2,
    uartControllers: 3,
    hardwareTimers: 4,
    adcChannels: 20,
    dacChannels: 0,
    touchChannels: 14,
    pwmChannels: 8,
    gpioCount: 45,
    wifi: true,
    bluetooth: 'BLE 5.0',
    psramCapable: true,
    note: 'No DAC. Native USB OTG and USB Serial/JTAG.',
  },
  'ESP32-C3': {
    family: 'ESP32-C3',
    architecture: 'RISC-V 32-bit (single-core)',
    cores: 1,
    maxCpuMHz: 160,
    i2cControllers: 1,
    spiControllers: 3,
    usableSpiControllers: 1,
    uartControllers: 2,
    hardwareTimers: 2,
    adcChannels: 6,
    dacChannels: 0,
    touchChannels: 0,
    pwmChannels: 6,
    gpioCount: 22,
    wifi: true,
    bluetooth: 'BLE 5.0',
    psramCapable: false,
    note: 'No DAC, no touch sensing, single I2C controller.',
  },
  'ESP32-C6': {
    family: 'ESP32-C6',
    architecture: 'RISC-V 32-bit (HP + LP cores)',
    cores: 1,
    maxCpuMHz: 160,
    i2cControllers: 2,
    spiControllers: 3,
    usableSpiControllers: 1,
    uartControllers: 3,
    hardwareTimers: 2,
    adcChannels: 7,
    dacChannels: 0,
    touchChannels: 0,
    pwmChannels: 6,
    gpioCount: 31,
    wifi: true,
    bluetooth: 'BLE 5.0 + IEEE 802.15.4 (Thread/Zigbee)',
    psramCapable: false,
    note: 'Wi-Fi 6. Includes a low-power RISC-V core alongside the high-performance core.',
  },
  'ESP32-H2': {
    family: 'ESP32-H2',
    architecture: 'RISC-V 32-bit (single-core)',
    cores: 1,
    maxCpuMHz: 96,
    i2cControllers: 2,
    spiControllers: 3,
    usableSpiControllers: 1,
    uartControllers: 2,
    hardwareTimers: 2,
    adcChannels: 5,
    dacChannels: 0,
    touchChannels: 0,
    pwmChannels: 6,
    gpioCount: 27,
    wifi: false,
    bluetooth: 'BLE 5.0 + IEEE 802.15.4 (Thread/Zigbee)',
    psramCapable: false,
    note: 'No Wi-Fi radio — 802.15.4 and BLE only.',
  },
  ESP8266: {
    family: 'ESP8266',
    architecture: 'Xtensa L106 (single-core)',
    cores: 1,
    maxCpuMHz: 160,
    i2cControllers: 0,
    spiControllers: 2,
    usableSpiControllers: 1,
    uartControllers: 2,
    hardwareTimers: 2,
    adcChannels: 1,
    dacChannels: 0,
    touchChannels: 0,
    pwmChannels: 4,
    gpioCount: 17,
    wifi: true,
    bluetooth: null,
    psramCapable: false,
    note: 'I2C is bit-banged in software — there is no hardware I2C controller.',
  },
  UNKNOWN: {
    family: 'UNKNOWN',
    architecture: 'UNKNOWN',
    cores: 0,
    maxCpuMHz: 0,
    i2cControllers: 0,
    spiControllers: 0,
    usableSpiControllers: 0,
    uartControllers: 0,
    hardwareTimers: 0,
    adcChannels: 0,
    dacChannels: 0,
    touchChannels: 0,
    pwmChannels: 0,
    gpioCount: 0,
    wifi: false,
    bluetooth: null,
    psramCapable: false,
    note: 'Chip family could not be determined. No peripheral counts are asserted.',
  },
};

/**
 * Map a chip string (from the agent, esptool, or a board name) to a family.
 * Returns UNKNOWN rather than guessing when nothing matches.
 */
export function normaliseFamily(input: string | null | undefined): Esp32Family {
  if (!input) return 'UNKNOWN';
  const text = input.toUpperCase().replace(/[\s_]+/g, '-');

  // Longest, most specific matches first so "ESP32-S3" never falls through to "ESP32".
  if (/ESP32-?S3/.test(text)) return 'ESP32-S3';
  if (/ESP32-?S2/.test(text)) return 'ESP32-S2';
  if (/ESP32-?C6/.test(text)) return 'ESP32-C6';
  if (/ESP32-?C3/.test(text)) return 'ESP32-C3';
  if (/ESP32-?H2/.test(text)) return 'ESP32-H2';
  if (/ESP8266/.test(text)) return 'ESP8266';
  if (/ESP32/.test(text)) return 'ESP32';
  return 'UNKNOWN';
}

/** Look up the datasheet spec for a family. */
export function getFamilySpec(family: Esp32Family): Esp32FamilySpec {
  return ESP32_FAMILY_SPECS[family] ?? ESP32_FAMILY_SPECS.UNKNOWN;
}

/** Known USB-UART bridge chips, keyed by a substring of the port description. */
const USB_BRIDGES: { pattern: RegExp; name: string }[] = [
  { pattern: /cp210\d?|cp21\d\d/i, name: 'Silicon Labs CP210x' },
  { pattern: /ch34\d/i, name: 'WCH CH34x' },
  { pattern: /ft23\d|ftdi/i, name: 'FTDI FT23x' },
  { pattern: /ch9102/i, name: 'WCH CH9102' },
  { pattern: /usb\s*jtag|usb\s*serial\/jtag/i, name: 'Espressif USB Serial/JTAG (native)' },
];

/** Identify the USB-UART bridge from a port description, or null when unclear. */
export function identifyUsbBridge(description: string | null | undefined): string | null {
  if (!description) return null;
  for (const bridge of USB_BRIDGES) {
    if (bridge.pattern.test(description)) return bridge.name;
  }
  return null;
}

/**
 * GPIO that must never be driven on a given family.
 * The interrogation tools refuse to configure a bus on these pins.
 */
export function reservedPins(family: Esp32Family): number[] {
  switch (family) {
    case 'ESP32':
      return [6, 7, 8, 9, 10, 11]; // SPI flash
    case 'ESP32-S2':
    case 'ESP32-S3':
      return [26, 27, 28, 29, 30, 31, 32]; // SPI flash / PSRAM on most modules
    default:
      return [];
  }
}

/** Input-only pins, which cannot serve as SDA, MOSI, SCLK, CS or TX. */
export function inputOnlyPins(family: Esp32Family): number[] {
  return family === 'ESP32' ? [34, 35, 36, 37, 38, 39] : [];
}
