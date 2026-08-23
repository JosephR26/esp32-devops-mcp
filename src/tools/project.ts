import { executeCommand, fileExists } from '../utils/exec.js';
import { validateProjectPath, validateEnvironment, sanitizePath } from '../utils/validation.js';
import { readFile, readdir, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import type {
  ProjectCreationResult,
  ValidationResult,
  LibraryInfo,
  TestRunResult,
  TestSuiteResult,
  TestCase,
} from '../types/index.js';

const TEMPLATES: Record<string, string> = {
  bare: `#include <Arduino.h>

void setup() {
  Serial.begin(115200);
}

void loop() {
}
`,
  wifi: `#include <Arduino.h>
#include <WiFi.h>

const char* SSID     = "your_ssid";
const char* PASSWORD = "your_password";

void setup() {
  Serial.begin(115200);
  WiFi.begin(SSID, PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\\nConnected: " + WiFi.localIP().toString());
}

void loop() {
  delay(1000);
}
`,
  ble: `#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

void setup() {
  Serial.begin(115200);
  BLEDevice::init("ESP32-BLE");
  BLEServer* server = BLEDevice::createServer();
  BLEDevice::startAdvertising();
  Serial.println("BLE advertising started");
}

void loop() {
  delay(1000);
}
`,
  mqtt: `#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>

const char* SSID        = "your_ssid";
const char* PASSWORD    = "your_password";
const char* MQTT_BROKER = "broker.example.com";

WiFiClient   wifiClient;
PubSubClient mqtt(wifiClient);

void callback(char* topic, byte* payload, unsigned int length) {
  Serial.printf("Message [%s]: %.*s\\n", topic, length, payload);
}

void setup() {
  Serial.begin(115200);
  WiFi.begin(SSID, PASSWORD);
  while (WiFi.status() != WL_CONNECTED) delay(500);
  mqtt.setServer(MQTT_BROKER, 1883);
  mqtt.setCallback(callback);
}

void loop() {
  if (!mqtt.connected()) {
    mqtt.connect("ESP32Client");
  }
  mqtt.loop();
  delay(100);
}
`,
};

/**
 * An INI value with any trailing comment removed.
 *
 * PlatformIO accepts both `;` and `#` as comment introducers, so `board = esp32dev ; note`
 * carries the note into the value unless it is stripped. Named rather than inlined because
 * every value read out of platformio.ini needs it, and the board was simply the one where
 * the omission was noticed first.
 */
const iniValue = (raw: string): string => raw.split(/[;#]/)[0].trim();

export async function createProject(
  name: string,
  projectPath?: string,
  board: string = 'esp32dev',
  template: string = 'bare'
): Promise<ProjectCreationResult> {
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    return {
      success: false,
      projectPath: '',
      board,
      template,
      error: 'Invalid project name: use only letters, numbers, underscores, and hyphens',
    };
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(board)) {
    return { success: false, projectPath: '', board, template, error: 'Invalid board identifier' };
  }

  const baseDir = projectPath ? resolve(projectPath) : process.cwd();
  const dir = join(baseDir, name);

  const result = await executeCommand(
    `pio project init --project-dir "${dir}" --board ${board}`,
    { timeout: 60000 }
  );

  if (!result.success) {
    return {
      success: false,
      projectPath: dir,
      board,
      template,
      error: result.stderr || 'pio project init failed',
      exitCode: result.exitCode,
    };
  }

  const starter = TEMPLATES[template] ?? TEMPLATES.bare;
  try {
    await writeFile(join(dir, 'src', 'main.cpp'), starter, 'utf8');
  } catch {
    // Non-fatal — project scaffolded but template write failed
  }

  return { success: true, projectPath: dir, board, template };
}

export async function validateProject(projectPath?: string): Promise<ValidationResult> {
  const dir = projectPath ? resolve(projectPath) : process.cwd();

  if (projectPath && !validateProjectPath(projectPath)) {
    return {
      success: false,
      valid: false,
      projectPath: dir,
      issues: [{ severity: 'error', message: 'Invalid project path' }],
    };
  }

  const issues: { severity: 'error' | 'warning'; message: string }[] = [];

  const iniPath = join(dir, 'platformio.ini');
  if (!await fileExists(iniPath)) {
    return {
      success: true,
      valid: false,
      projectPath: dir,
      issues: [{ severity: 'error', message: 'platformio.ini not found — not a PlatformIO project' }],
    };
  }

  let iniContent = '';
  try {
    iniContent = await readFile(iniPath, 'utf8');
  } catch {
    return {
      success: true,
      valid: false,
      projectPath: dir,
      issues: [{ severity: 'error', message: 'Cannot read platformio.ini' }],
    };
  }

  const envMatches = [...iniContent.matchAll(/^\[env:([^\]]+)\]/gm)].map(m => m[1]);

  // Every `board =`, not just the first.
  //
  // A multi-environment project declares one board per environment, and matching only
  // the first reported "3 environments, 1 board" — which reads as a misconfigured
  // project rather than a parser that stopped early. Deduplicated because environments
  // legitimately share a board, and `iniValue` strips comments so `board = esp32dev ; note`
  // does not become part of the name.
  const boards = [
    ...new Set(
      [...iniContent.matchAll(/^\s*board\s*=\s*(.+)$/gm)]
        .map(m => iniValue(m[1]))
        .filter(Boolean)
    ),
  ];

  const frameworkMatch = iniContent.match(/^\s*framework\s*=\s*(.+)$/m);

  if (envMatches.length === 0) {
    issues.push({ severity: 'warning', message: 'No [env:*] sections found in platformio.ini' });
  }
  if (boards.length === 0) {
    issues.push({ severity: 'warning', message: 'No board configured in platformio.ini' });
  }
  if (!frameworkMatch) {
    issues.push({ severity: 'warning', message: 'No framework configured in platformio.ini' });
  }

  let srcEntries: string[] = [];
  try {
    srcEntries = await readdir(join(dir, 'src'));
  } catch {
    issues.push({ severity: 'error', message: 'src/ directory not found' });
  }

  if (srcEntries.length > 0 && !srcEntries.some(f => /\.(cpp|c|ino)$/.test(f))) {
    issues.push({ severity: 'warning', message: 'No source files (.cpp/.c/.ino) found in src/' });
  }

  return {
    success: true,
    valid: issues.filter(i => i.severity === 'error').length === 0,
    projectPath: dir,
    issues,
    config: {
      environments: envMatches,
      boards,
      framework: frameworkMatch ? iniValue(frameworkMatch[1]) : '',
    },
  };
}

export async function listLibraries(
  query?: string,
  installed: boolean = false
): Promise<{ success: boolean; libraries: LibraryInfo[]; count: number; error?: string; exitCode?: number }> {
  const safeQuery = query ? query.replace(/['"\\]/g, '') : '';
  const cmd = installed
    ? 'pio lib list --json-output'
    : safeQuery
      ? `pio lib search "${safeQuery}" --json-output`
      : 'pio lib list --json-output';

  const result = await executeCommand(cmd, { timeout: 30000 });

  if (!result.success) {
    return {
      success: false,
      libraries: [],
      count: 0,
      error: result.stderr || 'pio lib command failed',
      exitCode: result.exitCode,
    };
  }

  try {
    const data = JSON.parse(result.stdout);
    const raw: any[] = Array.isArray(data) ? data : (data.items ?? []);
    const libraries: LibraryInfo[] = raw.map(lib => ({
      id: lib.id,
      name: lib.name,
      description: lib.description,
      version: lib.version?.name ?? lib.version,
      author: Array.isArray(lib.authors)
        ? lib.authors.map((a: any) => a.name ?? a).join(', ')
        : lib.authors,
      keywords: lib.keywords,
    }));
    return { success: true, libraries, count: libraries.length };
  } catch {
    return {
      success: false,
      libraries: [],
      count: 0,
      error: 'Failed to parse pio lib output as JSON',
    };
  }
}

export async function runPlatformIOTests(
  projectPath?: string,
  environment?: string,
  filter?: string
): Promise<TestRunResult> {
  if (projectPath && !validateProjectPath(projectPath)) {
    return { success: false, output: '', suites: [], totalPassed: 0, totalFailed: 0, error: 'Invalid project path' };
  }
  if (environment && !validateEnvironment(environment)) {
    return { success: false, output: '', suites: [], totalPassed: 0, totalFailed: 0, error: 'Invalid environment name' };
  }
  if (filter && !/^[-a-zA-Z0-9_*\/]+$/.test(filter)) {
    return { success: false, output: '', suites: [], totalPassed: 0, totalFailed: 0, error: 'Invalid filter pattern' };
  }

  const parts = ['pio test'];
  if (projectPath) parts.push(`--project-dir "${sanitizePath(projectPath)}"`);
  if (environment) parts.push(`-e ${environment}`);
  if (filter) parts.push(`-f ${filter}`);

  const result = await executeCommand(parts.join(' '), {
    cwd: projectPath ? resolve(projectPath) : process.cwd(),
    timeout: 300000,
  });

  const suites = parseTestOutput(result.stdout + result.stderr);
  const totalPassed = suites.reduce((s, t) => s + t.passed, 0);
  const totalFailed = suites.reduce((s, t) => s + t.failed, 0);

  return {
    success: result.success && totalFailed === 0,
    output: result.stdout + (result.stderr ? '\n' + result.stderr : ''),
    suites,
    totalPassed,
    totalFailed,
    exitCode: result.exitCode,
    ...(result.success ? {} : { error: result.stderr }),
  };
}

function parseTestOutput(output: string): TestSuiteResult[] {
  const suites: TestSuiteResult[] = [];
  let current: TestSuiteResult | null = null;

  for (const line of output.split('\n')) {
    // New environment block
    const envMatch = line.match(/(?:ENVIRONMENT|Running tests? in environment[:\s]+)[`']?([a-zA-Z0-9_-]+)[`']?/i);
    if (envMatch) {
      if (current) suites.push(current);
      current = { environment: envMatch[1], passed: 0, failed: 0, ignored: 0, duration: 0, tests: [] };
      continue;
    }

    if (!current) {
      current = { environment: 'default', passed: 0, failed: 0, ignored: 0, duration: 0, tests: [] };
    }

    // Unity test result line: path:line:name:STATUS[:message]
    const unityMatch = line.match(/^[^:]+:\d+:([^:]+):(PASS|FAIL|IGNORE)(?::(.+))?$/);
    if (unityMatch) {
      const status: TestCase['status'] =
        unityMatch[2] === 'PASS' ? 'PASSED' : unityMatch[2] === 'FAIL' ? 'FAILED' : 'IGNORED';
      current.tests.push({ name: unityMatch[1].trim(), status, message: unityMatch[3] });
      if (status === 'PASSED') current.passed++;
      else if (status === 'FAILED') current.failed++;
      else current.ignored++;
      continue;
    }

    // Summary: "X Tests Y Failures Z Ignored"
    const summaryMatch = line.match(/(\d+) Tests\s+(\d+) Failures\s+(\d+) Ignored/i);
    if (summaryMatch) {
      current.passed = parseInt(summaryMatch[1]) - parseInt(summaryMatch[2]) - parseInt(summaryMatch[3]);
      current.failed = parseInt(summaryMatch[2]);
      current.ignored = parseInt(summaryMatch[3]);
      continue;
    }

    // Duration
    const durationMatch = line.match(/Elapsed [Tt]ime:\s*([\d.]+)\s*s/);
    if (durationMatch) current.duration = parseFloat(durationMatch[1]);
  }

  if (current) suites.push(current);
  return suites;
}
