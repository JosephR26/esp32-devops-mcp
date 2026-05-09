import { createHash } from 'crypto';
import { readFile, stat, copyFile, mkdir, readdir } from 'fs/promises';
import { join, resolve } from 'path';
import { fileExists, executeCommand } from '../utils/exec.js';
import { validateProjectPath, validateEnvironment, sanitizePath } from '../utils/validation.js';
import type { OTAImageResult, NetworkScanResult, NetworkDevice } from '../types/index.js';

export async function generateOTAImage(
  projectPath?: string,
  environment?: string,
  outputPath?: string
): Promise<OTAImageResult> {
  if (projectPath && !validateProjectPath(projectPath)) {
    return { success: false, readyForDeploy: false, error: 'Invalid project path' };
  }
  if (environment && !validateEnvironment(environment)) {
    return { success: false, readyForDeploy: false, error: 'Invalid environment name' };
  }

  const dir = projectPath ? resolve(projectPath) : process.cwd();
  const buildDir = join(dir, '.pio', 'build');

  let firmwarePath: string | null = null;
  let detectedEnv = environment;

  if (environment) {
    const candidate = join(buildDir, environment, 'firmware.bin');
    if (await fileExists(candidate)) {
      firmwarePath = candidate;
    }
  } else {
    try {
      const envDirs = await readdir(buildDir);
      for (const envDir of envDirs) {
        const candidate = join(buildDir, envDir, 'firmware.bin');
        if (await fileExists(candidate)) {
          firmwarePath = candidate;
          detectedEnv = envDir;
          break;
        }
      }
    } catch {
      // .pio/build does not exist yet
    }
  }

  if (!firmwarePath) {
    return {
      success: false,
      readyForDeploy: false,
      environment: detectedEnv,
      error: 'firmware.bin not found in .pio/build/. Run esp32_build first.',
    };
  }

  const [fileData, fileStat] = await Promise.all([
    readFile(firmwarePath),
    stat(firmwarePath),
  ]);

  const md5    = createHash('md5').update(fileData).digest('hex');
  const sha256 = createHash('sha256').update(fileData).digest('hex');

  let finalPath = firmwarePath;
  if (outputPath) {
    const outDir = resolve(outputPath);
    await mkdir(outDir, { recursive: true });
    finalPath = join(outDir, `firmware_${detectedEnv}_${Date.now()}.bin`);
    await copyFile(firmwarePath, finalPath);
  }

  return {
    success: true,
    imagePath: finalPath,
    firmwareSize: fileStat.size,
    md5,
    sha256,
    environment: detectedEnv,
    readyForDeploy: true,
  };
}

export async function listNetworkDevices(timeoutMs: number = 5000): Promise<NetworkScanResult> {
  const platform = process.platform;

  if (platform === 'linux') {
    return scanLinux(timeoutMs);
  } else if (platform === 'darwin') {
    return scanMacOS(timeoutMs);
  } else {
    return scanARP('arp', timeoutMs);
  }
}

async function scanLinux(timeoutMs: number): Promise<NetworkScanResult> {
  const result = await executeCommand(
    `avahi-browse -t -p -r _arduino._tcp 2>/dev/null; avahi-browse -t -p -r _http._tcp 2>/dev/null`,
    { timeout: timeoutMs + 2000 }
  );
  if (result.stdout.trim()) {
    return { success: true, devices: parseAvahi(result.stdout), method: 'avahi-browse' };
  }
  // avahi not available — fall back to Linux ARP format
  return scanARP('arp -n', timeoutMs);
}

async function scanMacOS(timeoutMs: number): Promise<NetworkScanResult> {
  const result = await executeCommand(
    `dns-sd -B _arduino._tcp local`,
    { timeout: timeoutMs }
  );
  if (result.stdout.trim()) {
    return { success: true, devices: parseDNSSD(result.stdout), method: 'dns-sd' };
  }
  return scanARP('arp -a', timeoutMs);
}

async function scanARP(cmd: string, timeoutMs: number): Promise<NetworkScanResult> {
  const result = await executeCommand(cmd, { timeout: timeoutMs });
  return {
    success: result.success,
    devices: parseARP(result.stdout),
    method: 'arp-table',
    note: 'ARP fallback: all LAN hosts shown — ESP32s are not distinguished. Use avahi/dns-sd for mDNS-aware discovery.',
  };
}

function parseAvahi(output: string): NetworkDevice[] {
  const devices: NetworkDevice[] = [];
  for (const line of output.split('\n')) {
    if (!line.startsWith('=')) continue;
    const parts = line.split(';');
    if (parts.length >= 9) {
      devices.push({
        hostname: parts[6]?.replace(/\.$/, '') ?? '',
        ip:       parts[7],
        port:     parseInt(parts[8]) || undefined,
        service:  parts[4],
      });
    }
  }
  return devices;
}

function parseDNSSD(output: string): NetworkDevice[] {
  const devices: NetworkDevice[] = [];
  for (const line of output.split('\n')) {
    const match = line.match(/\d+\s+\d+\s+\S+\s+(\S+)\s+(.+)/);
    if (match) {
      devices.push({ hostname: match[2].trim(), service: match[1] });
    }
  }
  return devices;
}

function parseARP(output: string): NetworkDevice[] {
  const devices: NetworkDevice[] = [];
  const IP = /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/;
  for (const line of output.split('\n')) {
    // macOS / Windows: "? (192.168.1.x) at xx:xx:xx:xx:xx:xx ..."
    const parenMatch = line.match(new RegExp(`\\((${IP.source})\\)`));
    if (parenMatch) {
      devices.push({ hostname: parenMatch[1], ip: parenMatch[1] });
      continue;
    }
    // Linux arp -n: "192.168.1.x    ether   xx:xx:xx:xx:xx:xx  ..."
    const linuxMatch = line.match(new RegExp(`^(${IP.source})\\s`));
    if (linuxMatch) {
      devices.push({ hostname: linuxMatch[1], ip: linuxMatch[1] });
    }
  }
  return devices;
}
