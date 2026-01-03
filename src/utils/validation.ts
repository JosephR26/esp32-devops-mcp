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
