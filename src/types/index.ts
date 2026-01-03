/**
 * Type definitions for ESP32 DevOps MCP Server
 */

export interface SerialPort {
  port: string;
  description: string;
  hwid?: string;
  isESP32?: boolean;
}

export interface SerialPortFavorite {
  port: string;
  name: string;
  added: string;
}

export interface BuildResult {
  success: boolean;
  output: string;
  firmwareSize?: number;
  memoryUsage?: {
    ram: number;
    flash: number;
  };
  errors?: string[];
  warnings?: string[];
}

export interface FlashResult {
  success: boolean;
  output: string;
  uploadTime?: number;
  port?: string;
}

export interface PerformanceBenchmark {
  memoryAnalysis: {
    initial: number;
    final: number;
    leak: number;
    status: 'PASS' | 'FAIL' | 'WARNING';
  };
  loopPerformance: {
    avg: number;
    min: number;
    max: number;
    status: 'PASS' | 'FAIL' | 'WARNING';
  };
  wifiSignal?: {
    avg: number;
    status: 'PASS' | 'FAIL' | 'WARNING';
  };
}

export interface FirmwareTestResult {
  bootTest: {
    passed: boolean;
    output: string;
  };
  heartbeatTest: {
    passed: boolean;
    count: number;
  };
  memoryTest: {
    passed: boolean;
    leak: number;
  };
}

export interface ExecOptions {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
}
