/**
 * Input validation utilities
 */

/**
 * Validate serial port name
 */
export function validateSerialPort(port: string): boolean {
  // Windows COM ports: COM1, COM2, etc.
  // Unix/Linux: /dev/ttyUSB0, /dev/ttyACM0, etc.
  const windowsPattern = /^COM\d+$/i;
  const unixPattern = /^\/dev\/tty(USB|ACM|S)\d+$/;

  return windowsPattern.test(port) || unixPattern.test(port);
}

/**
 * Validate baud rate
 */
export function validateBaudRate(rate: number): boolean {
  const validRates = [
    9600, 19200, 38400, 57600, 115200,
    230400, 460800, 921600
  ];

  return validRates.includes(rate);
}

/**
 * Validate project path
 */
export function validateProjectPath(path: string): boolean {
  // Must not be empty
  if (!path || path.trim().length === 0) {
    return false;
  }

  // Must not contain dangerous characters
  const dangerousPattern = /[<>:"|?*]/;
  if (dangerousPattern.test(path)) {
    return false;
  }

  return true;
}

/**
 * Validate environment name
 */
export function validateEnvironment(env: string): boolean {
  // Must be alphanumeric with underscores and hyphens
  const pattern = /^[a-zA-Z0-9_-]+$/;
  return pattern.test(env);
}

/**
 * Validate duration (in seconds)
 */
export function validateDuration(duration: number): boolean {
  return duration > 0 && duration <= 3600; // Max 1 hour
}

/**
 * Sanitize path for command line usage
 */
export function sanitizePath(path: string): string {
  // Remove any shell metacharacters
  return path.replace(/[;&|`$()]/g, '');
}

// ---------------------------------------------------------------------------
// Hardware interrogation validation
// ---------------------------------------------------------------------------

/**
 * Validate a GPIO number.
 * Bounds only — whether a specific pin is safe on a specific chip is decided by
 * the ESP32 catalog, which knows the reserved ranges per family.
 */
export function validateGpioPin(pin: number): boolean {
  return Number.isInteger(pin) && pin >= 0 && pin <= 48;
}

/** Validate a 7-bit I2C address. */
export function validateI2CAddress(address: number): boolean {
  return Number.isInteger(address) && address >= 0x00 && address <= 0x7f;
}

/** Validate an I2C bus frequency (1 kHz to 1 MHz). */
export function validateI2CFrequency(frequencyHz: number): boolean {
  return Number.isFinite(frequencyHz) && frequencyHz >= 1000 && frequencyHz <= 1000000;
}

/** Validate an SPI clock frequency (10 kHz to 40 MHz). */
export function validateSpiClock(clockHz: number): boolean {
  return Number.isFinite(clockHz) && clockHz >= 10000 && clockHz <= 40000000;
}

/** Validate an SPI mode (0-3). */
export function validateSpiMode(mode: number): boolean {
  return Number.isInteger(mode) && mode >= 0 && mode <= 3;
}

/**
 * Validate an arbitrary UART baud rate for a probed device.
 * Wider than validateBaudRate, which constrains the host console link to the
 * rates the FirmwareToolkit scripts accept.
 */
export function validateProbeBaudRate(baud: number): boolean {
  return Number.isInteger(baud) && baud >= 300 && baud <= 3000000;
}

/** Validate a component identifier before it is used to look up a profile. */
export function validateComponentIdentifier(identifier: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._+/-]{0,63}$/.test(identifier);
}

/** Validate a capture or timeout duration in milliseconds. */
export function validateDurationMs(ms: number, maxMs = 120000): boolean {
  return Number.isFinite(ms) && ms > 0 && ms <= maxMs;
}

/** Validate an iteration count for repeated measurements. */
export function validateIterations(count: number, maxCount = 500): boolean {
  return Number.isInteger(count) && count >= 1 && count <= maxCount;
}

/** Validate a byte array intended for transmission on a bus. */
export function validateByteArray(bytes: unknown, maxLength = 512): bytes is number[] {
  return (
    Array.isArray(bytes) &&
    bytes.length > 0 &&
    bytes.length <= maxLength &&
    bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 0xff)
  );
}

/**
 * Validate and sanitize command line arguments
 */
export function validateArgs(args: any): { valid: boolean; error?: string } {
  // Check for command injection attempts
  const dangerousPatterns = [
    /[;&|`]/,  // Shell operators
    /\$\(/,    // Command substitution
    /\.\.\//,  // Directory traversal
  ];

  const argsString = JSON.stringify(args);

  for (const pattern of dangerousPatterns) {
    if (pattern.test(argsString)) {
      return {
        valid: false,
        error: 'Invalid characters detected in arguments'
      };
    }
  }

  return { valid: true };
}
