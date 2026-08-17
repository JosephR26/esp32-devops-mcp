/**
 * Host-side input handling: project path validation and USB-serial bridge
 * identification.
 *
 * Both were found broken by live use on Windows while every other test passed,
 * so these cases use realistic host strings rather than tidy synthetic ones.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateProjectPath } from '../src/utils/validation.js';
import {
  identifyUsbSerialBridge,
  looksLikeEsp32Port,
  parseSerialPorts,
} from '../src/utils/parser.js';

describe('project path validation', () => {
  it('accepts an absolute Windows path with a drive colon', () => {
    // The original validator rejected the colon outright, which made every
    // absolute Windows path invalid and broke build, flash and inventory.
    assert.equal(validateProjectPath('D:\\josep\\Documents\\GitHub\\project'), true);
    assert.equal(validateProjectPath('C:/projects/firmware'), true);
  });

  it('accepts paths containing spaces and parentheses', () => {
    assert.equal(validateProjectPath('C:\\Program Files (x86)\\thing'), true);
  });

  it('accepts an absolute POSIX path', () => {
    assert.equal(validateProjectPath('/home/user/projects/firmware'), true);
  });

  it('accepts a relative path', () => {
    assert.equal(validateProjectPath('firmware/interrogation-agent'), true);
  });

  it('rejects an empty or whitespace-only path', () => {
    assert.equal(validateProjectPath(''), false);
    assert.equal(validateProjectPath('   '), false);
  });

  it('rejects a colon outside the drive specifier', () => {
    // NTFS alternate data stream.
    assert.equal(validateProjectPath('C:\\projects\\file.txt:hidden'), false);
    assert.equal(validateProjectPath('/home/user/we:ird'), false);
  });

  it('rejects directory traversal', () => {
    assert.equal(validateProjectPath('C:\\projects\\..\\..\\Windows'), false);
    assert.equal(validateProjectPath('../../etc'), false);
    assert.equal(validateProjectPath('..'), false);
  });

  it('does not mistake a dotted name for traversal', () => {
    assert.equal(validateProjectPath('C:\\projects\\my..project'), true);
    assert.equal(validateProjectPath('/srv/..hidden/thing'), true);
  });

  it('rejects characters that are never legal in a path', () => {
    for (const bad of ['a<b', 'a>b', 'a"b', 'a|b', 'a?b', 'a*b']) {
      assert.equal(validateProjectPath(`C:\\projects\\${bad}`), false, bad);
    }
  });
});

describe('USB-serial bridge identification', () => {
  it('identifies the common ESP32 bridge chips', () => {
    assert.equal(identifyUsbSerialBridge('USB-SERIAL CH340 (COM3)'), 'WCH CH34x');
    assert.equal(identifyUsbSerialBridge('Silicon Labs CP210x USB to UART Bridge (COM5)'),
      'Silicon Labs CP210x');
    assert.equal(identifyUsbSerialBridge('USB JTAG/serial debug unit (COM7)'),
      'ESP32 native USB (JTAG/serial)');
  });

  it('does not treat a host-internal UART as an ESP32', () => {
    // The exact string Windows reports for the platform UARTs on an ARM64
    // laptop. The previous heuristic matched a bare "uart" substring and
    // claimed these were ESP32s.
    assert.equal(identifyUsbSerialBridge('Qualcomm(R) UART Bus Device (COM1)'), null);
    assert.equal(looksLikeEsp32Port('Qualcomm(R) UART Bus Device (COM1)'), false);
  });

  it('does not identify a bridge in an empty description', () => {
    assert.equal(identifyUsbSerialBridge(''), null);
  });

  it('marks only real bridges when parsing a mixed port list', () => {
    const output = [
      '1. COM1 - Qualcomm(R) UART Bus Device (COM1)',
      '2. COM2 - Qualcomm(R) UART Bus Device (COM2)',
      '3. COM3 - USB-SERIAL CH340 (COM3)',
    ].join('\n');

    const { ports } = parseSerialPorts(output);

    assert.equal(ports.length, 3);
    assert.deepEqual(
      ports.map((p: any) => [p.port, p.isESP32]),
      [['COM1', false], ['COM2', false], ['COM3', true]]
    );
    assert.equal(ports[2].bridge, 'WCH CH34x');
    assert.equal(ports[0].bridge, undefined);
  });
});
