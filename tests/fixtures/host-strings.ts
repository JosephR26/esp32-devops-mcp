/**
 * Real strings from real hosts.
 *
 * Every bug found while bringing this server up on Windows was an input-shape
 * bug: the logic was fine against tidy synthetic input and wrong against what an
 * actual machine produces. A drive colon, a platform UART with "UART" in its
 * name, a Microsoft Store alias that exits 9009 instead of ENOENT. None of them
 * were visible to a suite that never saw a real host string.
 *
 * So this file collects those strings and keeps them where tests can sweep them.
 *
 * PROVENANCE IS PART OF THE DATA. Each entry says where it came from:
 *
 *   'observed'       - copied verbatim from a machine this project ran on. If it
 *                      is marked observed, it really was emitted by a host.
 *   'representative' - the documented or widely-reported form for hardware this
 *                      project has not run against here. Realistic, but not
 *                      witnessed, and must not be described as if it were.
 *
 * When you meet a new host string in the wild - especially one that breaks
 * something - add it here as 'observed' rather than inventing a tidy equivalent.
 */

/** Where a fixture string came from. See the file header. */
export type Provenance = 'observed' | 'representative';

export interface PortDescriptionFixture {
  /** The description exactly as the host reports it. */
  description: string;
  /** Whether this port should be treated as plausibly carrying an ESP32. */
  isEsp32: boolean;
  /** Expected bridge family, or null when no USB-serial bridge is named. */
  bridge: string | null;
  provenance: Provenance;
  note?: string;
}

/**
 * Serial port descriptions.
 *
 * The Qualcomm entries are the ones that mattered: they are ordinary host
 * platform UARTs, they contain the word "UART", and both the hardcoded
 * `isESP32: true` and the older bare-substring heuristic claimed they were
 * ESP32 boards. Flashing one would target a host-internal device.
 */
export const PORT_DESCRIPTIONS: readonly PortDescriptionFixture[] = [
  {
    description: 'USB-SERIAL CH340 (COM3)',
    isEsp32: true,
    bridge: 'WCH CH34x',
    provenance: 'observed',
    note: 'The ESP32 devkit this project is developed against.',
  },
  {
    description: 'Qualcomm(R) UART Bus Device (COM1)',
    isEsp32: false,
    bridge: null,
    provenance: 'observed',
    note: 'ACPI platform UART on an ARM64 Windows laptop. Not USB, not an ESP32.',
  },
  {
    description: 'Qualcomm(R) UART Bus Device (COM2)',
    isEsp32: false,
    bridge: null,
    provenance: 'observed',
  },
  {
    description: 'Silicon Labs CP210x USB to UART Bridge (COM5)',
    isEsp32: true,
    bridge: 'Silicon Labs CP210x',
    provenance: 'representative',
    note: 'Note the model is "CP210x" with a literal x, not a digit.',
  },
  {
    description: 'CP2102 USB to UART Bridge Controller',
    isEsp32: true,
    bridge: 'Silicon Labs CP210x',
    provenance: 'representative',
    note: 'Linux form: no vendor name, so the model alone must be enough.',
  },
  {
    description: 'USB JTAG/serial debug unit (COM9)',
    isEsp32: true,
    bridge: 'ESP32 native USB (JTAG/serial)',
    provenance: 'representative',
    note: 'ESP32-S3/C3 native USB - no bridge chip at all.',
  },
  {
    description: 'FT232R USB UART',
    isEsp32: true,
    bridge: 'FTDI FT23x',
    provenance: 'representative',
  },
  {
    description: 'USB-Enhanced-SERIAL CH9102 (COM6)',
    isEsp32: true,
    bridge: 'WCH CH34x',
    provenance: 'representative',
    note: 'CH9102 is the newer WCH bridge on many recent boards.',
  },
  {
    description: 'Standard Serial over Bluetooth link (COM8)',
    isEsp32: false,
    bridge: null,
    provenance: 'representative',
    note: 'Virtual port. Contains "Serial" but no USB bridge.',
  },
  {
    description: 'Intel(R) Active Management Technology - SOL (COM4)',
    isEsp32: false,
    bridge: null,
    provenance: 'representative',
    note: 'Serial-over-LAN. A management interface, not a board.',
  },
  {
    description: 'Communications Port (COM1)',
    isEsp32: false,
    bridge: null,
    provenance: 'representative',
    note: 'Legacy 16550 UART.',
  },
];

