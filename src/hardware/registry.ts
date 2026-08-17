/**
 * Component profile registry.
 *
 * Profiles are data, not code paths. Nothing in the interrogation engine knows
 * about any specific part — adding support for a new component means adding a
 * profile object, never editing a tool handler.
 */

import { validateByteArray } from '../utils/validation.js';
import type {
  ComponentMatchHint,
  ComponentProfile,
  HardwareInterfaceKind,
  ProbeOperation,
  SafeProbe,
} from '../types/hardware.js';
import { BUILT_IN_PROFILES } from './profiles/index.js';

const registry = new Map<string, ComponentProfile>();

function register(profile: ComponentProfile): void {
  registry.set(profile.id.toLowerCase(), profile);
}

for (const profile of BUILT_IN_PROFILES) {
  register(profile);
}

/** Register (or replace) a component profile at runtime. */
export function registerProfile(profile: ComponentProfile): void {
  validateProfile(profile);
  register(profile);
}

/** Remove a profile. Primarily used by tests. */
export function unregisterProfile(id: string): boolean {
  return registry.delete(id.toLowerCase());
}

/** All registered profiles. */
export function listProfiles(): ComponentProfile[] {
  return Array.from(registry.values());
}

/**
 * Look up a profile by id, part number or alias, case-insensitively.
 * Returns null rather than a best guess when nothing matches.
 */
export function findProfile(identifier: string): ComponentProfile | null {
  if (!identifier) return null;
  const needle = identifier.trim().toLowerCase();

  const direct = registry.get(needle);
  if (direct) return direct;

  for (const profile of registry.values()) {
    if (profile.partNumber.toLowerCase() === needle) return profile;
    if (profile.aliases.some((alias) => alias.toLowerCase() === needle)) return profile;
  }

  // Loose match only as a last resort, and only on a distinctive substring.
  if (needle.length >= 4) {
    for (const profile of registry.values()) {
      const haystack = [profile.id, profile.partNumber, ...profile.aliases]
        .join(' ')
        .toLowerCase();
      if (haystack.includes(needle)) return profile;
    }
  }

  return null;
}

/** Profiles that declare support for a given interface. */
export function profilesForInterface(kind: HardwareInterfaceKind): ComponentProfile[] {
  return listProfiles().filter((profile) =>
    profile.interfaces.some((iface) => iface.kind === kind)
  );
}

/**
 * Profiles whose declared I2C addresses include `address`.
 *
 * The returned hints are explicitly marked `addressOnly` — an I2C address is a
 * 7-bit number shared by many unrelated parts and is never an identification on
 * its own.
 */
export function hintsForI2CAddress(address: number): ComponentMatchHint[] {
  const hints: ComponentMatchHint[] = [];
  for (const profile of listProfiles()) {
    for (const iface of profile.interfaces) {
      if (iface.kind !== 'I2C' || !iface.addresses) continue;
      if (!iface.addresses.includes(address)) continue;
      hints.push({
        componentId: profile.id,
        partNumber: profile.partNumber,
        reason: `Profile declares I2C address 0x${address
          .toString(16)
          .toUpperCase()
          .padStart(2, '0')}`,
        confidence: 'LOW',
        addressOnly: true,
      });
      break;
    }
  }
  return hints;
}

/** Locate a safe probe by id within a profile. */
export function findProbe(profile: ComponentProfile, probeId: string): SafeProbe | null {
  return profile.safeProbes.find((probe) => probe.id === probeId) ?? null;
}

/**
 * Structural validation for externally supplied profiles.
 * Throws with a specific message so a malformed profile fails loudly at
 * registration rather than silently misbehaving during an interrogation.
 */
