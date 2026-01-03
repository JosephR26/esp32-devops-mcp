/**
 * Output parsing utilities for extracting structured data from tool outputs
 */

import type { BuildResult, PerformanceBenchmark, FirmwareTestResult } from '../types/index.js';

/**
 * Parse PlatformIO build output
 */
export function parseBuildOutput(output: string): Partial<BuildResult> {
  const result: Partial<BuildResult> = {
    errors: [],
    warnings: []
  };

  // Extract firmware size
  const sizeMatch = output.match(/RAM:\s+\[.*?\]\s+(\d+)\s+bytes/);
  if (sizeMatch) {
    result.memoryUsage = result.memoryUsage || { ram: 0, flash: 0 };
    result.memoryUsage.ram = parseInt(sizeMatch[1]);
  }

  const flashMatch = output.match(/Flash:\s+\[.*?\]\s+(\d+)\s+bytes/);
  if (flashMatch) {
    result.memoryUsage = result.memoryUsage || { ram: 0, flash: 0 };
    result.memoryUsage.flash = parseInt(flashMatch[1]);
    result.firmwareSize = parseInt(flashMatch[1]);
  }

  // Extract errors
  const errorMatches = output.matchAll(/error:\s+(.+)/gi);
  for (const match of errorMatches) {
    result.errors?.push(match[1].trim());
  }

  // Extract warnings
  const warningMatches = output.matchAll(/warning:\s+(.+)/gi);
  for (const match of warningMatches) {
    result.warnings?.push(match[1].trim());
  }

  return result;
}

/**
 * Parse performance benchmark JSON output
 */
export function parseBenchmarkOutput(output: string): PerformanceBenchmark | null {
  try {
    // Try to find JSON in the output
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }

    // Fallback: parse from text output
    const result: PerformanceBenchmark = {
      memoryAnalysis: {
        initial: 0,
        final: 0,
        leak: 0,
        status: 'PASS'
      },
      loopPerformance: {
        avg: 0,
        min: 0,
        max: 0,
        status: 'PASS'
      }
    };

    // Parse memory analysis
    const memInitMatch = output.match(/Initial heap:\s+(\d+)/i);
    const memFinalMatch = output.match(/Final heap:\s+(\d+)/i);
    const memLeakMatch = output.match(/Memory leak:\s+(-?\d+)/i);

    if (memInitMatch) result.memoryAnalysis.initial = parseInt(memInitMatch[1]);
    if (memFinalMatch) result.memoryAnalysis.final = parseInt(memFinalMatch[1]);
    if (memLeakMatch) {
      result.memoryAnalysis.leak = parseInt(memLeakMatch[1]);
      result.memoryAnalysis.status = result.memoryAnalysis.leak > 100 ? 'FAIL' : 'PASS';
    }

    // Parse loop performance
    const loopAvgMatch = output.match(/Average loop time:\s+([\d.]+)/i);
    const loopMinMatch = output.match(/Min loop time:\s+([\d.]+)/i);
    const loopMaxMatch = output.match(/Max loop time:\s+([\d.]+)/i);

    if (loopAvgMatch) result.loopPerformance.avg = parseFloat(loopAvgMatch[1]);
    if (loopMinMatch) result.loopPerformance.min = parseFloat(loopMinMatch[1]);
    if (loopMaxMatch) result.loopPerformance.max = parseFloat(loopMaxMatch[1]);

    if (result.loopPerformance.avg > 100) {
      result.loopPerformance.status = 'WARNING';
    }

    // Parse WiFi signal (if present)
    const wifiMatch = output.match(/WiFi signal:\s+(-?\d+)/i);
    if (wifiMatch) {
      const signal = parseInt(wifiMatch[1]);
      result.wifiSignal = {
        avg: signal,
        status: signal > -70 ? 'PASS' : 'WARNING'
      };
    }

    return result;
  } catch (error) {
    console.error('Failed to parse benchmark output:', error);
    return null;
  }
}

/**
 * Parse firmware test output
 */
export function parseTestOutput(output: string): FirmwareTestResult {
  const result: FirmwareTestResult = {
    bootTest: {
      passed: false,
      output: ''
    },
    heartbeatTest: {
      passed: false,
      count: 0
    },
    memoryTest: {
      passed: false,
      leak: 0
    }
  };

  // Parse boot test
  if (output.match(/Boot\s+test:\s+PASS/i)) {
    result.bootTest.passed = true;
    const bootOutputMatch = output.match(/Boot output:\s*\n(.*?)(?=\n\n|\n[A-Z]|$)/s);
    if (bootOutputMatch) {
      result.bootTest.output = bootOutputMatch[1].trim();
    }
  }

  // Parse heartbeat test
  const heartbeatMatch = output.match(/Heartbeat\s+test:\s+PASS.*?(\d+)\s+heartbeats/i);
  if (heartbeatMatch) {
    result.heartbeatTest.passed = true;
    result.heartbeatTest.count = parseInt(heartbeatMatch[1]);
  }

  // Parse memory test
  const memoryMatch = output.match(/Memory\s+test:\s+PASS/i);
  if (memoryMatch) {
    result.memoryTest.passed = true;
    const leakMatch = output.match(/Leak:\s+(-?\d+)\s+bytes/i);
    if (leakMatch) {
      result.memoryTest.leak = parseInt(leakMatch[1]);
    }
  }

  return result;
}

/**
 * Parse serial port list output from serial-port-manager.py
 */
export function parseSerialPorts(output: string): any {
  try {
    // Try to parse as JSON first
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }

    // Fallback: parse text output
    const ports: any[] = [];
    const portMatches = output.matchAll(/(\d+)\.\s+(COM\d+)\s+-\s+(.+)/g);

    for (const match of portMatches) {
      ports.push({
        port: match[2],
        description: match[3],
        isESP32: match[3].toLowerCase().includes('cp210') ||
                 match[3].toLowerCase().includes('ch340') ||
                 match[3].toLowerCase().includes('uart')
      });
    }

    return { ports };
  } catch (error) {
    console.error('Failed to parse serial ports:', error);
    return { ports: [] };
  }
}

/**
 * Extract error message from failed command output
 */
export function extractErrorMessage(stderr: string, stdout: string): string {
  // Check stderr first
  if (stderr) {
    // Extract first meaningful error line
    const lines = stderr.split('\n').filter(line => line.trim());
    for (const line of lines) {
      if (line.toLowerCase().includes('error') ||
          line.toLowerCase().includes('failed') ||
          line.toLowerCase().includes('exception')) {
        return line.trim();
      }
    }
    return lines[0] || stderr;
  }

  // Check stdout for errors
  if (stdout) {
    const lines = stdout.split('\n').filter(line => line.trim());
    for (const line of lines) {
      if (line.toLowerCase().includes('error') ||
          line.toLowerCase().includes('failed')) {
        return line.trim();
      }
    }
  }

  return 'Command failed with unknown error';
}
