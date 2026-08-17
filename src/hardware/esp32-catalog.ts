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

/**
 * Strapping pins. These are usable, but their level at reset selects the boot
 * mode, so driving them can prevent the board rebooting normally.
 *
 * Reported as a warning, never a refusal — a strapping pin is a real pin and an
 * experiment may legitimately need it.
 */
export function strappingPins(family: Esp32Family): number[] {
  switch (family) {
    case 'ESP32':
      return [0, 2, 5, 12, 15];
    case 'ESP32-S2':
      return [0, 45, 46];
    case 'ESP32-S3':
      return [0, 3, 45, 46];
    case 'ESP32-C3':
      return [2, 8, 9];
    case 'ESP32-C6':
      return [4, 5, 8, 9, 15];
    case 'ESP32-H2':
      return [2, 3, 8, 9, 25];
    case 'ESP8266':
      return [0, 2, 15];
    default:
      return [];
  }
}

/** Pins wired to the on-board USB-serial bridge or native USB. */
export function usbPins(family: Esp32Family): number[] {
  switch (family) {
    case 'ESP32-S2':
    case 'ESP32-S3':
      return [19, 20];
    case 'ESP32-C3':
    case 'ESP32-C6':
    case 'ESP32-H2':
      return [12, 13];
    default:
      return [];
  }
}

/** ADC-capable pins per family, from the datasheet pin multiplexing tables. */
export function adcPins(family: Esp32Family): number[] {
  switch (family) {
    case 'ESP32':
      // ADC1: 32-39. ADC2: 0,2,4,12-15,25-27 (unusable while Wi-Fi is active).
      return [32, 33, 34, 35, 36, 37, 38, 39, 0, 2, 4, 12, 13, 14, 15, 25, 26, 27];
    case 'ESP32-S2':
    case 'ESP32-S3':
      return Array.from({ length: 20 }, (_, i) => i + 1);
    case 'ESP32-C3':
      return [0, 1, 2, 3, 4, 5];
    case 'ESP32-C6':
      return [0, 1, 2, 3, 4, 5, 6];
    case 'ESP32-H2':
      return [1, 2, 3, 4, 5];
    case 'ESP8266':
      return [17]; // A0
    default:
      return [];
  }
}

/** DAC-capable pins per family. */
export function dacPins(family: Esp32Family): number[] {
  switch (family) {
    case 'ESP32':
      return [25, 26];
    case 'ESP32-S2':
      return [17, 18];
    default:
      return [];
  }
}

/** Capacitive-touch-capable pins per family. */
export function touchPins(family: Esp32Family): number[] {
  switch (family) {
    case 'ESP32':
      return [0, 2, 4, 12, 13, 14, 15, 27, 32, 33];
    case 'ESP32-S2':
    case 'ESP32-S3':
      return Array.from({ length: 14 }, (_, i) => i + 1);
    default:
      return [];
  }
}

/** Highest valid GPIO number for a family. */
export function maxGpio(family: Esp32Family): number {
  switch (family) {
    case 'ESP32':
      return 39;
    case 'ESP32-S2':
      return 46;
    case 'ESP32-S3':
      return 48;
    case 'ESP32-C3':
      return 21;
    case 'ESP32-C6':
      return 30;
    case 'ESP32-H2':
      return 27;
    case 'ESP8266':
      return 17;
    default:
      return 48; // Permissive when the family is unknown; the agent still checks.
  }
}

/** What a single physical pin can actually do on this chip. */
export interface PinCapability {
  gpio: number;
  /** False when the pin does not exist on this family or is wired to flash. */
  usable: boolean;
  /** Reason the pin is unusable, when it is. */
  unusableReason?: string;
  digitalInput: boolean;
  digitalOutput: boolean;
  /** Output-capable peripherals all require digitalOutput. */
  pwm: boolean;
  adc: boolean;
  dac: boolean;
  touch: boolean;
  /** Pin can carry any peripheral signal through the GPIO matrix. */
  matrixRoutable: boolean;
  /** Advisory notes — strapping, USB, JTAG, etc. Never a refusal. */
  notes: string[];
}

/**
 * Full pin capability map for a family.
 *
 * This is what makes generic experimentation safe without a component profile:
 * validation is against what the silicon can do, not against a catalogue of
 * anticipated components.
 */
export function pinCapabilities(family: Esp32Family): PinCapability[] {
  const max = maxGpio(family);
  const reserved = reservedPins(family);
  const inputOnly = inputOnlyPins(family);
  const strapping = strappingPins(family);
  const usb = usbPins(family);
  const adc = adcPins(family);
  const dac = dacPins(family);
  const touch = touchPins(family);

  // Gaps in the GPIO numbering, per family pinout tables.
  const nonExistent = (gpio: number): boolean => {
    if (family === 'ESP32') return gpio === 20 || (gpio >= 24 && gpio <= 24) || gpio === 28 || gpio === 29 || gpio === 30 || gpio === 31;
    if (family === 'ESP32-S3') return gpio === 22 || gpio === 23 || gpio === 24 || gpio === 25;
    return false;
  };

  const pins: PinCapability[] = [];

  for (let gpio = 0; gpio <= max; gpio++) {
    const notes: string[] = [];

    if (nonExistent(gpio)) {
      pins.push({
        gpio,
        usable: false,
        unusableReason: `GPIO${gpio} is not bonded out on ${family}`,
        digitalInput: false,
        digitalOutput: false,
        pwm: false,
        adc: false,
        dac: false,
        touch: false,
        matrixRoutable: false,
        notes,
      });
      continue;
    }

    if (reserved.includes(gpio)) {
      pins.push({
        gpio,
        usable: false,
        unusableReason:
          `GPIO${gpio} is wired to SPI flash/PSRAM on ${family}. Driving it corrupts execution.`,
        digitalInput: false,
        digitalOutput: false,
        pwm: false,
        adc: false,
        dac: false,
        touch: false,
        matrixRoutable: false,
        notes,
      });
      continue;
    }

    const isInputOnly = inputOnly.includes(gpio);
    if (isInputOnly) notes.push('Input-only: no output driver, no pull-up/pull-down.');
    if (strapping.includes(gpio)) {
      notes.push(
        'Strapping pin: its level at reset selects boot mode. Usable, but holding it may ' +
          'prevent a normal reboot.'
      );
    }
    if (usb.includes(gpio)) notes.push('Wired to native USB / USB-Serial-JTAG on this family.');
    if (family === 'ESP32' && [12, 13, 14, 15].includes(gpio)) {
      notes.push('Default JTAG pin; free to use unless a debugger is attached.');
    }
    if (family === 'ESP32' && adc.includes(gpio) && gpio < 32) {
      notes.push('ADC2 channel: unavailable while Wi-Fi is active.');
    }

    pins.push({
      gpio,
      usable: true,
      digitalInput: true,
      digitalOutput: !isInputOnly,
      pwm: !isInputOnly,
      adc: adc.includes(gpio),
      dac: dac.includes(gpio),
      touch: touch.includes(gpio),
      matrixRoutable: !isInputOnly,
      notes,
    });
  }

  return pins;
}

/** Capability record for one pin, or null when the pin does not exist. */
export function pinCapability(family: Esp32Family, gpio: number): PinCapability | null {
  return pinCapabilities(family).find((p) => p.gpio === gpio) ?? null;
}