export function validateProfile(profile: ComponentProfile): void {
  if (!profile.id || !/^[a-z0-9][a-z0-9._-]*$/i.test(profile.id)) {
    throw new Error('Profile id must be a non-empty alphanumeric identifier');
  }
  if (!profile.partNumber) {
    throw new Error(`Profile ${profile.id}: partNumber is required`);
  }
  if (!Array.isArray(profile.interfaces) || profile.interfaces.length === 0) {
    throw new Error(`Profile ${profile.id}: at least one interface must be declared`);
  }

  const probeIds = new Set<string>();
  for (const probe of profile.safeProbes) {
    if (probeIds.has(probe.id)) {
      throw new Error(`Profile ${profile.id}: duplicate probe id "${probe.id}"`);
    }
    probeIds.add(probe.id);

    // A probe that emits bytes must say why. This is the safety contract that
    // keeps "read first" from quietly becoming "write whenever convenient".
    if (probe.writes && !probe.writeJustification) {
      throw new Error(
        `Profile ${profile.id}: probe "${probe.id}" writes to the bus but supplies no writeJustification`
      );
    }
    const emitsBytes = probe.operations.some(
      (op) => op.op === 'I2C_WRITE_READ' || op.op === 'SPI_TRANSFER' || op.op === 'UART_WRITE_READ'
    );
    if (emitsBytes && !probe.writes) {
      throw new Error(
        `Profile ${profile.id}: probe "${probe.id}" emits bytes but is not marked writes: true`
      );
    }

    // Reject out-of-range bytes here rather than letting the agent silently mask
    // them to 8 bits — a truncated command frame is a different command.
    for (const operation of probe.operations) {
      const payload = emittedBytes(operation);
      if (payload !== null && !validateByteArray(payload)) {
        throw new Error(
          `Profile ${profile.id}: probe "${probe.id}" operation ${operation.op} has an invalid ` +
            'byte payload (must be 1-512 integers in 0..255)'
        );
      }
    }
  }

  for (const rule of profile.identification) {
    // A pattern of nothing but wildcards matches any response of that length,
    // so it contributes score without contributing evidence.
    if (rule.match.kind === 'PROBE_RESPONSE' || rule.match.kind === 'REGISTER_VALUE') {
      const tokens = rule.match.pattern.trim().split(/[\s,]+/).filter(Boolean);
      if (tokens.length > 0 && tokens.every((t) => ['??', '*', 'xx', 'XX'].includes(t))) {
        throw new Error(
          `Profile ${profile.id}: identification rule "${rule.id}" is entirely wildcards, so it ` +
            'matches any response of that length. Remove it, or match a real signature.'
        );
      }
    }
    if (rule.weight <= 0 || rule.weight > 1) {
      throw new Error(
        `Profile ${profile.id}: identification rule "${rule.id}" weight must be in (0, 1]`
      );
    }
    if (
      (rule.match.kind === 'PROBE_RESPONSE' || rule.match.kind === 'REGISTER_VALUE') &&
      rule.match.kind === 'PROBE_RESPONSE' &&
      !probeIds.has(rule.match.probeId)
    ) {
      throw new Error(
        `Profile ${profile.id}: identification rule "${rule.id}" references unknown probe "${rule.match.probeId}"`
      );
    }
  }

  for (const test of profile.functionalTests) {
    for (const probeId of test.probes) {
      if (!probeIds.has(probeId)) {
        throw new Error(
          `Profile ${profile.id}: functional test "${test.id}" references unknown probe "${probeId}"`
        );
      }
    }
  }

  for (const benchmark of profile.benchmarks) {
    if (!probeIds.has(benchmark.probeId)) {
      throw new Error(
        `Profile ${profile.id}: benchmark "${benchmark.id}" references unknown probe "${benchmark.probeId}"`
      );
    }
  }
}

/** The byte payload an operation puts on the bus, or null when it emits none. */
function emittedBytes(operation: ProbeOperation): number[] | null {
  switch (operation.op) {
    case 'I2C_WRITE_READ':
    case 'UART_WRITE_READ':
      return operation.write;
    case 'SPI_TRANSFER':
      return operation.tx;
    default:
      return null;
  }
}

/** Validate every built-in profile. Used by the test suite as a regression guard. */
export function validateAllProfiles(): void {
  for (const profile of listProfiles()) {
    validateProfile(profile);
  }
}
