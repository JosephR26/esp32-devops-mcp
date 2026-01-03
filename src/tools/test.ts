/**
 * Firmware testing tools
 * Wraps serial-test.py
 */

import { executePython, getTestingScriptPath } from '../utils/exec.js';
import { parseTestOutput } from '../utils/parser.js';
import { validateSerialPort, validateBaudRate } from '../utils/validation.js';
import type { FirmwareTestResult } from '../types/index.js';

const SCRIPT_PATH = getTestingScriptPath('serial-test.py');

/**
 * Run automated firmware tests
 */
export async function runFirmwareTests(
  port?: string,
  baudRate: number = 115200
): Promise<{
  testResult?: FirmwareTestResult;
  allPassed: boolean;
  summary?: string;
  success: boolean;
  error?: string;
}> {
  // Validate inputs
  if (port && !validateSerialPort(port)) {
    return {
      allPassed: false,
      success: false,
      error: `Invalid serial port: ${port}`
    };
  }

  if (!validateBaudRate(baudRate)) {
    return {
      allPassed: false,
      success: false,
      error: `Invalid baud rate: ${baudRate}`
    };
  }

  // Build arguments
  const args: string[] = [];
  if (port) {
    args.push('--port', port);
  }
  args.push('--baudrate', baudRate.toString());

  // Execute tests
  const result = await executePython(SCRIPT_PATH, args, {
    timeout: 120000 // 2 minutes for tests
  });

  if (!result.success) {
    return {
      allPassed: false,
      success: false,
      error: result.stderr || 'Tests failed to execute'
    };
  }

  // Parse test results
  const testResult = parseTestOutput(result.stdout);

  const allPassed = testResult.bootTest.passed &&
                     testResult.heartbeatTest.passed &&
                     testResult.memoryTest.passed;

  const summary = generateTestSummary(testResult);

  return {
    testResult,
    allPassed,
    summary,
    success: true
  };
}

/**
 * Run boot verification test only
 */
export async function testBoot(port?: string): Promise<{
  passed: boolean;
  bootOutput?: string;
  success: boolean;
  error?: string;
}> {
  const result = await runFirmwareTests(port);

  if (!result.success || !result.testResult) {
    return {
      passed: false,
      success: false,
      error: result.error
    };
  }

  return {
    passed: result.testResult.bootTest.passed,
    bootOutput: result.testResult.bootTest.output,
    success: true
  };
}

/**
 * Run heartbeat detection test
 */
export async function testHeartbeat(port?: string): Promise<{
  passed: boolean;
  heartbeatCount?: number;
  success: boolean;
  error?: string;
}> {
  const result = await runFirmwareTests(port);

  if (!result.success || !result.testResult) {
    return {
      passed: false,
      success: false,
      error: result.error
    };
  }

  return {
    passed: result.testResult.heartbeatTest.passed,
    heartbeatCount: result.testResult.heartbeatTest.count,
    success: true
  };
}

/**
 * Run memory stability test
 */
export async function testMemoryStability(port?: string): Promise<{
  passed: boolean;
  memoryLeak?: number;
  stable: boolean;
  success: boolean;
  error?: string;
}> {
  const result = await runFirmwareTests(port);

  if (!result.success || !result.testResult) {
    return {
      passed: false,
      stable: false,
      success: false,
      error: result.error
    };
  }

  const leak = result.testResult.memoryTest.leak;

  return {
    passed: result.testResult.memoryTest.passed,
    memoryLeak: leak,
    stable: Math.abs(leak) < 100, // Less than 100 bytes is stable
    success: true
  };
}

/**
 * Run pre-deployment validation
 */
export async function validateForDeployment(port?: string): Promise<{
  readyForDeployment: boolean;
  issues: string[];
  warnings: string[];
  testResult?: FirmwareTestResult;
  success: boolean;
  error?: string;
}> {
  const result = await runFirmwareTests(port);

  if (!result.success || !result.testResult) {
    return {
      readyForDeployment: false,
      issues: [result.error || 'Failed to run tests'],
      warnings: [],
      success: false,
      error: result.error
    };
  }

  const issues: string[] = [];
  const warnings: string[] = [];

  // Check boot test
  if (!result.testResult.bootTest.passed) {
    issues.push('Boot test failed - device not booting correctly');
  }

  // Check heartbeat test
  if (!result.testResult.heartbeatTest.passed) {
    issues.push('Heartbeat test failed - device not responding');
  } else if (result.testResult.heartbeatTest.count < 5) {
    warnings.push('Low heartbeat count - device may be unstable');
  }

  // Check memory test
  if (!result.testResult.memoryTest.passed) {
    issues.push('Memory test failed - memory leak detected');
  } else if (Math.abs(result.testResult.memoryTest.leak) > 50) {
    warnings.push(`Memory leak detected: ${result.testResult.memoryTest.leak} bytes`);
  }

  const readyForDeployment = issues.length === 0;

  return {
    readyForDeployment,
    issues,
    warnings,
    testResult: result.testResult,
    success: true
  };
}

/**
 * Generate human-readable test summary
 */
function generateTestSummary(testResult: FirmwareTestResult): string {
  const lines: string[] = [];

  lines.push('=== Firmware Test Summary ===');

  // Boot test
  lines.push(`\nBoot Test: ${testResult.bootTest.passed ? 'PASS ✓' : 'FAIL ✗'}`);
  if (testResult.bootTest.output) {
    lines.push(`  Output: ${testResult.bootTest.output.substring(0, 100)}...`);
  }

  // Heartbeat test
  lines.push(`\nHeartbeat Test: ${testResult.heartbeatTest.passed ? 'PASS ✓' : 'FAIL ✗'}`);
  lines.push(`  Heartbeats detected: ${testResult.heartbeatTest.count}`);

  // Memory test
  lines.push(`\nMemory Test: ${testResult.memoryTest.passed ? 'PASS ✓' : 'FAIL ✗'}`);
  lines.push(`  Memory leak: ${testResult.memoryTest.leak} bytes`);

  // Overall
  const allPassed = testResult.bootTest.passed &&
                     testResult.heartbeatTest.passed &&
                     testResult.memoryTest.passed;

  lines.push(`\nOverall: ${allPassed ? 'ALL TESTS PASSED ✓' : 'SOME TESTS FAILED ✗'}`);

  return lines.join('\n');
}
