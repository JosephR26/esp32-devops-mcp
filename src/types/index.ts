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

export interface ProjectCreationResult {
  success: boolean;
  projectPath: string;
  board: string;
  template: string;
  error?: string;
  exitCode?: number;
}

export interface ValidationIssue {
  severity: 'error' | 'warning';
  message: string;
}

export interface ValidationResult {
  success: boolean;
  valid: boolean;
  projectPath: string;
  issues: ValidationIssue[];
  config?: {
    environments: string[];
    boards: string[];
    framework: string;
  };
  error?: string;
}

export interface LibraryInfo {
  id?: number;
  name: string;
  description?: string;
  version?: string;
  author?: string;
  keywords?: string[];
}

export interface TestCase {
  name: string;
  status: 'PASSED' | 'FAILED' | 'IGNORED';
  duration?: number;
  message?: string;
}

export interface TestSuiteResult {
  environment: string;
  passed: number;
  failed: number;
  ignored: number;
  duration: number;
  tests: TestCase[];
}

export interface TestRunResult {
  success: boolean;
  output: string;
  suites: TestSuiteResult[];
  totalPassed: number;
  totalFailed: number;
  error?: string;
  exitCode?: number;
}

export interface LogEntry {
  level: 'ERROR' | 'WARN' | 'INFO' | 'DEBUG' | 'VERBOSE' | 'UNKNOWN';
  timestamp?: number;
  tag?: string;
  message: string;
  lineNumber: number;
}

export interface ParsedLogReport {
  success: boolean;
  logPath: string;
  totalLines: number;
  entries: LogEntry[];
  summary: {
    errors: number;
    warnings: number;
    panics: number;
    heapMin?: number;
    heapMax?: number;
  };
  panics: string[];
  error?: string;
}

export interface OTAImageResult {
  success: boolean;
  imagePath?: string;
  firmwareSize?: number;
  md5?: string;
  sha256?: string;
  environment?: string;
  readyForDeploy: boolean;
  error?: string;
}

export interface NetworkDevice {
  hostname: string;
  ip?: string;
  port?: number;
  service?: string;
}

export interface NetworkScanResult {
  success: boolean;
  devices: NetworkDevice[];
  method: string;
  note?: string;
  error?: string;
}