export interface ProjectPathFixture {
  path: string;
  valid: boolean;
  provenance: Provenance;
  note?: string;
}

/**
 * Project paths.
 *
 * The absolute Windows paths are the point: validation used to reject the drive
 * colon, so every one of these failed and took `esp32_build`, `esp32_flash` and
 * `esp32_hardware_inventory` with them.
 */
export const PROJECT_PATHS: readonly ProjectPathFixture[] = [
  {
    path: 'D:\\josep\\Documents\\GitHub\\esp32-devops-mcp\\firmware\\interrogation-agent',
    valid: true,
    provenance: 'observed',
    note: 'The firmware directory actually built and flashed from.',
  },
  {
    path: 'C:\\Program Files\\nodejs',
    valid: true,
    provenance: 'observed',
    note: 'Spaces are ordinary in Windows paths.',
  },
  {
    path: 'C:\\Users\\josep\\AppData\\Local\\Programs\\Python\\Python312-arm64',
    valid: true,
    provenance: 'observed',
  },
  {
    path: 'G:\\My Drive\\ESP32 Hardware Data',
    valid: true,
    provenance: 'observed',
    note: 'Cloud-synced drive; spaces in both the drive label and folder.',
  },
  {
    path: 'C:\\Program Files (x86)\\Common Files',
    valid: true,
    provenance: 'representative',
    note: 'Parentheses must not be treated as shell metacharacters.',
  },
  {
    path: 'C:/projects/firmware',
    valid: true,
    provenance: 'representative',
    note: 'Windows absolute path with forward slashes — accepted by the Win32 API, and produced by tools that normalise separators.',
  },
  {
    path: 'C:/projects/../../Windows',
    valid: false,
    provenance: 'representative',
    note: 'Traversal must be caught on forward slashes too, not just backslashes.',
  },
  {
    path: '/home/user/projects/firmware',
    valid: true,
    provenance: 'representative',
  },
  {
    path: 'firmware/interrogation-agent',
    valid: true,
    provenance: 'observed',
    note: 'Relative paths stay valid.',
  },
  {
    path: 'C:\\projects\\my..project',
    valid: true,
    provenance: 'representative',
    note: 'Dots inside a name are not traversal.',
  },
  {
    path: '',
    valid: false,
    provenance: 'representative',
  },
  {
    path: '   ',
    valid: false,
    provenance: 'representative',
  },
  {
    path: 'C:\\projects\\..\\..\\Windows\\System32',
    valid: false,
    provenance: 'representative',
    note: 'Directory traversal.',
  },
  {
    path: '../../etc/passwd',
    valid: false,
    provenance: 'representative',
  },
  {
    path: 'C:\\projects\\notes.txt:hidden',
    valid: false,
    provenance: 'representative',
    note: 'NTFS alternate data stream - a colon outside the drive specifier.',
  },
  {
    path: 'C:\\projects\\what?',
    valid: false,
    provenance: 'representative',
    note: 'Wildcards are never legal in a path.',
  },
];

/**
 * The Microsoft Store `python3` alias.
 *
 * Not consumed by an assertion yet: `executePython` hardcodes its candidate list,
 * so the failure cannot be reproduced without injecting one. Recorded here
 * because it is the exact shape that broke interpreter fallback - a candidate
 * that EXISTS on PATH (so never raises ENOENT) but runs nothing and exits
 * non-zero. Any future rewrite of interpreter discovery should be tested against
 * this case.
 */
export const STORE_ALIAS_PYTHON3 = {
  /** Where the stub lives on a default Windows 11 install. */
  path: 'C:\\Users\\<user>\\AppData\\Local\\Microsoft\\WindowsApps\\python3.exe',
  exitCode: 9009,
  stdout:
    'Python was not found; run without arguments to install from the Microsoft Store, ' +
    'or disable this shortcut from Settings > Apps > Advanced app settings > App execution aliases.',
  provenance: 'observed' as Provenance,
} as const;
