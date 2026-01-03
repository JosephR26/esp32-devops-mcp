/**
 * Performance benchmark tools
 * Wraps performance-benchmark.py
 */

import { executePython, getTestingScriptPath } from '../utils/exec.js';
import { parseBenchmarkOutput } from '../utils/parser.js';
import { validateSerialPort, validateBaudRate, validateDuration } from '../utils/validation.js';
import type { PerformanceBenchmark } from '../types/index.js';

const SCRIPT_PATH = getTestingScriptPath('performance-benchmark.py');

/**
 * Run performance benchmark on ESP32 firmware
 */
export async function runBenchmark(
  port?: string,
  duration: number = 60,
  baudRate: number = 115200
): Promise<{
  benchmark?: PerformanceBenchmark;
  success: boolean;
  error?: string;
}> {
  // Validate inputs
  if (port && !validateSerialPort(port)) {
    return {
      success: false,
      error: `Invalid serial port: ${port}`
    };
  }

  if (!validateBaudRate(baudRate)) {
    return {
      success: false,
      error: `Invalid baud rate: ${baudRate}. Must be one of: 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600`
    };
  }

  if (!validateDuration(duration)) {
    return {
      success: false,
      error: `Invalid duration: ${duration}. Must be between 1 and 3600 seconds`
    };
  }

  // Build arguments
  const args: string[] = [];
  if (port) {
    args.push('--port', port);
  }
  args.push('--duration', duration.toString());
  args.push('--baudrate', baudRate.toString());

  // Execute benchmark
  const result = await executePython(SCRIPT_PATH, args, {
    timeout: (duration + 30) * 1000 // Duration + 30s buffer
  });

  if (!result.success) {
    return {
      success: false,
      error: result.stderr || 'Benchmark failed'
    };
  }

  // Parse benchmark results
  const benchmark = parseBenchmarkOutput(result.stdout);

  if (!benchmark) {
    return {
      success: false,
      error: 'Failed to parse benchmark results'
    };
  }

  return {
    benchmark,
    success: true
  };
}

/**
 * Quick performance check (30 second test)
 */
export async function quickBenchmark(port?: string): Promise<{
  benchmark?: PerformanceBenchmark;
  success: boolean;
  error?: string;
}> {
  return runBenchmark(port, 30);
}

/**
 * Memory leak detection test
 */
export async function detectMemoryLeaks(
  port?: string,
  duration: number = 300
): Promise<{
  hasLeak: boolean;
  leakRate?: number;
  details?: PerformanceBenchmark;
  success: boolean;
  error?: string;
}> {
  const result = await runBenchmark(port, duration);

  if (!result.success || !result.benchmark) {
    return {
      hasLeak: false,
      success: false,
      error: result.error
    };
  }

  const leak = result.benchmark.memoryAnalysis.leak;
  const leakRate = leak / duration; // bytes per second

  return {
    hasLeak: Math.abs(leak) > 100, // More than 100 bytes leaked
    leakRate,
    details: result.benchmark,
    success: true
  };
}

/**
 * WiFi performance test
 */
export async function testWiFiPerformance(
  port?: string,
  duration: number = 120
): Promise<{
  averageSignal?: number;
  signalQuality?: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR';
  success: boolean;
  error?: string;
}> {
  const result = await runBenchmark(port, duration);

  if (!result.success || !result.benchmark || !result.benchmark.wifiSignal) {
    return {
      success: false,
      error: result.error || 'WiFi signal data not available'
    };
  }

  const avgSignal = result.benchmark.wifiSignal.avg;
  let signalQuality: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR';

  if (avgSignal >= -50) {
    signalQuality = 'EXCELLENT';
  } else if (avgSignal >= -60) {
    signalQuality = 'GOOD';
  } else if (avgSignal >= -70) {
    signalQuality = 'FAIR';
  } else {
    signalQuality = 'POOR';
  }

  return {
    averageSignal: avgSignal,
    signalQuality,
    success: true
  };
}

/**
 * Loop performance analysis
 */
export async function analyzeLoopPerformance(
  port?: string,
  duration: number = 60
): Promise<{
  performance?: {
    average: number;
    min: number;
    max: number;
    jitter: number;
    status: 'OPTIMAL' | 'GOOD' | 'SLOW';
  };
  success: boolean;
  error?: string;
}> {
  const result = await runBenchmark(port, duration);

  if (!result.success || !result.benchmark) {
    return {
      success: false,
      error: result.error
    };
  }

  const loop = result.benchmark.loopPerformance;
  const jitter = loop.max - loop.min;

  let status: 'OPTIMAL' | 'GOOD' | 'SLOW';
  if (loop.avg < 10) {
    status = 'OPTIMAL';
  } else if (loop.avg < 50) {
    status = 'GOOD';
  } else {
    status = 'SLOW';
  }

  return {
    performance: {
      average: loop.avg,
      min: loop.min,
      max: loop.max,
      jitter,
      status
    },
    success: true
  };
}
