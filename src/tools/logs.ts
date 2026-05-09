import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { fileExists } from '../utils/exec.js';
import type { LogEntry, ParsedLogReport } from '../types/index.js';

// ESP-IDF log format: E (12345) TAG: message
const LOG_LINE = /^([EWIDV])\s+\((\d+)\)\s+([^:]+):\s*(.+)$/;
// Arduino-style log prefixes
const ARDUINO_LOG = /^\[(ERROR|WARN|INFO|DEBUG|VERBOSE)\]\s*(.+)$/i;
// Guru Meditation / abort / panic
const PANIC_PATTERNS = [
  /Guru Meditation Error/i,
  /abort\(\) was called/i,
  /Backtrace:/i,
  /LoadProhibited/i,
  /StoreProhibited/i,
  /rst:0x[0-9a-f]+\s*\(PANIC\)/i,
];
// Free heap reports
const HEAP_PATTERN = /[Ff]ree\s+[Hh]eap[:\s]+(\d+)/;

const LEVEL_MAP: Record<string, LogEntry['level']> = {
  E: 'ERROR',
  W: 'WARN',
  I: 'INFO',
  D: 'DEBUG',
  V: 'VERBOSE',
  ERROR: 'ERROR',
  WARN: 'WARN',
  INFO: 'INFO',
  DEBUG: 'DEBUG',
  VERBOSE: 'VERBOSE',
};

export async function parseSerialLogs(logPath: string): Promise<ParsedLogReport> {
  const absPath = resolve(logPath);

  if (!await fileExists(absPath)) {
    return {
      success: false,
      logPath: absPath,
      totalLines: 0,
      entries: [],
      summary: { errors: 0, warnings: 0, panics: 0 },
      panics: [],
      error: `Log file not found: ${absPath}`,
    };
  }

  let raw: string;
  try {
    raw = await readFile(absPath, 'utf8');
  } catch (err: any) {
    return {
      success: false,
      logPath: absPath,
      totalLines: 0,
      entries: [],
      summary: { errors: 0, warnings: 0, panics: 0 },
      panics: [],
      error: `Cannot read log file: ${err.message}`,
    };
  }

  const lines = raw.split('\n');
  const entries: LogEntry[] = [];
  const panics: string[] = [];
  let heapMin: number | undefined;
  let heapMax: number | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (!line) continue;

    // Check for panics / crashes
    for (const pat of PANIC_PATTERNS) {
      if (pat.test(line)) {
        panics.push(line);
        break;
      }
    }

    // Track heap values
    const heapMatch = line.match(HEAP_PATTERN);
    if (heapMatch) {
      const val = parseInt(heapMatch[1]);
      if (heapMin === undefined || val < heapMin) heapMin = val;
      if (heapMax === undefined || val > heapMax) heapMax = val;
    }

    // Parse log level
    const espMatch = line.match(LOG_LINE);
    if (espMatch) {
      entries.push({
        level: LEVEL_MAP[espMatch[1]] ?? 'UNKNOWN',
        timestamp: parseInt(espMatch[2]),
        tag: espMatch[3].trim(),
        message: espMatch[4].trim(),
        lineNumber: i + 1,
      });
      continue;
    }

    const arduinoMatch = line.match(ARDUINO_LOG);
    if (arduinoMatch) {
      entries.push({
        level: LEVEL_MAP[arduinoMatch[1].toUpperCase()] ?? 'UNKNOWN',
        message: arduinoMatch[2].trim(),
        lineNumber: i + 1,
      });
      continue;
    }

    // Unclassified non-empty line
    entries.push({ level: 'UNKNOWN', message: line, lineNumber: i + 1 });
  }

  const summary = {
    errors: entries.filter(e => e.level === 'ERROR').length,
    warnings: entries.filter(e => e.level === 'WARN').length,
    panics: panics.length,
    ...(heapMin !== undefined ? { heapMin } : {}),
    ...(heapMax !== undefined ? { heapMax } : {}),
  };

  return {
    success: true,
    logPath: absPath,
    totalLines: lines.length,
    entries,
    summary,
    panics,
  };
}
